import 'dart:async';
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
  LocalRunner({LocalHost? host, this.port = kDefaultPort}) : host = host ?? LocalHost();

  final LocalHost host;
  final String port;

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
    final LocalLayout layout = await this.layout();
    final String result = await _runCapture(
      tag: 'probe',
      argv: inRootfs(layout, 'node --version && dsh --version'),
      allowFailure: true,
    );
    return result.contains('v2') && result.contains(kDshVersion);
  }

  /// 完整的安装流程。`onProgress` 会被频繁调用，界面要能承受高频 setState。
  Future<void> provision({void Function(ProvisionProgress)? onProgress}) async {
    final LocalLayout layout = await this.layout();
    void report(ProvisionStep step, {String detail = '', double? fraction, bool failed = false}) {
      onProgress?.call(ProvisionProgress(
        step: step,
        detail: detail,
        fraction: fraction,
        failed: failed,
      ));
    }

    // 0. 空间。装完 2.0 GB，门槛 2.6 GB。放在最前面，否则装到一半才 ENOSPC，
    //    而那时的报错藏在 apk 的上百行输出里，看不出是磁盘问题。
    report(ProvisionStep.download, detail: '检查可用空间');
    final int? free = await _freeBytes(layout);
    if (free != null) {
      final String? shortfall = describeSpaceShortfall(free, LocalLayout.requiredFreeBytes);
      if (shortfall != null) {
        throw LocalDshError(shortfall);
      }
    }

    // 1. 下载。已经有完整文件就跳过；只有半截就续传 —— 1.6 GB 断一次重来
    //    对手机是灾难。
    final File archive = File(layout.archivePath);
    final int have = await archive.exists() ? await archive.length() : 0;
    if (have < 1000 * 1000) {
      report(ProvisionStep.download, detail: '连接镜像');
      await _download(layout, archive, onProgress: (int got, int total) {
        report(
          ProvisionStep.download,
          detail: '${_mb(got)} / ${_mb(total)}',
          fraction: total > 0 ? got / total : null,
        );
      });
    }

    // 2. 解压。用系统自带的 toybox tar，不自己在 Dart 里解 ——
    //    Alpine 的 rootfs 里全是符号链接（`/bin/sh -> /bin/busybox`），
    //    Dart 的 archive 包解符号链接的行为在不同版本之间变过。
    report(ProvisionStep.extract, detail: '解开 ${_mb(await archive.length())}');
    await Directory(layout.rootfsPath).create(recursive: true);
    await _runToEnd(
      tag: 'extract',
      argv: <String>['/system/bin/tar', '-xzf', layout.archivePath, '-C', layout.rootfsPath],
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
  /// 超时 90 秒：实测冷启动 8 秒，加上 proot 首次建立映射，给足余量。
  Future<String> start({Duration timeout = const Duration(seconds: 90)}) async {
    final LocalLayout layout = await this.layout();
    final Completer<String> ready = Completer<String>();
    late StreamSubscription<LocalLine> sub;
    sub = host.lines.listen((LocalLine line) {
      final String? found = tokenUrlOf(line.line);
      if (found != null && !ready.isCompleted) {
        ready.complete(found);
      }
      if (line.kind == 'exit' && !ready.isCompleted) {
        ready.completeError(LocalDshError('dsh 启动后立刻退出了（退出码 ${line.code}）。'));
      }
    });
    try {
      await host.start(
        tag: 'dsh',
        argv: inRootfs(layout, startDshScript(port: port)),
        cwd: layout.rootfsPath,
      );
      final String found = await ready.future.timeout(timeout, onTimeout: () {
        throw LocalDshError('dsh 在 ${timeout.inSeconds} 秒内没有打印出带 token 的地址。');
      });
      url = found;
      return found;
    } finally {
      await sub.cancel();
    }
  }

  Future<void> stop() async {
    final LocalLayout layout = await this.layout();
    await _runToEnd(
      tag: 'stop',
      argv: inRootfs(layout, stopDshCommand),
      allowFailure: true,
    );
    await host.stop('dsh');
    url = null;
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
    File target,
    {required void Function(int, int) onProgress}
  ) async {
    Object? lastError;
    for (int variant = 0; variant < 2; variant += 1) {
      final String url = rootfsUrlFor(layout.abi, variant: variant);
      final File temp = File(partPathOf(target.path));
      try {
        await target.parent.create(recursive: true);
        final HttpClient client = HttpClient();
        client.connectionTimeout = const Duration(seconds: 20);
        try {
          final int already = await temp.exists() ? await temp.length() : 0;
          final HttpClientRequest request = await client.getUrl(Uri.parse(url));
          if (already > 0 && shouldResume(already, null)) {
            request.headers.set(HttpHeaders.rangeHeader, rangeHeaderValue(already));
          }
          final HttpClientResponse response = await request.close();
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
          final IOSink sink = temp.openWrite(
            mode: resuming ? FileMode.append : FileMode.write,
          );
          try {
            await for (final List<int> chunk in response) {
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
    sub = host.lines.where((LocalLine line) => line.tag == tag).listen((LocalLine line) {
      if (line.kind == 'exit') {
        if (done.isCompleted) {
          return;
        }
        final int code = line.code ?? 0;
        if (code != 0 && !allowFailure) {
          done.completeError(LocalDshError(
            '命令失败（退出码 $code）：${stderr.toString().trim()}',
          ));
        } else {
          done.complete();
        }
        return;
      }
      if (line.kind == 'stderr') {
        stderr.writeln(line.line);
      }
      onLine?.call(line.line);
    });
    try {
      await host.start(tag: tag, argv: argv, cwd: cwd);
      await done.future;
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
