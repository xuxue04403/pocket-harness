import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'local_commands.dart';
import 'local_host.dart';

/// 一步一步把 dsh 装进手机：下载 rootfs、解压、装 node、装 dsh。
///
/// 之所以做成「一步一步、每步可重入」，是因为整条链要下 1.6 GB、跑十来分钟。
/// 任何一步失败后重来，都不该重新下一遍已经有的东西。
enum ProvisionStep {
  download('下载 Alpine 基础系统'),
  extract('解压到应用目录'),
  configure('配置 DNS 与软件源'),
  node('安装 Node.js 24'),
  dsh('安装 DeepSeek Harness'),
  done('准备完成');

  const ProvisionStep(this.label);

  final String label;
}

class ProvisionProgress {
  const ProvisionProgress({
    required this.step,
    this.detail = '',
    this.fraction,
    this.failed = false,
  });

  final ProvisionStep step;
  final String detail;

  /// 只有下载这一步有确定的总量，其余步骤给 null（界面显示不确定进度条）。
  final double? fraction;
  final bool failed;
}

/// 装好之后用来启动的入口。端口固定，避免每次换个地址让用户重新记。
class LocalRunner {
  LocalRunner({LocalHost? host, this.port = kDefaultPort})
    : host = host ?? LocalHost();

  final LocalHost host;
  final String port;

  /// How long a single native command may run before it is treated as hung.
  ///
  /// The whole install downloads ~1.6 GB and installs Node plus DSH, so a slow
  /// network can legitimately take many minutes; this is only a backstop for a
  /// native side that never sends its exit line at all.
  static const Duration _exitTimeout = Duration(minutes: 30);

  LocalLayout? _layout;

  /// 已经跑起来的 dsh 的 token 地址。为 null 表示没跑。
  String? url;

  Future<LocalLayout> layout() async {
    final LocalLayout? cached = _layout;
    if (cached != null) {
      return cached;
    }
    final LocalPaths paths = await host.paths();
    final LocalLayout next = LocalLayout(
      abi: paths.abi,
      nativeLibraryDir: paths.nativeLibraryDir,
      filesDir: paths.filesDir,
    );
    _layout = next;
    return next;
  }

  /// rootfs 里已经有 node 与 dsh 了吗。装过就跳过，重装才会白等十分钟。
  Future<bool> isProvisioned() async {
    final String output = await probe();
    // `node --version` 打 `v24.22.3`，`dsh --version` 打 `0.2.2-rc.5`。
    // 两个都要在 —— 只认一个的话，「node 装好了但 dsh 没装上」会被当成装好了。
    return output.contains('v2') && output.contains(kDshVersion);
  }

  /// 探活的原始输出。
  ///
  /// 单独留一个方法出来，是因为「装了却显示没装」这种状态最容易卡住人：
  /// 把 proot 那一行到底吐了什么显示出来，比一个布尔值有用得多。
  Future<String> probe() async {
    final LocalLayout layout = await this.layout();
    return _runCapture(
      tag: 'probe',
      argv: inRootfs(layout, 'node --version && dsh --version'),
      allowFailure: true,
    );
  }

  /// 完整的安装流程。`onProgress` 会被频繁调用，界面要能承受高频 setState。
  Future<void> provision({void Function(ProvisionProgress)? onProgress}) async {
    final LocalLayout layout = await this.layout();
    void report(
      ProvisionStep step, {
      String detail = '',
      double? fraction,
      bool failed = false,
    }) {
      onProgress?.call(
        ProvisionProgress(
          step: step,
          detail: detail,
          fraction: fraction,
          failed: failed,
        ),
      );
    }

    // 0. 空间。装完 2.0 GB，门槛 2.6 GB。放在最前面，否则装到一半才 ENOSPC，
    //    而那时的报错藏在 apk 的上百行输出里，看不出是磁盘问题。
    //    只在下装得下才算账：rootfs 已在盘上时这 2 GB 是既有安排，不该
    //    因为「剩余不足 2.6 GB」而拒绝一次只是补装 node/dsh 的修复。
    report(ProvisionStep.download, detail: '检查可用空间');
    final bool haveRootfs = await Directory(layout.rootfsPath).exists();
    final int? free = await _freeBytes(layout);
    if (free != null && !haveRootfs) {
      final String? shortfall = describeSpaceShortfall(
        free,
        LocalLayout.requiredFreeBytes,
      );
      if (shortfall != null) {
        throw LocalDshError(shortfall);
      }
    }

    // 1. 下载。已经有完整文件就跳过；只有半截就续传 —— 1.6 GB 断一次重来
    //    对手机是灾难。
    final File archive = File(layout.archivePath);
    final int have = await archive.exists() ? await archive.length() : 0;
    if (have < 1000 * 1000) {
      await _download(
        layout,
        archive,
        onProgress: (int got, int total) {
          report(
            ProvisionStep.download,
            detail: '${_mb(got)} / ${_mb(total)}',
            fraction: total > 0 ? got / total : null,
          );
        },
        // 每次尝试都写进界面：卡住的时候，屏幕上那一行就是唯一的线索。
        // 曾经这里只说「连接镜像」，结果连不上时界面和真在下载一模一样。
        onDetail: (String detail) {
          report(ProvisionStep.download, detail: detail);
        },
      );
    }

    // 2. 解压。用系统自带的 toybox tar，不自己在 Dart 里解 ——
    //    Alpine 的 rootfs 里全是符号链接（`/bin/sh -> /bin/busybox`），
    //    Dart 的 archive 包解符号链接的行为在不同版本之间变过。
    //    解到 `<rootfs>.new` 再整体换上去：直接往已有的 rootfs 上重解，
    //    tar 会顺着旧的绝对符号链接去写安卓自己的 /bin，报一整屏
    //    `not under '.../dsh-root'`。
    report(ProvisionStep.extract, detail: '解开 ${_mb(await archive.length())}');
    await _runToEnd(
      tag: 'extract',
      argv: <String>['/system/bin/sh', '-c', extractScript(layout)],
      cwd: layout.filesDir,
    );

    // 3. DNS + 软件源。Android 没有 `/etc/resolv.conf`，不写它 `apk update`
    //    只会报 `temporary error (try again later)`。
    report(ProvisionStep.configure, detail: '写入 DNS');
    await Directory('${layout.rootfsPath}/etc').create(recursive: true);
    await File(layout.resolvedConfPath).writeAsString(resolvConfBody());
    await _runToEnd(
      tag: 'configure',
      argv: inRootfs(layout, updatePackagesScript()),
      onLine: (String line) {
        report(ProvisionStep.configure, detail: line.trim());
      },
    );

    // 4. node。这一步最慢，也最容易因为 openssl 版本对不上而看起来「装好了但跑不动」。
    report(ProvisionStep.node, detail: '从 edge 源安装');
    await _runToEnd(
      tag: 'node',
      argv: inRootfs(layout, installNodeScript()),
      onLine: (String line) {
        report(ProvisionStep.node, detail: line.trim());
      },
    );

    // 5. dsh。673 个包、1.6 GB。
    report(ProvisionStep.dsh, detail: '下载 673 个包（约 1.6 GB）');
    await _runToEnd(
      tag: 'dsh',
      argv: inRootfs(layout, installDshScript()),
      onLine: (String line) {
        report(ProvisionStep.dsh, detail: line.trim());
      },
    );

    report(ProvisionStep.done, detail: 'dsh $kDshVersion 已就位');
  }

  /// 启动 `dsh web`。返回它打印出来的带 token 的地址。
  ///
  /// **不看管道，读日志文件**。`dsh web` 把地址打到 stdout，但在应用里那条管道
  /// 90 秒一行都读不到（同一份命令手工跑、用 `> /root/dsh.log` 时 30 秒内就写好了），
  /// 所以 `startDshScript()` 已经把输出重定向进 `kDshLog`，这里每 500 ms 读一次。
  ///
  /// 超时 90 秒：实测冷启动 8 秒，加上 proot 首次建立映射，给足余量。
  Future<String> start({Duration timeout = const Duration(seconds: 90)}) async {
    final LocalLayout layout = await this.layout();
    final String logPath = '${layout.rootfsPath}$kDshLog';
    // 上一轮可能留下了一个还占着端口的 dsh（应用被系统杀掉时 proot 的子进程会变成
    // 孤儿）。先清干净再起，否则新进程只会拿到 EADDRINUSE 然后一路超时。
    await _killDsh(layout);
    await host.start(
      tag: 'dsh',
      argv: inRootfs(layout, startDshScript(port: port)),
      cwd: layout.rootfsPath,
    );
    final DateTime deadline = DateTime.now().add(timeout);
    String transcript = '';
    while (DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 500));
      final String text = await _readLog(logPath);
      if (text.isNotEmpty) {
        transcript = text;
        final String? found = tokenUrlOf(text);
        if (found != null) {
          url = found;
          return found;
        }
      }
    }
    await _killDsh(layout);
    final String tail = transcript.trim();
    throw LocalDshError(
      'dsh 在 ${timeout.inSeconds} 秒内没有写出带 token 的地址。'
      '${tail.isEmpty ? '' : '\n${_tail(tail)}'}',
    );
  }

  /// 日志可能不存在（还没写）、也可能很大（node 报错栈）。只读尾部 8 KB。
  ///
  /// 这是宿主路径不是 rootfs 内路径：proot 的 `/root/dsh.log` 就落在
  /// `$rootfsPath/root/dsh.log`，Dart 直接读就行，不用再进一次 proot。
  Future<String> _readLog(String path) async {
    final File file = File(path);
    if (!await file.exists()) {
      return '';
    }
    final int length = await file.length();
    if (length == 0) {
      return '';
    }
    const int window = 8192;
    final int from = length > window ? length - window : 0;
    final RandomAccessFile handle = await file.open();
    try {
      await handle.setPosition(from);
      final List<int> bytes = await handle.read(length - from);
      return utf8.decode(bytes, allowMalformed: true);
    } finally {
      await handle.close();
    }
  }

  String _tail(String text) {
    const int limit = 600;
    if (text.length <= limit) {
      return text;
    }
    return '…${text.substring(text.length - limit)}';
  }

  Future<void> stop() async {
    final LocalLayout layout = await this.layout();
    await _killDsh(layout);
    url = null;
  }

  /// 结束 rootfs 里的 dsh，**并且**把持着那条命令的原生子进程一起停掉。
  ///
  /// 两件事都要做：`pkill` 只在 rootfs 里能看见进程，而外面那条 `proot` 自己并不知道
  /// 它的子进程已经没了；只停外面那条则 `dsh` 会变成孤儿继续占着端口。启动超时的
  /// 时候也必须走这里 —— 否则一条起不来的 `dsh web` 会把 8123 攥住，下一次启动只会
  /// 再超时一次，而报错看起来还是「没有写出地址」。
  Future<void> _killDsh(LocalLayout layout) async {
    await _runToEnd(
      tag: 'stop',
      argv: inRootfs(layout, stopDshCommand),
      allowFailure: true,
    );
    await host.stop('dsh');
  }

  /// `df -k` 一次，拿去算可用空间。失败（比如 toybox 输出格式变了）就返回
  /// null —— 空间检查是保护措施，不该变成新的失败点。
  Future<int?> _freeBytes(LocalLayout layout) async {
    final String output = await _runCapture(
      tag: 'space',
      argv: <String>['/system/bin/df', '-k', layout.filesDir],
      allowFailure: true,
    );
    return freeBytesFromDf(output);
  }

  /// 下载 rootfs，能从 `.part` 续传。
  ///
  /// 两个镜像依次试：换镜像时**保留** `.part`，因为两个镜像的内容是同一份
  /// Alpine minirootfs，字节级一致；从零重下 1.6 GB 才是最坏的选择。
  Future<void> _download(
    LocalLayout layout,
    File target, {
    required void Function(int, int) onProgress,
    void Function(String)? onDetail,
  }) async {
    void detail(String text) => onDetail?.call(text);
    Object? lastError;
    for (int variant = 0; variant < 2; variant += 1) {
      final String url = rootfsUrlFor(layout.abi, variant: variant);
      final File temp = File(partPathOf(target.path));
      try {
        await target.parent.create(recursive: true);
        final HttpClient client = HttpClient();
        client.connectionTimeout = const Duration(seconds: 20);
        // `connectionTimeout` 只管「握手多久放弃」，`await for` 之后的空闲
        // 读取它一概不管。所以要自己给整体加一道闸：连不上时不能无限期停在
        // 「连接镜像」上，那和正在下载看起来一模一样。
        try {
          final int already = await temp.exists() ? await temp.length() : 0;
          detail(
            already > 0
                ? '连接镜像 ${variant + 1}/2（续传 ${_mb(already)}）'
                : '连接镜像 ${variant + 1}/2',
          );
          final HttpClientRequest request = await client
              .getUrl(Uri.parse(url))
              .timeout(const Duration(seconds: 40));
          if (already > 0 && shouldResume(already, null)) {
            request.headers.set(
              HttpHeaders.rangeHeader,
              rangeHeaderValue(already),
            );
          }
          final HttpClientResponse response = await request.close().timeout(
            const Duration(seconds: 40),
          );
          // 206 = 服务端答应了续传；200 = 它忽略了 Range，会从头发整份，
          // 这时手里的半截必须丢掉，否则拼出一个坏文件。
          final bool resuming = response.statusCode == 206 && already > 0;
          if (response.statusCode != 200 && response.statusCode != 206) {
            throw LocalDshError('镜像回了 HTTP ${response.statusCode}：$url');
          }
          final int total = resuming
              ? already + response.contentLength
              : response.contentLength;
          int got = resuming ? already : 0;
          detail('开始下载 ${_mb(total)}');
          final IOSink sink = temp.openWrite(
            mode: resuming ? FileMode.append : FileMode.write,
          );
          try {
            // 每读一块就重置一次看门狗：慢速链路正常，完全停住就不正常。
            const Duration idleLimit = Duration(seconds: 60);
            await for (final List<int> chunk in response.timeout(idleLimit)) {
              sink.add(chunk);
              got += chunk.length;
              onProgress(got, total);
            }
          } finally {
            await sink.close();
          }
          // 半截文件绝不能变成正式名字：改名就等于宣布「这是完整 rootfs」。
          if (total > 0 && got < total) {
            throw LocalDshError('只下到 ${_mb(got)} / ${_mb(total)}，接着下。');
          }
          await temp.rename(target.path);
          return;
        } finally {
          client.close(force: true);
        }
      } on Object catch (error) {
        lastError = error;
        detail('镜像 ${variant + 1} 失败：$error');
      }
    }
    throw LocalDshError('两个镜像都下不下来：$lastError');
  }

  Future<String> _runCapture({
    required String tag,
    required List<String> argv,
    bool allowFailure = false,
  }) async {
    final StringBuffer buffer = StringBuffer();
    await _runToEnd(
      tag: tag,
      argv: argv,
      onLine: buffer.writeln,
      allowFailure: allowFailure,
    );
    return buffer.toString();
  }

  Future<void> _runToEnd({
    required String tag,
    required List<String> argv,
    String? cwd,
    void Function(String line)? onLine,
    bool allowFailure = false,
  }) async {
    final Completer<void> done = Completer<void>();
    late StreamSubscription<LocalLine> sub;
    final StringBuffer stderr = StringBuffer();
    final StringBuffer notes = StringBuffer();
    sub = host.lines.where((LocalLine line) => line.tag == tag).listen((
      LocalLine line,
    ) {
      if (line.kind == 'exit') {
        if (done.isCompleted) {
          return;
        }
        final int code = line.code ?? 0;
        if (code != 0 && !allowFailure) {
          final String note = notes.isEmpty ? '' : '（${notes.toString().trim()}）';
          done.completeError(
            LocalDshError(
              '命令失败（$tag，退出码 $code）$note：${stderr.toString().trim()}',
            ),
          );
        } else {
          done.complete();
        }
        return;
      }
      if (line.kind == 'dropped') {
        // 原生侧在订阅断开期间只能保留最近若干行。这条说明不属于命令自己的
        // 输出，但要让人知道「看到的不是全部」—— 否则一次长安装的输出看起来
        // 像是突然从中间开始。
        notes.writeln(line.line);
        return;
      }
      if (line.kind == 'stderr') {
        stderr.writeln(line.line);
      }
      onLine?.call(line.line);
    });
    try {
      await host.start(tag: tag, argv: argv, cwd: cwd);
      // A native exit that never arrives must not strand the caller forever:
      // provisioning runs on this path, and a hung install looks exactly like a
      // slow one to the person waiting for it.
      await done.future.timeout(
        _exitTimeout,
        onTimeout: () => throw LocalDshError('命令没有回执（$tag 超过 ${_exitTimeout.inMinutes} 分钟没有结束）'),
      );
    } finally {
      await sub.cancel();
    }
  }
}

class LocalDshError implements Exception {
  LocalDshError(this.message);

  final String message;

  @override
  String toString() => message;
}

String _mb(int bytes) => '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
