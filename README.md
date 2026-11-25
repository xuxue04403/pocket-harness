# Pocket Harness

用手机操控跑在电脑上的 DeepSeek Harness，链路端到端加密。

**当前版本：v0.1.5**（范围只有「远程操控电脑」，更新记录见 [CHANGELOG.md](CHANGELOG.md)）

安装包：[release 页](https://github.com/xuxue04403/pocket-harness/releases/tag/v0.1.5) ·
源码：`git clone https://github.com/xuxue04403/pocket-harness.git`

工作区、智能体运行时与会话历史全部留在电脑上，手机只是一扇窗：扫一次码完成配对，之后就能在外面列会话、读记录、发提示词——同一个局域网里直连，跨网络时走你自己部署的中继。

数据不经过任何第三方服务器。没有账号体系，没有托管的中转，也没有遥测。

```
 手机（Flutter）                                 电脑（DeepSeek Harness）
┌──────────────────────┐                      ┌──────────────────────────────┐
│ 会话 / 对话 / 工具卡片 │  Noise IK + ChaCha20 │ dsh-pocketharness-host 插件   │
│ dsh_link (纯 Dart)    │◄────────────────────►│  ├─ TCP 监听（局域网）        │
└──────────────────────┘                      │  ├─ Relay 客户端（公网出站）   │
           ▲                                  │  └─ ctx.typertGateway 透传    │
           │ 公网时                             └──────────────────────────────┘
    ┌──────┴───────┐
    │ relay/ 只转发密文 │  ← 部署在你自己的 VPS 上
    └──────────────┘
```

## 当前能力

| 能力 | 状态 |
|---|---|
| 配对（扫码 / 粘贴配对码） | ✅ 一次性携带公钥与端点，天然 TOFU；插件在设置页里常驻一张二维码，每 10 分钟自动换 |
| 局域网直连 | ✅ TCP + Noise IK |
| 在手机上本机跑 dsh | ⏳ 未开启：**从 App 里已经跑通**（装 node 24 + dsh、启动、WebView 渲染出 DSH 页面），但首次要下 1.6 GB、装完占 2.0 GB，beta 默认不露出入口，见 docs/mobile-local-dsh.md |
| 公网中继（自建） | ✅ 双方出站，中继只见密文；配 `relayUrl` + `relayToken` 即启用 |
| 会话列表、历史、新建会话 | ✅ 照电脑左侧栏的样子按「项目 → 会话」树形展示（默认折叠成项目索引，点开哪个看哪个）；新建时可挑智能体预设与工作目录，长按可改名 |
| 链路保活（心跳） | ✅ 静默断线 10 秒内报错，不会一直转圈 |
| 查找会话（标题、目录、正文） | ✅ 830 个会话也能定位；正文检索随 Host 配置，关掉时仅按标题目录 |
| 按会话切换模型与思考强度（含网关模型） | ✅ 只影响当前会话，可回退默认 |
| 查看与修改电脑的全局默认模型 | ✅ 带 revision 校验，电脑上改了会拒绝覆盖 |
| 发送提示词、抢断、停止 | ✅ |
| 运行中逐字流式显示 | ✅ 思考与正文分栏 |
| 回复按 markdown 渲染 | ✅ 标题、列表、引用、表格、代码卡片（语言标签、行号、复制按钮）；代码高亮是自带的小词法分析器，不引第三方语法包；流式期间也是同一套渲染，带闪烁光标 |
| 工具调用与结果卡片 | ✅ |
| 工具审批与提问（在手机上回答） | ✅ 拒答即 fail-closed，也可转回电脑 |
| 发送与查看图片 | ✅ 从相册选图随消息发出，历史里的图片按需取回 |
| 浏览工作区文件 | ✅ 按目录翻、按名字搜、按行读文本，只读 |
| 编辑 AGENTS 类指令文件 | ✅ 手机上列出 agent 真正会加载的 `AGENTS.md`/`CLAUDE.md`（含用户级与项目链）、读、改、新建、写回电脑；只能写这四种文件名，且只能落在已有的指令目录里 |
| 后台任务 | ✅ 看会话跑的每条命令、跟随实时输出、可远程终止 |
| 待办面板 | ✅ 贴在对话上方，显示完成进度与当前项，可折叠 |
| 会话分支 | ✅ 从当前会话分出一个副本，两边并行不互相影响 |
| Android | ✅ 模拟器与构建均通过 |
| HarmonyOS 7.0 | 🟡 配对 → 会话列表（含新建会话）→ 对话页（含审批、提问、模型切换与技能插入）→ 电脑设置（改全局默认模型）→ 工作区文件（列目录、搜索、分页读）→ 发送图片（相册选图随消息发出）→ 历史图片缩略图（按需取回、按 attachmentId 缓存）→ 后台任务（看会话跑的命令、跟随输出、终止）→ agent 计划面板（进度与当前一步）→ AGENTS 类指令文件（列出 agent 真正会读的顺序、读、改、新建、写回电脑）已在 ArkTS 里跑通，局域网与中继两条路都能连，能编出 HAP；扫码配对**已接通系统相机**：鸿蒙 SDK 没有条码接口，本仓库自己写了解码器（格式位、Reed-Solomon、定位图案、仿射采样），首页「扫二维码」按钮会调系统相机拍一张再解出配对码，粘贴配对码作为兜底，见 [docs/harmony-packaging.md](docs/harmony-packaging.md) |
| WebRTC P2P / TURN | ⏳ 二期（局域网直连 + 中继已覆盖当前场景） |

## 仓库结构

| 目录 | 内容 |
|---|---|
| [`app/`](app) | Flutter 客户端（Android 已通；鸿蒙共用同一套 Dart） |
| [`packages/dsh_link/`](packages/dsh_link) | 纯 Dart 协议核心：Noise IK、分片、信封、RPC、双传输 |
| [`packages/dsh_arkts/`](packages/dsh_arkts) | 同一套协议的 TypeScript 版，供鸿蒙 ArkTS 使用；金标向量、真实 Host 与真实中继三条链路均实测通过；另有纯 ArkTS 的二维码解码器 |
| [`tools/ohos-probe/`](tools/ohos-probe) | 鸿蒙 ArkTS 宿主工程（配对码页、会话列表与新建面板、对话页、审批条、模型面板、技能面板、电脑设置页、工作区文件页、图片选择与历史缩略图、后台任务页、agent 计划面板、AGENTS 类指令页（列出/编辑/新建并写回电脑）、从剪贴板粘贴配对码、扫码配对（系统相机拍一张）、二维码金标与相机帧自检），Windows 上可产出已签名 HAP（用 SDK 自带的签名材料，不需要华为账号） |
| [`host/`](host) | DSH Host 插件，零运行时依赖的 ESM |
| [`relay/`](relay) | 极简中继，只做房间配对与密文转发 |
| [`tools/proot-dsh/`](tools/proot-dsh) | 在手机上本机跑 dsh 的安装与自检脚本（PRoot + Alpine + Node 24） |
| [`docs/`](docs) | 设计文档与打包说明 |
| [`probe/`](probe) | 诊断脚本（金标向量回放、真实 Harness 探测） |

## 快速开始

### 0. 拿到代码

```bash
git clone https://github.com/xuxue04403/pocket-harness.git
cd pocket-harness
```

默认分支是 `master`。预编译包在
[v0.1.5 release](https://github.com/xuxue04403/pocket-harness/releases/tag/v0.1.5) 页。

没网或者只想要离线副本时，release 附件里还有一个 `pocket-harness-0.1.5.bundle`，
里面是完整历史与 `v0.1.5` 标签，可以不联网直接克隆出来构建：

```bash
git clone pocket-harness-0.1.5.bundle pocket-harness
git bundle verify pocket-harness-0.1.5.bundle   # 校验完整历史
```

### 1. 在电脑上装 Host 插件

需要 DeepSeek Harness 0.2.2 或更新的版本。三种装法，按顺手的来：

**a. 从 release 里的插件包装（不用 git，最省事）**

[release 页](https://github.com/xuxue04403/pocket-harness/releases) 上有一个
`dsh-pocketharness-host-0.1.5.tgz`。下载到本地，在 Harness 的插件管理器里点安装，
安装目标填这个**压缩包的绝对路径**（形如 `D:\下载\dsh-pocketharness-host-0.1.5.tgz`）。
插件管理器按扩展名识别：`.tgz` / `.tar.gz` 结尾的绝对路径当作压缩包解开装，
绝对目录则当作目录直链（也就是下面的 b）。

装之前先核对它没被改过：

```powershell
$expected = (Select-String -Path SHA256SUMS.txt -Pattern 'dsh-pocketharness-host').Line.Split(' ')[0]
$actual   = (Get-FileHash -Algorithm SHA256 .\dsh-pocketharness-host-0.1.5.tgz).Hash.ToLower()
$actual -eq $expected      # 应输出 True
```

**b. 从仓库目录装（开发时用，改完代码重载一次就生效）**

在插件管理器里选「安装本地目录」，指向本仓库的 `host/`。这样是目录直链，
改了 `host/*.js` 后不用重新打包。

**c. 用 `dsh plugin` 命令行装（只用 CLI 的 profile）**

```bash
dsh plugin install /绝对路径/dsh-pocketharness-host-0.1.5.tgz
```

> **`desktop` profile 只能用 a 或 b**。它由 Electron 独占，`dsh plugin` CLI 操作不了它，
> 「安装本地目录」也只能由插件管理器自己做。a 是唯一不用 git、也不用手改配置的路子。

**为什么离线包必须自足**：Harness 用 Junction（Windows 目录链接）把插件挂进
`~/.dsh/profiles/<profile>/node_modules/`，然后直接 `import`，**这一层没有自己的 `node_modules`**。
所以插件里不能 `import` 任何第三方包——`host/` 是零依赖的 ESM（连二维码编码器都是自己写的，
见 `host/qr_encode.js`）。压缩包里没有 `dependencies`，装完只占 165 KB。

需要更细的步骤（profile 配置、接中继、改端口、查日志、升级与卸载）见
[docs/host-deploy.md](docs/host-deploy.md)。

装好后 Harness 日志里会出现：

```
pocket-harness: link server listening on port 48100
pocket-harness: pairing code pocketharness://pair?t=...
```

配对码 10 分钟有效，到点自动轮换；已在册的手机不受影响。

> `desktop` profile 由 Electron 独占，`dsh plugin` CLI 无法操作它，请用插件管理器安装。

### 2. 构建手机端

```bash
cd app
flutter pub get
flutter build apk --release --split-per-abi
```

三份按 CPU 架构拆开的包（v0.1.5 实测）：`app-arm64-v8a-release.apk`（12.9 MB，主流手机装这个）、`app-armeabi-v7a-release.apk`（12.1 MB，老设备）、`app-x86_64-release.apk`（13.4 MB，模拟器）。不拆包的单包约 17 MB。

> 只有「在手机上本机跑 dsh」那条路需要 proot 的二进制（`app/android/app/src/main/jniLibs/<abi>/lib*.so`），
> 它体积不小、且带 GPL 条款，所以不入库；要用先跑一次 `tools/proot-fetch.ps1` 现取。
> 只做远程操控的话，缺这几个文件也不影响构建与运行。

> 发布签名从 `app/android/key.properties` 读（模板见 `app/android/key.properties.example`）。
> 这两个文件与 keystore 都在 `.gitignore` 里：开源仓库不该带能签出「官方包」的私钥。
> 没有 `key.properties` 时回落到 debug 签名，只为让 `flutter run --release` 能跑，不能分发。
> 实测过的两条分支：无 key.properties → 构建成功（66.1 MB 单包）；有 key.properties + 自建
> keystore → `apksigner verify --print-certs` 显示的是 keystore 里的 DN，证明真走了 release 签名。
> 当前 v0.1.5 的 APK 用项目自建 keystore 签（`CN=Pocket Harness`，指纹见 [CHANGELOG.md](CHANGELOG.md)），
> 同一 key 的后续版本可覆盖安装。要发布到应用商店请换成自己的 keystore。

### 3. 配对

最省事的办法是打开 Harness 的 **设置 → 手机配对**，那一页会直接显示当前有效的二维码，每 10 分钟换一张。也可以在手机 App 里扫码（或把 `pocketharness://pair?...` 整串粘进去）。第一次连上会把电脑的公钥固定在手机上，之后不再需要配对码。

**扫一次就够了。** 配对码是扫码那一刻的快照，所以手机连上之后会向电脑要一张新票据（有效期 30 天，不含配对密钥）覆盖本地那张：电脑换了网络、或者中继是后来才配上的，下次出门时手机就能按新地址找到它——局域网走直连，出了局域网走中继，不用再扫一次。设置页那行副标题也会写明这张票是「可经中继」还是「仅局域网」。

二维码扫不出来时点旁边的「打开大图」，那是同一张码的整页版本（按模块数给足像素，每模块 6px）。

> 二维码页面只认本机回环地址与 `dsh-app:` 起源的请求，别的网站即使在你浏览器里打开也读不到这张码。不带 Origin 的请求（本机原生客户端）是放行的——它们本来就能伪造任意请求头，拦与不拦没有区别。

### 4.（可选）公网：跑自己的中继

```bash
cd relay
npm install
export POCKET_HARNESS_RELAY_TOKEN='<至少 16 字符的随机串>'
node run.mjs          # 监听 0.0.0.0:8080，GET /healthz 可探活
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `POCKET_HARNESS_RELAY_TOKEN` | 必填 | 少于 16 字符直接退出；Host 与中继共享它 |
| `PORT` | `8080` | 传 `0` 会打印内核分配的真实端口 |
| `HOST` | `0.0.0.0` | 放在反向代理后面时改成 `127.0.0.1` |

启动后打印 `relay listening on <host>:<port>`；`GET /healthz` 返回 `ok rooms=N`。
也可以直接用 release 里的包：`npm install ./pocket-harness-relay-0.1.5.tgz`。

#### 部署到自己的 VPS

**先决定这台机器对外开放什么端口。** 中继需要手机能访问到一个 WebSocket 地址，
用 443 最省事：防火墙只开 443，中继监听 `127.0.0.1:8080`，nginx 在 443 上按路径反代。
**不要让中继自己占对外端口**，否则要么多开防火墙条目，要么和已有站点抢 443。

**1. 上层依赖**

需要 Node ≥ 20、nginx、systemd。装 Node：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**2. 生成口令**

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

记下来。**同一个值要用两次**：一次给中继进程的环境变量，一次填进电脑上 Host 插件的
`relayToken`。它是两台机器互相认证的凭据，别提交进仓库、别粘进聊天记录。

**3. 放出中继文件并建 systemd 单元**

```bash
sudo mkdir -p /opt/pocket-harness-relay
cd /opt/pocket-harness-relay
sudo npm install ./pocket-harness-relay-0.1.5.tgz    # 或把仓库的 relay/ 整个拷上来再 npm install
```

```ini
# /etc/systemd/system/pocket-harness-relay.service
[Unit]
Description=Pocket Harness relay
After=network-online.target

[Service]
WorkingDirectory=/opt/pocket-harness-relay
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=8080
Environment=POCKET_HARNESS_RELAY_TOKEN=<第 2 步那个口令>
ExecStart=/usr/bin/node node_modules/pocket-harness-relay/run.mjs
Restart=always
NoNewPrivileges=yes
ProtectSystem=full
DynamicUser=yes

[Install]
WantedBy=multi-user.target
```

`HOST=127.0.0.1` 是关键：中继只听本机，外面进不来，入口只有 nginx 那个 443。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pocket-harness-relay
curl -s http://127.0.0.1:8080/healthz     # 应得 ok rooms=0
```

**4. nginx 在 443 上开一条子路径**

找已经监听 443 的那个 server 块（不是 `listen 80` 那个重定向块），往里面加：

```nginx
location = /ph-relay/healthz {
    proxy_pass http://127.0.0.1:8080/healthz;
    access_log off;
}

location /ph-relay {
    proxy_pass http://127.0.0.1:8080/relay;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_buffering off;
    proxy_cache off;
    proxy_next_upstream off;
}
```

`proxy_pass` 末尾那个 `/relay` 是前缀改写，不能少：中继自己的 WebSocket 路径就是
`/relay`，健康检查是 `/healthz`。少写了，握手会打到中继的 404 上，现象是「连上了但立刻
断」，日志里看不到原因。`/healthz` 必须单独一条，否则会被前缀改写带成 `/relay/healthz`。

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -s https://your.domain/ph-relay/healthz    # 应得 ok rooms=0
```

**5. 让电脑上的 Host 连上中继**

在 Harness 的 profile 配置里（`~/.dsh/profiles/<profile>/cordis.patch.yml`）加：

```yaml
- id: pocket-harness-host
  config:
    relayUrl: wss://your.domain/ph-relay
    relayToken: <第 2 步那个口令>
```

开关一次插件让它重载。日志里会出现 `joined the relay room`，设置页「手机配对」卡片上
「外网可达」变成「是（经中继）」。

**6. 自检（不需要手机）**

```bash
node probe/relay-ws-check.mjs      # 443 → nginx → 中继 的 WebSocket 升级
node probe/relay-e2e.mjs           # 经公网中继完成 Noise 握手并调用 session/list
```

第二条成功会打印 `THE PHONE CAN REACH THIS HOST THROUGH THE PUBLIC RELAY`。
它用的是运行中 Host 自己的配对票据，所以验的就是手机真正走的那条路。

> 上面这套形状在真实 VPS 上跑通过：只开 443、中继监听 `127.0.0.1:8080`、
> nginx 按子路径反代、手机从公网握手并读到会话。踩过的坑与逐阶段部署脚本
> （`probe / push / unit / nginx / verify`，主机全走环境变量）在
> [docs/relay-deployment.md](docs/relay-deployment.md)。

## 开发

```powershell
# Dart 协议层：49 个测试
cd packages\dsh_link; dart analyze; dart test

# Host 插件与中继：41 个测试
cd relay; npm install; cd ..      # 中继的测试会 import relay/server.mjs，它依赖 ws
node --test host

# Flutter 客户端：161 个测试
cd app; flutter analyze; flutter test
```

需要**运行中的 Harness** 的那一组（现场生成票据，Harness 没开会自动 skip）：

```powershell
cd packages\dsh_link; dart test tool/live_events_test.dart
```

金标向量来自 MIT 授权的 `ds-harness-remote` fixtures，用来证明我们的 Noise IK 与 AEAD 与参考实现**字节级**一致：

```powershell
node probe/aead_vector.mjs      # RFC 8439 向量
node probe/noise_vector.mjs     # 完整握手 + 传输密钥回放
```

TypeScript 版协议核心（鸿蒙 ArkTS 用同一份源码）有自己的一套断言，读的是**同一份** fixture：

```powershell
cd packages/dsh_arkts
npm test                        # 金标向量 + 帧/分片/信封/配对自检
```

需要**运行中的 Harness** 时，它还能跑一次真实握手：

```powershell
node probe/live-ticket.mjs      # 现场刷新配对码
cd packages/dsh_arkts; npm run test:live
```

配对码现在也能在 Harness 里直接看到，不用翻日志：装好本插件后打开**设置 → 手机配对**，
那张卡片画着当前的二维码，倒计时归零就自己换成下一个（每 10 分钟一次）。它读的是
`/api/pocket-harness/pair`，只对回环地址开放——手机扫的是屏幕，不是这个 URL。

二维码编码器（`host/qr_encode.js`）和配对页都是零依赖的，与 `packages/dsh_arkts` 里
的**解码器**互为正反：前者编出来的矩阵必须能被后者读回原文。

但「互为正反」本身证明不了什么：两边一起写错时，往返测试照样是绿的。设置页的码曾经
就是这样——版本信息块写成高位在前，解码器也按高位读，我们自己收发一致，手机和微信却
一片扫不出。所以真正管用的裁判是外部实现，`probe/qr-external-check.mjs` 拿 `qrcode` 包
逐格比对矩阵，装了 jsQR 时再让它读一遍渲染结果：

```powershell
node probe/qr-encode-check.mjs    # 编码 -> 解码往返，含 v7 以上的版本块
node probe/qr-external-check.mjs  # 与外部编码器逐格比对，并让 jsQR 读渲染结果
node probe/qr-scan-check.mjs      # 模块在屏幕上有多少像素才算扫得动
node probe/pair-page-check.mjs    # 设置卡片真正会拿到的票据
dart run --packages=app/.dart_tool/package_config.json probe/session-groups-check.dart
dart run --packages=app/.dart_tool/package_config.json probe/markdown-check.dart
dart run --packages=app/.dart_tool/package_config.json probe/highlight-check.dart
```

回复渲染那套（`markdown.dart` 解析、`code_highlight.dart` 着色、`widgets/markdown_body.dart` 上屏）
分三层，前两层是纯 Dart，所以解析与着色的 bug 不用 pump 一帧就能测；第三层用 widget 测试
断言「着色确实进了 `TextSpan`、流式确实有光标、完成的消息才可选」，因为截图看不出配色对不对。
两条不变量钉住了最容易出错的边界：未闭合的围栏必须仍算代码块（流式时每帧都是这个形态），
着色的片段拼回去必须与原文逐字节相同。

鸿蒙侧目前能跑通的界面（扫码配对、会话列表、对话页、审批、模型、技能、设置、文件、任务、计划、
图片、后台任务）都在探针工程里，用 `tools/ohos-probe/build.ps1` 一键编译出**已签名**的 HAP，
不需要华为账号 —— 签名用的是 OpenHarmony 公开 SDK 自带的那套材料（`hap-sign-tool.jar` +
`OpenHarmony.p12`），构建结束会自动校验（`verify: Verify success`）。它现在 `1189 KB`，
首页那个「解三张二维码金标」按钮会在设备运行时里
把解码器和相机帧路径（行填充、旋转、渐暗）一起走一遍。详见 [docs/harmony-packaging.md](docs/harmony-packaging.md)。


设计细节见 [docs/superpowers/specs/2026-11-20-pocket-harness-design.md](docs/superpowers/specs/2026-11-20-pocket-harness-design.md)。

CI 在 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)：四份独立作业分别跑 Dart 协议层、Host 插件与中继、TypeScript 协议层、Flutter 客户端（含 `flutter build apk --debug`）。第五份是鸿蒙打包，**手动触发**：它在 `windows-latest` 上检查有没有摆好的 OpenHarmony SDK，有就真编译并签名、把 HAP 当产物上传，没有就打印 SDK 的布局要求并失败（CI 上不缓存 3 GB SDK，所以没有替它下载）。详见打包文档。

### 发版

发布脚本只用 Node 的 HTTPS（理由见 [tools/publish-git.mjs](tools/publish-git.mjs) 顶部：本机 git 走 schannel，沙箱里拿不到客户端凭证）。先把要发的 APK 等产物放进 `dist/<tag>/`，连同 `RELEASE_NOTES.md` 一起，再让脚本算校验和：

```powershell
$env:POCKET_HARNESS_TOKEN_FILE = "probe/_gh_token.txt"   # 细粒度 PAT，需 Contents 读写
node tools/hash-release-dir.mjs dist/<tag>               # 写出 SHA256SUMS.txt
node tools/publish-git.mjs     --owner <账号> --branch master --tag <tag>
node tools/publish-release.mjs --owner <账号> --tag <tag>
```

`SHA256SUMS.txt` 由脚本算，不要手抄：手抄最容易漏改一行，而 `verify-release.mjs` 拿它跟服务端 digest 比对，漏改的那一行会让「校验通过」变成空话。

两个脚本都是幂等的：远端已经一致就跳过，release 已存在就只补缺失的附件。

**产物换了的时候不能只靠幂等**：同名附件已存在会被跳过，release 上就留着上一版的
APK，而 `SHA256SUMS.txt` 已经指向新的字节，两边对不上。换产物时按这个顺序来：

```powershell
node tools/reset-release-assets.mjs --owner <账号> --tag <tag>   # 先清空旧附件
node tools/publish-release.mjs      --owner <账号> --tag <tag>
node tools/verify-release.mjs       --owner <账号> --tag <tag>   # 把附件下回来重算
```

`verify-release.mjs` 优先拿 GitHub 返回的 `asset.digest` 比对，只有服务端没给 digest 才真把附件下回来算 sha256——而不是相信上传返回值。本机到 `github.com` 下载时经常连不上，能少一趟就少一趟。

`publish-git.mjs` 的分支与 tag 都走 git 线上协议的 `receive-pack`（传输层在 [tools/github-transport.mjs](tools/github-transport.mjs)），isomorphic-git 只用来遍历对象和打包：

- 它的 `push` 只处理 `refs/heads/*`，refspec 里写 `refs/tags/x:refs/tags/x` 会被**静默忽略**（返回体里连这个 ref 都不出现，而 `ok: true`）；REST 的建 ref 又要求 tag 对象先存在于远端。所以注解 tag 本体作为单对象 packfile 推上去——远端得到的 sha 与本地逐字节相同，`git clone --branch <tag>` 才对得上。
- 它在「远端已经一致、无事可做」时会挂着等超时，所以脚本先查远端 sha 再决定要不要推。

`github-transport.mjs` 之所以存在，是因为这台机器上 `github.com` / `api.github.com` 的默认 DNS 地址经常直接 reset 或超时，而同一个域名解析出的别的边缘地址是通的。它会把 DNS 结果和一份内置地址表合起来逐个 TLS 握手探活，只留下能连的再用；请求必须带显式 `Host:` 头，正文按 16 KiB 分片写（一次性 write 会被中途 reset）。

tag 指到旧提交时，`--force` 会覆盖远端：先 `git tag -d <tag>` 再 `git tag -a <tag> -m "Pocket Harness <tag>"`，别用 `git tag -f` 重打在同一提交上——那样 sha 会变而内容不变，白推一次。


## 安全

- 所有业务数据走 Noise IK（`Noise_IK_25519_ChaChaPoly_SHA256`）端到端加密；中继与局域网中间设备只见密文。
- 设备私钥只存在电脑的 DSH credentials 服务与手机的应用私有目录里，不进日志、不落明文文件。
- 对端公钥按设备固定，变化即拒绝握手，需人工确认才能重新配对。
- 手机上能改的指令文件按**真实路径**判定范围：项目里一个指向外部的目录链接不能用来把 `AGENTS.md` 写到项目外面——`resolve()` 只看字符串，链接要单独跟随。
- 工具审批沿用 Harness 自身语义：只有「允许一次」与「拒绝」，其余一律 fail-closed。
- 审批与提问由手机作为 owner Peer 抢占 DSH 的 `$events` 转发流；同一时刻只有一端能回答，答不上可以一键转回电脑。
- 明文 TCP 只承载密文帧；公网走 `wss://`。
- 分片消息按头部声明的总长**逐片结算**，超出上限（4 MiB）立即丢弃整条：缓冲量由声明约束，而不是由对端愿意发多少决定。
- 配对口令的校验走 `timingSafeEqual`：字符串 `!==` 会在第一个不同的字符处停下，可被计时逐步还原，而这串值一旦泄漏就能重放。
- 每条链路最多 16 条流，且**还在等网关回话的开流请求同样占名额**：上限在 await 之前就扣掉，否则一次并发请求会全部通过检查。
- 插件里每个「不等结果的 Promise」（建链路、记设备公钥、卸载时清理）都挂了拒绝处理：node 22+ 把未处理的拒绝当成致命错误，一条连不上来的链路不该让整个 Harness 退出。
- 卸载发生在「启动还没绑完端口」的那一刻时，那次启动会把自己绑到的监听器关掉：否则端口被一个没人持有的 socket 占到进程结束，下一次启动落到随机端口，配对码里的地址谁也连不上。
- 本机 dsh 的原生层在订阅断开期间最多攒 2000 行输出，超出就丢最旧的并在补发时说明：`npm install -g` 会打上万行、跑二十分钟，没有上限的话一次切后台就是一路涨到进程结束。

发现安全问题请私下联系维护者，不要先开公开 issue。

## 许可

MIT，见 [LICENSE](LICENSE)。第三方归属见 [NOTICE](NOTICE)。

本项目的名称、图标与界面素材均为原创，与 `dsh-Go` 项目及其素材无关；本项目也未使用该项目的 AGPL 代码。
