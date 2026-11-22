import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_harness/src/local/local_commands.dart';

void main() {
  const LocalLayout layout = LocalLayout(
    abi: 'x86_64',
    nativeLibraryDir:
        '/data/app/~~abc==/cn.pocketharness.pocket_harness-1/lib/x86_64',
    filesDir: '/data/user/0/cn.pocketharness.pocket_harness/files',
  );

  group('路径布局', () {
    test('proot 必须从 nativeLibraryDir 取，文件名是 libproot.so', () {
      expect(
        layout.prootPath,
        '/data/app/~~abc==/cn.pocketharness.pocket_harness-1/lib/x86_64/libproot.so',
      );
    });

    test('rootfs 与归档都落在 filesDir 下', () {
      expect(layout.rootfsPath, '${layout.filesDir}/dsh-root');
      expect(layout.archivePath, '${layout.filesDir}/alpine-minirootfs.tar.gz');
      expect(layout.resolvedConfPath, '${layout.rootfsPath}/etc/resolv.conf');
    });

    test('磁盘门槛是 2.6 GB，因为装完要 2.0 GB', () {
      expect(LocalLayout.requiredFreeBytes, 2600 * 1024 * 1024);
      expect(LocalLayout.requiredFreeBytes, greaterThan(2000 * 1024 * 1024));
    });
  });

  group('rootfs 下载地址', () {
    test('x86_64 对应 x86_64', () {
      expect(rootfsUrlFor('x86_64'), contains('/releases/x86_64/'));
    });

    test('arm64-v8a 对应 aarch64', () {
      expect(rootfsUrlFor('arm64-v8a'), contains('/releases/aarch64/'));
    });

    test('第二个变体换镜像，不换架构', () {
      final String first = rootfsUrlFor('arm64-v8a');
      final String second = rootfsUrlFor('arm64-v8a', variant: 1);
      expect(second, isNot(first));
      expect(second, contains('/releases/aarch64/'));
    });

    test('变体下标会绕回来', () {
      expect(rootfsUrlFor('x86_64', variant: 2), rootfsUrlFor('x86_64'));
    });

    test('不支持的 ABI 要明确拒绝，而不是下去一个跑不起来的 rootfs', () {
      expect(() => rootfsUrlFor('armeabi-v7a'), throwsUnsupportedError);
    });

    // 上游 releases 目录里没有裸名 `alpine-minirootfs.tar.gz`：
    // dl-cdn 回 404，清华回 403（后者看起来像被墙，其实是路径错了）。
    test('下载地址里的文件名带版本与架构', () {
      for (final String abi in <String>['x86_64', 'arm64-v8a']) {
        final String url = rootfsUrlFor(abi);
        final String arch = abi == 'arm64-v8a' ? 'aarch64' : 'x86_64';
        expect(
          url,
          endsWith('/alpine-minirootfs-$kAlpineVersion-$arch.tar.gz'),
        );
        expect(url, contains('/$kAlpineBranch/'));
        expect(url, isNot(endsWith('/alpine-minirootfs.tar.gz')));
      }
    });
  });

  group('解压', () {
    // 直接往已有的 rootfs 上重解时，toybox 的 tar 会跟着旧符号链接去写
    // 安卓自己的 /bin，报 `tar: './bin/chown' /system/bin/busybox not under ...`。
    test('先解到 .new 再换上去，不覆盖已有目录', () {
      final String script = extractScript(layout);
      expect(script, contains('rm -rf ${layout.rootfsPath}.new'));
      expect(script, contains('-C ${layout.rootfsPath}.new'));
      expect(
        script,
        contains('mv ${layout.rootfsPath}.new ${layout.rootfsPath}'),
      );
      final int extractAt = script.indexOf('-xzf');
      final int moveAt = script.indexOf('mv ');
      expect(moveAt, greaterThan(extractAt));
    });
  });

  group('proot 命令行', () {
    test('公共参数里有 -r、-0、-w 与三个必需绑定', () {
      final List<String> prelude = prootPrelude(layout);
      expect(prelude.sublist(0, 2), <String>['-r', layout.rootfsPath]);
      expect(prelude.sublist(2, 4), <String>['-w', '/root']);
      // 不能有 -0：伪造 root 会让 proot 在应用域里对 rootfs 内的
      // 符号链接回 Permission denied。
      expect(prelude, isNot(contains('-0')));
      for (final String dir in <String>['/proc', '/dev', '/sys']) {
        final int at = prelude.indexOf(dir);
        expect(at, greaterThan(0));
        expect(prelude[at - 1], '-b');
      }
    });

    test('PATH 必须显式给，而且要含 /usr/local/bin', () {
      final List<String> argv = inRootfs(layout, 'true');
      final int envAt = argv.indexOf('/usr/bin/env');
      expect(envAt, greaterThan(0));
      expect(argv[envAt + 1], '-i');
      final String pathEntry = argv.firstWhere(
        (String a) => a.startsWith('PATH='),
      );
      expect(pathEntry, 'PATH=${LocalLayout.inRootfsPath}');
      expect(LocalLayout.inRootfsPath.split(':'), contains('/usr/local/bin'));
      expect(LocalLayout.inRootfsPath.split(':'), contains('/bin'));
    });

    test('第一个参数必须是 proot 的绝对路径', () {
      // 漏掉它时 ProcessBuilder 会把 `-r` 当可执行文件，报
      // `Cannot run program "-r": error=13, Permission denied`。
      final List<String> argv = inRootfs(layout, 'true');
      expect(argv.first, layout.prootPath);
      expect(argv[1], '-r');
    });

    test('环境是清空重建的，手机上的 LD_PRELOAD 漏不进去', () {
      final List<String> argv = inRootfs(layout, 'true');
      expect(argv[argv.indexOf('/usr/bin/env') + 1], '-i');
      expect(argv.where((String a) => a.contains('LD_PRELOAD')), isEmpty);
    });

    test('脚本原样作为 sh -c 的最后一个参数', () {
      final List<String> argv = inRootfs(layout, 'apk update');
      expect(argv.sublist(argv.length - 3), <String>[
        '/bin/sh',
        '-c',
        'apk update',
      ]);
    });
  });

  group('安装脚本', () {
    test('装 node 必须同时用 edge 源并升级 openssl', () {
      final String script = installNodeScript();
      expect(script, contains(kAlpineEdgeMain));
      expect(script, contains(kAlpineEdgeCommunity));
      expect(script, contains('--upgrade libssl3 libcrypto3'));
      expect(script, contains('nodejs'));
      expect(script.endsWith('node --version'), isTrue);
    });

    test('装 dsh 走镜像源，并固定版本', () {
      final String script = installDshScript();
      expect(script, contains(kNpmRegistry));
      expect(script, contains('@deepseek-ai/dsh@$kDshVersion'));
      expect(script, contains('--no-fund --no-audit'));
      // 装完必须把 npm 的符号链接换成脚本：应用域里 proot 读不了那个链接。
      expect(script, contains('/usr/local/bin/dsh'));
      expect(script, contains(kDshEntry));
      expect(script.lastIndexOf('dsh --version'), greaterThan(script.indexOf('chmod')));
    });

    test('先更新索引再装证书，顺序不能反', () {
      final String script = updatePackagesScript();
      expect(script.indexOf('apk update'), 0);
      expect(
        script.indexOf('ca-certificates'),
        greaterThan(script.indexOf('apk update')),
      );
    });

    test('resolv.conf 里必须有 nameserver，否则 apk 只会说 temporary error', () {
      expect(resolvConfBody(), contains('nameserver '));
    });
  });

  group('启动与停止', () {
    test('启动命令带 --no-open 与端口，并且 exec 掉 shell', () {
      final String script = startDshScript();
      expect(script, contains('exec dsh web'));
      expect(script, contains('--no-open'));
      expect(script, contains('--host 127.0.0.1'));
      expect(script, contains('--port $kDefaultPort'));
      // 输出必须重定向进日志：应用里那条管道读不到东西。
      expect(script, contains('> $kDshLog'));
      expect(script, contains('2>&1'));
    });

    test('端口可以换', () {
      expect(startDshScript(port: '9000'), contains('--port 9000'));
    });

    test('停止按 dsh web 匹配（按 lib/bin.js 抓不到）', () {
      expect(stopDshCommand, contains('dsh web'));
      expect(stopDshCommand, isNot(contains('lib/bin.js')));
    });
  });

  group('从输出里抓 token 地址', () {
    test('抓得到实测的启动行', () {
      const String line =
          'dsh web: http://127.0.0.1:8123/?token=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd';
      expect(
        tokenUrlOf(line),
        'http://127.0.0.1:8123/?token=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd',
      );
    });

    test('没有 token 的地址不算（打开会 401）', () {
      expect(tokenUrlOf('dsh web: http://127.0.0.1:8123/'), isNull);
    });

    test('同一行有多个地址时挑带 token 的那个', () {
      const String line =
          'open https://example.com/docs or http://127.0.0.1:8123/?token=xyz';
      expect(tokenUrlOf(line), 'http://127.0.0.1:8123/?token=xyz');
    });

    test('行尾的引号不会带进地址', () {
      const String line = 'visit "http://127.0.0.1:8123/?token=abc" now';
      expect(tokenUrlOf(line), 'http://127.0.0.1:8123/?token=abc');
    });

    test('完全没有地址就返回 null', () {
      expect(tokenUrlOf('starting...'), isNull);
      expect(tokenUrlOf(''), isNull);
    });
  });

  group('续传', () {
    test('.part 就在正式文件后面加后缀', () {
      expect(
        partPathOf('/data/files/alpine.tar.gz'),
        '/data/files/alpine.tar.gz.part',
      );
    });

    test('一个字节都没有就不算续传', () {
      expect(shouldResume(0, 1000), isFalse);
      expect(shouldResume(-1, 1000), isFalse);
    });

    test('没下满就该续传', () {
      expect(shouldResume(500, 1000), isTrue);
    });

    test('已经下满就不用续传（等改名）', () {
      expect(shouldResume(1000, 1000), isFalse);
      expect(shouldResume(1200, 1000), isFalse);
    });

    test('镜像没给 Content-Length 时仍然续传，让服务端裁决', () {
      expect(shouldResume(500, null), isTrue);
      expect(shouldResume(500, -1), isTrue);
      expect(shouldResume(0, null), isFalse);
    });

    test('Range 头是从已下载的位置到结尾', () {
      expect(rangeHeaderValue(12345), 'bytes=12345-');
      expect(rangeHeaderValue(0), 'bytes=0-');
    });
  });

  group('可用空间', () {
    test('解析 toybox df 的 1K 块（没有 -m，默认就是 1024 字节）', () {
      const String output =
          'Filesystem       1K-blocks    Used Available Use% Mounted on\n'
          '/dev/block/dm-43   6082144 2065944   4016200  34% /mnt/pass_through/0/emulated\n';
      expect(freeBytesFromDf(output), 4016200 * 1024);
    });

    test('表头行解析不出数字，会跳过', () {
      expect(
        freeBytesFromDf(
          'Filesystem 1K-blocks Used Available Use% Mounted on\n',
        ),
        isNull,
      );
    });

    test('空输出返回 null，不抛', () {
      expect(freeBytesFromDf(''), isNull);
    });

    test('设备名折行时从后往前找，取到最后那条数据行', () {
      const String output =
          'Filesystem 1K-blocks Used Available Use% Mounted on\n'
          '-128G  100 200 300 40% /data\n';
      expect(freeBytesFromDf(output), 300 * 1024);
    });

    test('够了不说话', () {
      expect(
        describeSpaceShortfall(3000 * 1024 * 1024, 2600 * 1024 * 1024),
        isNull,
      );
    });

    test('不够要说清两个数字', () {
      final String text = describeSpaceShortfall(
        1000 * 1024 * 1024,
        2600 * 1024 * 1024,
      )!;
      // 1000 MB < 1 GB（1024 MB），所以按 MB 说；需求那侧超过 1 GB 按 GB 说。
      expect(text, contains('1000 MB'));
      expect(text, contains('2.5 GB'));
      expect(text, contains('清出空间'));
    });

    test('体积按 GB 说，小于 1 GB 才回退到 MB', () {
      expect(spaceLabel(2 * 1024 * 1024 * 1024), '2.0 GB');
      expect(spaceLabel(500 * 1024 * 1024), '500 MB');
    });
  });

  group('判断「还没装好」', () {
    test('缺文件、缺命令、缺包都算没装好', () {
      expect(looksLikeUnprovisioned('sh: dsh: not found'), isTrue);
      expect(
        looksLikeUnprovisioned('proot: /bin/sh: No such file or directory'),
        isTrue,
      );
      expect(
        looksLikeUnprovisioned('ERROR: unable to select packages:'),
        isTrue,
      );
    });

    test('真的坏了不算没装好', () {
      expect(looksLikeUnprovisioned('Segmentation fault'), isFalse);
      expect(looksLikeUnprovisioned(''), isFalse);
    });
  });
}
