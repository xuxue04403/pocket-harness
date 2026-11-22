# 在手机上本机跑 dsh（PRoot 路径实证）

这是目标里「第二优先：移动端本机运行 dsh」的可行性验证记录。**结论先给**：

- **能做进 App，而且已经做进去了。** Android 15（API 35）x86_64 模拟器上，用 PRoot + Alpine +
  Node 24 + `@deepseek-ai/dsh@0.2.2-rc.5`，App 里点两下就能装、能启动，WebView 里真的渲染出 DSH 页面。
- **代价是体积与内存。** 装完 rootfs **2.0 GB**（其中 dsh 自己 1.63 GB），node 常驻 RSS **约 300 MB**；
  `npm i -g` 一次要 **23 分钟**。
- **差别在于用哪个 proot。** 命令行下能跑的静态版进到应用里必然被 seccomp 打死（退出码 159），
  只有 Termux 那个**动态版** + 把 loader 放进 `nativeLibraryDir` 才跑得起来，见下面「从 App 里拉起来」。

## 为什么不是「直接跑 Android 版 node」

`@deepseek-ai/dsh` 是个纯 Node 程序，但它依赖 `node-pty`、`sharp`（`@img/*`）、`sherpa-onnx-linux-x64` 这些
**原生二进制**，只有 linux-x64 / linux-arm64 的构建。Android 的 bionic libc 与 Linux 的 glibc/musl 不兼容，
所以必须给它一个真的 Linux userland —— 也就是 PRoot（ptrace 级别的 syscall 重定向，不需要 root、不需要内核模块）。

## 实测参数（照抄就能复现）

> **这一节是「adb shell 里能不能跑」阶段的记录**，用的是静态 proot 与 `-0`。
> 这两样在**应用进程**里都不成立（见下一节），复现 App 内的路径请用 `tools/proot-fetch.ps1`
> 取 Termux 的动态版、并去掉 `-0`。留着这节是因为它把 rootfs 那一侧的坑讲全了。

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
4. **`proot` 选哪个版本，取决于你从哪儿跑它。** 在 `adb shell` / `su` 域里，Termux 那个动态链接的
   `proot` deb 确实会因为 `libtalloc.so.2`、`libandroid-shmem.so` 找不到而跑不动，静态版一次就对。
   **但在应用进程里结论反过来**：静态版被 seccomp 打死（退出码 159、零输出），
   Termux 的动态版才是唯一能跑的。两边的判断都要看 SELinux 域，详见下一节。

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

## 从 App 里拉起来：做完了，但路上有五道坎

这一节记录的是「App 内运行」这一段真正踩到的东西，按被发现的顺序排。
每一条都是实测证据，不是设计推演。

### 一、`proot-static` 在应用进程里永远起不来（换成 Termux 的动态版）

Alpine 的 `proot-static` 5.4.0 在 `adb shell` 下好好的，进到应用里就死：任何**真正 exec 子进程**
的调用都返回 **退出码 159**（= 128 + 31，SIGSYS），`stdout` / `stderr` 一个字都没有，耗时只有 2–50 毫秒。
`--version` 却是 0 —— 说明死点在「proot 开始跟踪子进程」之后、打印任何日志之前。

排查用的是 `MainActivity.kt` 里的 `runSelfTest()`（`adb shell am start -n …/.MainActivity --es selftest 1`，
日志 tag `PocketSelfTest`），它用与生产完全相同的 `ProcessBuilder`（清空环境）跑八个用例。
线索在这里：应用进程 `/proc/<pid>/status` 是 `Seccomp: 2`、`Seccomp_filters: 1`（zygote 继承的
untrusted_app 过滤器），而 `adb shell` / `su` 域是 `Seccomp: 0` —— 所以「命令行下能跑」从不代表「应用里能跑」。
`logcat`、crash buffer、`dmesg` 里**都没有 SIGSYS 记录**（内核默认不写 audit），只能靠退出码认。

proot-me 官方 v5.5.0 静态版更差（连 `--version` 都 159）。真正能用的是 **Termux 的动态版**
`proot 5.1.107.102`：它把 loader 放在独立文件里，可以跟 proot 一起塞进 `nativeLibraryDir`
（Android 10 起唯一允许 `exec` 的位置），于是不再需要往数据目录里落地可执行文件。
```text
libproot.so          usr/bin/proot             arm64 259,832 / x86_64 277,144
libproot-loader.so   usr/libexec/proot/loader  arm64  18,136 / x86_64  18,368
libtalloc.so         usr/lib/libtalloc.so.2.5.0
libandroid-shmem.so  usr/lib/libandroid-shmem.so
```
`PROOT_LOADER` **必须指 `nativeLibraryDir`**；指到 `files/lib` 就 `execve: Permission denied`。
`libtalloc.so` 要复制成 `libtalloc.so.2`（`DT_NEEDED` 写的是带版本号的名字），
`LD_LIBRARY_PATH` 必须同时含那个目录与 `nativeLibraryDir`，否则
`CANNOT LINK EXECUTABLE … library "libandroid-shmem.so" not found`。

### 二、`-0`（fake root）让 rootfs 里的符号链接读不出来

去掉上面那道坎之后，`dsh --version` 仍然报 `/bin/sh: dsh: Permission denied`，
而 `ls -l` 显示链接、权限位、属主全部正常。对照实验（`su 10160` 跑同一份命令）：
加不加 `-0` 都能跑，`-0` 时 `id` 是 root、不加时是 `uid=10160`。**差别在 SELinux 域，不在权限位。**

结论：`prootPrelude()` 里**没有 `-0`**。rootfs 的文件本来就属主是应用自己，不需要伪造 root 也能写；
伪造之后反而在 untrusted_app 域里对链接一律 `Permission denied`。

顺带还有一个绕不开的点：应用进程里那条 **root 属主的符号链接**（`/usr/local/bin/dsh` → `…/lib/bin.js`）
即使去掉 `-0`、即使删掉重建成 app 属主，仍然读不了。所以装完 dsh 之后要把 npm 留下的链接
换成一段三行脚本：
```sh
#!/bin/sh
exec node /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"
```
这不是兜底，是必需步骤。

### 三、`exit` 事件比最后一行输出先到

`node --version && dsh --version` 只回来一行 `v24.22.3`。原因是 `waitFor()` 与 `readLine()`
在两条线程上，调用方一看到 `exit` 就不再收集。修法：`pump()` 返回 `Thread`，
`waitFor()` 之后 `outPump.join(2000); errPump.join(2000)` 再发 `exit`。
改完立刻多出那行 `Permission denied` —— 上一道坎正是这样才浮出来的。

### 四、`dsh web` 的输出在应用里读不到，得改读日志文件

`dsh web --no-open --host 127.0.0.1 --port 8123` 确实起来了（`toybox nc 127.0.0.1 8123` 回
`HTTP/1.1 401 Unauthorized`），但监听 stdout 的 Dart 代码 90 秒一行都没收到。
改成把输出重定向进 `/root/dsh.log`、Dart 侧每 500 ms 读一次
`$rootfsPath/root/dsh.log` 的尾部 8 KB —— 立刻能拿到
`dsh web: http://127.0.0.1:8123/?token=<43 字符>`。

同一条路上还有一次真实误判：那次失败其实是 **`EADDRINUSE`**（上一次没死透的 `dsh web` 占着 8123）。
**排查 dsh 起不来要先看 `$rootfsPath/root/.dsh/logs/` 里最新的 `startup-*.log`**，
那里的原文是 `listen EADDRINUSE: address already in use 127.0.0.1:8123`，比 stdout 有用得多。

### 五、WebView 打不开 `http://127.0.0.1`

`dsh web` 只监听回环、只给 `http://` 地址，而 Android 9 起明文 HTTP 默认被禁，WebView 会白屏。
`app/android/app/src/main/res/xml/network_security_config.xml` 只对 `127.0.0.1`、`localhost`、
`10.0.2.2` 开 `cleartextTrafficPermitted="true"`，其余域名照旧禁止。

### 结果

装一次实测：下载 3.4 MB 的 Alpine minirootfs → 解压 → `apk update` → 装 node 24 → `npm i -g`
671 个包 **23 分钟** → 换成包装脚本。之后点「启动 dsh」，约 60 秒 UI 从「正在启动…」
变「正在运行」，给出「打开界面」。
点进去 WebView 真的渲染出 DSH 页面（chromium console 日志里能看到它在
`http://127.0.0.1:8123/plugins/?…` 上加载四十多个客户端插件）。

**默认仍然不露出入口**：`kLocalDshEnabled` 是
`bool.fromEnvironment('POCKET_HARNESS_LOCAL_DSH')`，beta 包不带这个 define，所以首页没有按钮；
要试用得自己 `flutter build apk --release --dart-define=POCKET_HARNESS_LOCAL_DSH=true`。
原因是首次 1.6 GB 下载只在模拟器上验过（模拟器还得手工
`ip route add default via 10.0.2.2 dev eth0` 才能出网），真机上的耗时与失败恢复还没跑过。


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
