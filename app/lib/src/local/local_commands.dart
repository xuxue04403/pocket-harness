/// 在手机上本机跑 dsh 时用到的路径与命令行，全部是纯函数，方便单测。
///
/// 这里的每一条参数都是踩出来的，改之前先看注释：
/// - proot 只能从 `nativeLibraryDir` 执行（Android 10 起应用数据目录禁止 exec），
///   所以它随 APK 以 `libproot.so` 的身份安装，路径由原生侧给出。
/// - rootfs 里的 `PATH` 必须显式传。不传时 proot 会把宿主机的环境整个带进去，
///   Alpine 的 `/bin/sh` 拿到的 PATH 里没有 `/bin`，`uname`、`env` 全报 not found，
///   看起来像 rootfs 装坏了。
/// - `-b /proc -b /dev -b /sys` 是必需的：Alpine 的 `apk` 要读 `/proc`，
///   `npm` 要 `/dev/null`。
library;

/// Alpine 与 dsh 的版本选择都是实测定下来的，不要随手升。
const String kAlpineBranch = 'v3.21';
const String kRootfsFile = 'alpine-minirootfs.tar.gz';
const String kDshVersion = '0.2.2-rc.5';
const String kDefaultPort = '8123';

/// 本机跑 dsh 这条路还没到能对外发的程度：proot 与解压已经实测通过，
/// 但首次下载 1.6 GB rootfs 在真机上的进度、断点续传、失败恢复都还没打磨。
/// 因此 v0.1.0-beta 默认不露出入口，用
/// `flutter build apk --dart-define=POCKET_HARNESS_LOCAL_DSH=true` 打开。
const bool kLocalDshEnabled = bool.fromEnvironment('POCKET_HARNESS_LOCAL_DSH');

/// Alpine 3.21 自带的 node 是 22，而 dsh 要求 >= 24.9。
/// 必须从 edge 装，并且同时把 openssl 抬上去，否则 node 起来就报
/// `OSSL_INDICATOR_get_callback: symbol not found`。
const String kAlpineMain = 'https://dl-cdn.alpinelinux.org/alpine/$kAlpineBranch/main';
const String kAlpineCommunity =
    'https://dl-cdn.alpinelinux.org/alpine/$kAlpineBranch/community';
const String kAlpineEdgeMain = 'https://dl-cdn.alpinelinux.org/alpine/edge/main';
const String kAlpineEdgeCommunity =
    'https://dl-cdn.alpinelinux.org/alpine/edge/community';

/// npm 官方源在国内经常几十秒才回第一个字节，换镜像不是可选优化。
const String kNpmRegistry = 'https://registry.npmmirror.com';

/// rootfs 的下载地址。走 Cloudflare 的 CDN，国内实测可用。
const List<String> kRootfsUrls = <String>[
  'https://dl-cdn.alpinelinux.org/alpine/$kAlpineBranch/releases/x86_64/$kRootfsFile',
  'https://mirrors.tuna.tsinghua.edu.cn/alpine/$kAlpineBranch/releases/x86_64/$kRootfsFile',
];

/// 一个 ABI 对应一份 rootfs 与一份 proot —— 二进制不通用。
///
/// 只认 x86_64 与 arm64-v8a：`tools/proot-fetch.ps1` 只取这两个 ABI 的 proot.static，
/// 32 位的 armeabi-v7a 即使下得到 rootfs 也没有 proot 可用，所以要当场说清楚。
String rootfsUrlFor(String abi, {int variant = 0}) {
  final String arch = switch (abi) {
    'x86_64' => 'x86_64',
    'arm64-v8a' => 'aarch64',
    _ => throw UnsupportedError('这台设备的 CPU 是 $abi，目前只支持 x86_64 与 arm64-v8a。'),
  };
  final List<String> urls = <String>[
    'https://dl-cdn.alpinelinux.org/alpine/$kAlpineBranch/releases/$arch/$kRootfsFile',
    'https://mirrors.tuna.tsinghua.edu.cn/alpine/$kAlpineBranch/releases/$arch/$kRootfsFile',
  ];
  return urls[variant % urls.length];
}

/// 设备上的目录布局。所有路径都是设备内的绝对路径（proot 的 `-r` 需要它）。
class LocalLayout {
  const LocalLayout({
    required this.abi,
    required this.nativeLibraryDir,
    required this.filesDir,
  });

  final String abi;
  final String nativeLibraryDir;
  final String filesDir;

  /// 随 APK 安装的静态 proot。文件名必须叫 `lib*.so`，否则不会被打进 jniLibs。
  String get prootPath => '$nativeLibraryDir/libproot.so';

  String get rootfsPath => '$filesDir/dsh-root';
  String get archivePath => '$filesDir/$kRootfsFile';
  String get resolvedConfPath => '$rootfsPath/etc/resolv.conf';

  /// 装完之后的体积约 2.0 GB，留 2.6 GB 才开始，否则装到一半会 ENOSPC。
  static const int requiredFreeBytes = 2600 * 1024 * 1024;

  /// Alpine 里那个固定的搜索路径。`/usr/local/bin` 必须在里面，
  /// 因为 `npm i -g` 把 dsh 装在那里。
  static const String inRootfsPath =
      '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
}

/// proot 的公共参数：绑定目录、工作目录、伪造 root。
List<String> prootPrelude(LocalLayout layout) => <String>[
  '-r',
  layout.rootfsPath,
  '-0',
  '-w',
  '/root',
  '-b',
  '/proc',
  '-b',
  '/dev',
  '-b',
  '/sys',
];

/// 在 rootfs 里执行一段 shell。用 `/usr/bin/env -i` 把环境清干净再给，
/// 免得手机的 `ANDROID_*`、`LD_PRELOAD` 漏进去。
///
/// 第一个元素必须是 proot 自己——进程就是从这里 exec 的。漏掉它的话，
/// ProcessBuilder 会把 `-r` 当成要执行的文件，报
/// `Cannot run program "-r": error=13, Permission denied`。
List<String> inRootfs(LocalLayout layout, String script) => <String>[
  layout.prootPath,
  ...prootPrelude(layout),
  '/usr/bin/env',
  '-i',
  'PATH=${LocalLayout.inRootfsPath}',
  'HOME=/root',
  'TERM=dumb',
  '/bin/sh',
  '-c',
  script,
];

/// `apk` 在这台设备上要先有可写的 `/etc/resolv.conf`，否则 `apk update`
/// 只会回 `temporary error (try again later)`（Android 没有这个文件）。
String resolvConfBody() => 'nameserver 223.5.5.5\nnameserver 1.1.1.1\n';

/// 准备包管理器：更新索引并装 CA 证书。没证书时 `npm` 的 TLS 会失败，
/// 而报错只说 `network`，很容易误判成网络不通。
String updatePackagesScript() => <String>[
  'apk update',
  'apk add --no-cache ca-certificates',
].join(' && ');

/// 装 node。两个坑写在这里：
/// 1. 必须同时从 edge 装 nodejs 与 npm，否则拿到的 node 是 22，dsh 直接拒绝启动。
/// 2. 必须 `--upgrade libssl3 libcrypto3`，否则 node 报
///    `Error relocating node: OSSL_INDICATOR_get_callback: symbol not found`。
String installNodeScript() => <String>[
  'apk add --no-cache'
      ' --repository $kAlpineEdgeMain'
      ' --repository $kAlpineEdgeCommunity'
      ' --upgrade libssl3 libcrypto3 nodejs npm',
  'node --version',
].join(' && ');

/// 装 dsh。`--no-fund --no-audit` 只是省掉两段没用的网络往返 ——
/// 这一步要下 673 个包、1.6 GB，任何多余请求都是分钟级。
String installDshScript() => <String>[
  'npm config set registry $kNpmRegistry',
  'npm install -g --no-fund --no-audit @deepseek-ai/dsh@$kDshVersion',
  'dsh --version',
].join(' && ');

/// 启动 Web UI。`--no-open` 是必须的：容器里没有浏览器，不加它进程会卡在打开浏览器。
String startDshScript({String port = kDefaultPort}) =>
    'exec dsh web --no-open --host 127.0.0.1 --port $port';

/// 从 `dsh web` 的 stdout 里挑出带 token 的那个地址。
///
/// 实测输出形如 `dsh web: http://127.0.0.1:8123/?token=<43 字符>`。
/// 只认带 `token=` 的 http(s) 地址 —— 没有 token 的地址打不开（会 401）。
String? tokenUrlOf(String line) {
  final RegExp match = RegExp('https?://[^\\s"\']+');
  for (final RegExpMatch hit in match.allMatches(line)) {
    final String candidate = hit.group(0)!;
    if (candidate.contains('token=')) {
      return candidate;
    }
  }
  return null;
}

/// 结束本机 dsh。`pkill -f 'lib/bin.js'` 抓不到它 —— 设备上它的命令行是
/// `node /usr/local/bin/dsh web --no-open ...`，要按 `dsh web` 匹配。
const String stopDshCommand = "pkill -f 'dsh web'";

/// 判断某个 proot 失败的输出是不是「还没装好」而不是真的坏了。
bool looksLikeUnprovisioned(String output) =>
    output.contains('No such file or directory') ||
    output.contains('not found') ||
    output.contains('unable to select packages');
