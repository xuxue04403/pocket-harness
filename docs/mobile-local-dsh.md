# 在手机上本机跑 dsh（PRoot 路径实证）

这是目标里「第二优先：移动端本机运行 dsh」的可行性验证记录。**结论先给**：

- **能跑起来。** 在 Android 15（API 35）x86_64 模拟器上，用 PRoot + Alpine + Node 24 + `@deepseek-ai/dsh@0.2.2-rc.5`，
  `dsh web` 真的启动了，`GET /?token=…` 换到会话 cookie 后 `GET /` 返回 **200 / 41,184 字节 / `<title>DeepSeek Harness</title>`**。
- **代价是体积与内存。** 装完 rootfs **2.0 GB**（其中 dsh 自己 1.63 GB），node 常驻 RSS **约 300 MB**。
- **还没有做成 App 里的按钮。** 这轮只证明机制与参数，客户端接入见下面「接到 App 里还差什么」。

## 为什么不是「直接跑 Android 版 node」

`@deepseek-ai/dsh` 是个纯 Node 程序，但它依赖 `node-pty`、`sharp`（`@img/*`）、`sherpa-onnx-linux-x64` 这些
**原生二进制**，只有 linux-x64 / linux-arm64 的构建。Android 的 bionic libc 与 Linux 的 glibc/musl 不兼容，
所以必须给它一个真的 Linux userland —— 也就是 PRoot（ptrace 级别的 syscall 重定向，不需要 root、不需要内核模块）。

## 实测参数（照抄就能复现）

```powershell
# 1. 一个静态 proot（本机从 gh-proxy 取到的是 ELF64 x86_64 静态可执行，1,841,504 字节）
#    https://github.com/proot-me/proot/releases/download/v5.5.0/proot
adb push proot-static /data/local/tmp/proot
adb shell chmod 755 /data/local/tmp/proot

# 2. Alpine minirootfs（3,509,360 字节，解出来约 8 MB）
adb push alpine-minirootfs-3.21.0-x86_64.tar.gz /data/local/tmp/alpine.tar.gz
adb shell "mkdir -p /data/local/tmp/alp && tar -xzf /data/local/tmp/alpine.tar.gz -C /data/local/tmp/alp"

# 3. 关键一步：Android 没有 /etc/resolv.conf，不 bind 进去 apk 什么都下载不了
adb push resolv.conf /data/local/tmp/resolv.conf

# 4. 进 rootfs。四个 bind 与 -0（伪装 root）必须都给
PROOT="/data/local/tmp/proot -r /data/local/tmp/alp -0 -w /root \
  -b /proc -b /dev -b /sys -b /data/local/tmp/resolv.conf:/etc/resolv.conf"
adb shell "$PROOT /usr/bin/env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root /bin/sh -c '
  apk add --no-cache --repository https://dl-cdn.alpinelinux.org/alpine/edge/main nodejs npm
  apk add --no-cache --repository https://dl-cdn.alpinelinux.org/alpine/edge/main --upgrade libssl3 libcrypto3
  npm config set registry https://registry.npmmirror.com
  npm install -g @deepseek-ai/dsh@0.2.2-rc.5
'"
```

## 四个必须知道的坑

1. **`PATH` 不会自动带上 Alpine 的目录。** 不显式给 `PATH=/usr/local/sbin:…`，`/bin/sh` 能找到自己，
   但 `uname`、`cat`、`env` 全报 `not found` —— 我第一次就撞在这上面，看起来像 rootfs 坏了。
2. **`apk` 必须先有 `/etc/resolv.conf`。** 否则 `apk update` 报
   `temporary error (try again later)`，`/etc/resolv.conf` 本身则是 `No such file or directory`。
   绑定宿主机的解析配置后 `apk update` 立刻可用（25,411 个包）。
3. **Alpine 3.21 stable 的 node 太旧。** `main` 里是 `nodejs-22.23.5`，而 dsh 要求 `engines.node >= 24.9.0`。
   要用 `edge/main` 的 `nodejs-24.22.3`。但**光装 node 起不来**，会报：
   ```
   Error relocating node: OSSL_INDICATOR_get_callback: symbol not found
   Error relocating node: EVP_MD_CTX_get_size_ex: symbol not found
   ```
   因为 edge 的 node 链接的是更新的 OpenSSL。必须同时
   `apk add --upgrade libssl3 libcrypto3`（同样来自 edge/main），从 3.3.2 升到 3.5.9 才对齐。
4. **别用 Termux 仓库里那个 `proot` deb 版本。** 它动态链接 `libtalloc.so.2`、`libandroid-shmem.so`，
   在非 Termux 前缀下要么缺库、要么库路径对不上（我补齐 `libtalloc` 后仍然卡在 `libandroid-shmem`）。
   静态版 `proot-me/proot` 一次就能跑。

## dsh 的启动与鉴权（和桌面端完全一样）

```
dsh --version                              -> 0.2.2-rc.5
dsh web --no-open --host 127.0.0.1 --port 8123
dsh web: http://127.0.0.1:8123/?token=<43 字符 base64url>
```

- `GET /` 无 cookie → **401** `dsh web authentication required; reopen the URL printed by dsh web.`
- `GET /?token=<tok>` → **303**，`Set-Cookie: <name>=v1.…; Max-Age=2592000; HttpOnly; SameSite=Strict`
  （所以 `fetch` 必须 `redirect: 'manual'` 才能拿到那枚 cookie；跟着重定向走会看到第二次 401）。
- 带 cookie `GET /` → **200**，41,184 字节，`<title>DeepSeek Harness</title>`。
- 也就是说：**手机上本机跑的 dsh 就是同一套 Web UI + 同一套 `/api` 接口**，现有的 Host 插件思路
  （`connection.createPeer` + typertGateway）在进程内同样成立，不需要另写一套协议。

## 体积与内存（都是实测，不是估算）

| 项 | 大小 |
| --- | --- |
| rootfs 总计（装完 dsh 后） | 2.0 GB |
| `@deepseek-ai/dsh`（含它自己的 node_modules） | 1.63 GB |
| 其中 `@deepseek-ai/*` 依赖 | 1.23 GB |
| `node` 可执行 | 50 MB |
| npm 缓存 `/root/.npm` | 318 MB（装完可删） |
| dsh 进程常驻 RSS | 约 300 MB |

## 接到 App 里还差什么

这轮是在 **userdebug 模拟器 + adb shell** 上做的，能证明机制，但没有证明从 Flutter App 里能拉起它。
剩下三件事，按难度排序：

1. **可执行文件的落点。** Android 10 起禁止从 App 的可写数据目录 `exec`。可行做法是把 `proot` 与 `loader`
   作为 native lib 打进 APK（`lib/x86_64/libproot.so` 之类），安装后从 `nativeLibraryDir` 执行 ——
   那里是允许 `exec` 的。这是既有方案（Termux 之外的多个 App）共同的做法。
2. **rootfs 的分发。** 2 GB 不能塞进 APK。要做成首次启动时下载 + 解压 + 校验（或者提供「自带 rootfs 的 APK」变体）。
   最省事的组合是 Alpine + npm 装 dsh，实测下载量约 300 MB。
3. **进程与端口的生命周期。** 目前 `dsh web` 是前台进程，需要 App 侧持有一个服务进程、退出时收掉，
   并把 token 从 stdout 抓出来交给 WebView 或直接喂给 ArkTS/Dart 客户端。

## App 里已经做到哪一步

上面三件事里，第 1 件与第 3 件已经落进代码，第 2 件做到了「能下能续传，但只在模拟器上试过」：

| 位置 | 做什么 |
| --- | --- |
| `app/android/app/src/main/jniLibs/<abi>/libproot.so` | 静态 proot（Alpine `proot-static` 5.4.0，arm64-v8a 402,632 字节 / x86_64 268,408 字节），由 `tools/proot-fetch.ps1` 现取，不入库 |
| `app/android/app/build.gradle.kts` | `packaging { jniLibs { useLegacyPackaging = true } }` —— 否则 AGP 8 把 .so 直接从 APK 映射，目录里没有文件，exec 无从谈起 |
| `MainActivity.kt` | `MethodChannel('cn.pocketharness/native')` 的 `paths/start/stop/running/killAll` 与一条 `EventChannel` 逐行回输出；`ProcessBuilder` 的环境被清成一个只有 `PATH`、`HOME` 的环境 |
| `app/lib/src/local/local_commands.dart` | 纯函数：路径布局、proot 命令行、四个安装脚本、token 抓取、续传与空间算术 |
| `app/lib/src/local/local_runner.dart` | 五步安装（下载 → 解压 → DNS/源 → node → dsh）与启动、停止 |
| `app/lib/src/pages/local_page.dart` | 进度、失败原文、启动/停止/打开界面 |

两个新补的、值得单独说的点：

- **断点续传**。下载写 `<archive>.part`，下次带着 `Range: bytes=<已有字节>-` 去要；服务端回 206 就 append，
  回 200（它忽略了 Range）就丢掉半截从头写 —— **拼错的 tar.gz 会在解压时才炸，那时已经过去十分钟**。
  只有确认字节数够了才 `rename` 到正式文件名。换镜像时保留 `.part`：两个镜像的内容是同一份字节。
- **装前空间检查**。`df -k <filesDir>` 的可用量不足 2.6 GB 就直接说「只剩 X、需要 Y」，
  而不是让 `apk` 装到一半 ENOSPC（那个报错藏在它上百行输出里）。toybox 的 `df` **没有 `-m`**，
  默认单位就是 1024 字节，多给一个 `-m` 会直接报 `Unknown option 'm'`。

**默认不露出入口**：`kLocalDshEnabled` 是 `bool.fromEnvironment('POCKET_HARNESS_LOCAL_DSH')`，
beta 包不带这个 define，所以首页没有按钮；要试用得自己
`flutter build apk --release --dart-define=POCKET_HARNESS_LOCAL_DSH=true`。
理由是模拟器根本没有出网能力（`ping dl-cdn.alpinelinux.org` 100% 丢包，`ping 10.0.2.2` 正常），
这条下载路径至今没在能上网的设备上跑过一遍完整的。


## 与「远程操控」的关系

这两条路并不互斥，共用同一份协议核心：

- 远程：手机连电脑上的 dsh（已实现，局域网 + 中继）。
- 本机：手机上跑 dsh，App 内的客户端连 `127.0.0.1`，握手与鉴权逻辑一行都不用改 ——
  只是 `TransportFactory` 连的是环回地址。

## 复现脚本

`tools/proot-dsh/` 下三个脚本把上面这些步骤固化了，都只用 `adb`，不依赖 Termux，也不依赖 root：

| 脚本 | 作用 |
| --- | --- |
| `provision.ps1` | 下载 + 推送 proot 与 Alpine、在 rootfs 里装 Node 24 与 dsh。幂等：已经装过会跳过。 |
| `run.ps1` | 前台起 `dsh web`，从 stdout 抓出带 token 的地址并打印；Ctrl+C 时收掉设备上的进程。 |
| `selfcheck.ps1` | 验收：401 → 303 + cookie → 200 且标题是 `DeepSeek Harness`。全程不打印 token。 |

实测 `selfcheck.ps1` 的输出（x86_64 模拟器，API 35）：

```
ok    dsh web prints a token URL (token present)
ok    without a cookie the UI refuses (status 401)
ok    the refusal explains itself (body mentions authentication)
ok    the token URL redirects once (status 303)
ok    it hands out a session cookie (1 cookie(s))
ok    the UI loads with the cookie (status 200)
ok    it is the real harness UI (title 'DeepSeek Harness')
ok    the page is not a stub (41184 bytes)

MOBILE DSH SELF CHECK PASSED
```

三个脚本都必须存成**带 BOM 的 UTF-8**，否则 Windows PowerShell 5.1 会把其中的中文注释按 GBK 读、
连带吞掉后面的代码行（这个坑在 `tools/ohos-probe/build.ps1` 上已经踩过一次）。
