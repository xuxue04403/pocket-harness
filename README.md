# Pocket Harness

用手机操控跑在电脑上的 DeepSeek Harness，链路端到端加密。

**当前版本：v0.1.0-beta**（范围只有「远程操控电脑」，更新记录见 [CHANGELOG.md](CHANGELOG.md)）

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
| 配对（扫码 / 粘贴配对码） | ✅ 一次性携带公钥与端点，天然 TOFU |
| 局域网直连 | ✅ TCP + Noise IK |
| 在手机上本机跑 dsh | ⏳ 未开启：PRoot + Alpine 已经实证能跑（`dsh web` 返回 200），但 1.6 GB rootfs 的下载与续传还没打磨，beta 默认不露出入口，见 docs/mobile-local-dsh.md |
| 公网中继（自建） | ✅ 双方出站，中继只见密文；配 `relayUrl` + `relayToken` 即启用 |
| 会话列表、历史、新建会话 | ✅ 新建时可挑智能体预设与工作目录；长按可改名 |
| 链路保活（心跳） | ✅ 静默断线 10 秒内报错，不会一直转圈 |
| 查找会话（标题、目录、正文） | ✅ 830 个会话也能定位；正文检索随 Host 配置，关掉时仅按标题目录 |
| 按会话切换模型与思考强度（含网关模型） | ✅ 只影响当前会话，可回退默认 |
| 查看与修改电脑的全局默认模型 | ✅ 带 revision 校验，电脑上改了会拒绝覆盖 |
| 发送提示词、抢断、停止 | ✅ |
| 运行中逐字流式显示 | ✅ 思考与正文分栏 |
| 工具调用与结果卡片 | ✅ |
| 工具审批与提问（在手机上回答） | ✅ 拒答即 fail-closed，也可转回电脑 |
| 发送与查看图片 | ✅ 从相册选图随消息发出，历史里的图片按需取回 |
| 浏览工作区文件 | ✅ 按目录翻、按名字搜、按行读文本，只读 |
| 后台任务 | ✅ 看会话跑的每条命令、跟随实时输出、可远程终止 |
| 待办面板 | ✅ 贴在对话上方，显示完成进度与当前项，可折叠 |
| 会话分支 | ✅ 从当前会话分出一个副本，两边并行不互相影响 |
| Android | ✅ 模拟器与构建均通过 |
| HarmonyOS 7.0 | 🟡 配对 → 会话列表（含新建会话）→ 对话页（含审批、提问、模型切换与技能插入）→ 电脑设置（改全局默认模型）→ 工作区文件（列目录、搜索、分页读）→ 发送图片（相册选图随消息发出）→ 历史图片缩略图（按需取回、按 attachmentId 缓存）→ 后台任务（看会话跑的命令、跟随输出、终止）→ agent 计划面板（进度与当前一步）已在 ArkTS 里跑通，局域网与中继两条路都能连，能编出 HAP；扫码配对**已接通系统相机**：鸿蒙 SDK 没有条码接口，本仓库自己写了解码器（格式位、Reed-Solomon、定位图案、仿射采样），首页「扫二维码」按钮会调系统相机拍一张再解出配对码，粘贴配对码作为兜底，见 [docs/harmony-packaging.md](docs/harmony-packaging.md) |
| WebRTC P2P / TURN | ⏳ 二期（局域网直连 + 中继已覆盖当前场景） |

## 仓库结构

| 目录 | 内容 |
|---|---|
| [`app/`](app) | Flutter 客户端（Android 已通；鸿蒙共用同一套 Dart） |
| [`packages/dsh_link/`](packages/dsh_link) | 纯 Dart 协议核心：Noise IK、分片、信封、RPC、双传输 |
| [`packages/dsh_arkts/`](packages/dsh_arkts) | 同一套协议的 TypeScript 版，供鸿蒙 ArkTS 使用；金标向量、真实 Host 与真实中继三条链路均实测通过；另有纯 ArkTS 的二维码解码器 |
| [`tools/ohos-probe/`](tools/ohos-probe) | 鸿蒙 ArkTS 宿主工程（配对码页、会话列表与新建面板、对话页、审批条、模型面板、技能面板、电脑设置页、工作区文件页、图片选择与历史缩略图、后台任务页、agent 计划面板、从剪贴板粘贴配对码、扫码配对（系统相机拍一张）、二维码金标与相机帧自检），Windows 上可产出已签名 HAP（用 SDK 自带的签名材料，不需要华为账号） |
| [`host/`](host) | DSH Host 插件，零运行时依赖的 ESM |
| [`relay/`](relay) | 极简中继，只做房间配对与密文转发 |
| [`tools/proot-dsh/`](tools/proot-dsh) | 在手机上本机跑 dsh 的安装与自检脚本（PRoot + Alpine + Node 24） |
| [`docs/`](docs) | 设计文档与打包说明 |
| [`probe/`](probe) | 诊断脚本（金标向量回放、真实 Harness 探测） |

## 快速开始

### 1. 在电脑上装 Host 插件

需要 DeepSeek Harness 0.2.2 或更新的版本。

在 Harness 的插件管理器里选择「安装本地目录」，指向本仓库的 `host/`。装好后 Harness 日志里会出现：

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

三份按 CPU 架构拆开的包（v0.1.0-beta 实测）：`app-arm64-v8a-release.apk`（12.3 MB，主流手机装这个）、`app-armeabi-v7a-release.apk`（11.5 MB，老设备）、`app-x86_64-release.apk`（12.9 MB，模拟器）。不拆包的单包约 17 MB。

> 发布签名从 `app/android/key.properties` 读（模板见 `app/android/key.properties.example`）。
> 这两个文件与 keystore 都在 `.gitignore` 里：开源仓库不该带能签出「官方包」的私钥。
> 没有 `key.properties` 时回落到 debug 签名，只为让 `flutter run --release` 能跑，不能分发。
> 实测过的两条分支：无 key.properties → 构建成功（66.1 MB 单包）；有 key.properties + 自建
> keystore → `apksigner verify --print-certs` 显示的是 keystore 里的 DN，证明真走了 release 签名。
> 当前 v0.1.0-beta 的 APK 用项目自建 keystore 签（`CN=Pocket Harness`，指纹见 [CHANGELOG.md](CHANGELOG.md)），
> 同一 key 的后续版本可覆盖安装。要发布到应用商店请换成自己的 keystore。

### 3. 配对

用手机扫码（或把 `pocketharness://pair?...` 整串粘进去）。第一次连上会把电脑的公钥固定在手机上，之后不再需要配对码。

### 4.（可选）公网：跑自己的中继

```bash
cd relay
npm install
$env:POCKET_HARNESS_RELAY_TOKEN = "<至少 16 字符的随机串>"
node run.mjs          # 监听 8080，/healthz 可探活
```

然后在 Host 插件的配置里设置 `relayUrl`（例如 `wss://relay.example.com/relay`）与 `relayToken`（就是上面那个 `POCKET_HARNESS_RELAY_TOKEN` 的值）并重启 Harness。之后手机在局域网内会直连，出了局域网就自动走中继。中继只转发密文，解不开任何一帧。

## 开发

```powershell
# Dart 协议层：46 个测试
cd packages\dsh_link; dart analyze; dart test

# Host 插件与中继：13 个测试
node --test host

# Flutter 客户端：120 个测试
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

鸿蒙侧目前能跑通的界面（扫码配对、会话列表、对话页、审批、模型、技能、设置、文件、任务、计划、
图片、后台任务）都在探针工程里，用 `tools/ohos-probe/build.ps1` 一键编译出**已签名**的 HAP，
不需要华为账号 —— 签名用的是 OpenHarmony 公开 SDK 自带的那套材料（`hap-sign-tool.jar` +
`OpenHarmony.p12`），构建结束会自动校验（`verify: Verify success`）。它现在 `1189 KB`，
首页那个「解三张二维码金标」按钮会在设备运行时里
把解码器和相机帧路径（行填充、旋转、渐暗）一起走一遍。详见 [docs/harmony-packaging.md](docs/harmony-packaging.md)。


设计细节见 [docs/superpowers/specs/2026-11-20-pocket-harness-design.md](docs/superpowers/specs/2026-11-20-pocket-harness-design.md)。

CI 在 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)：四份独立作业分别跑 Dart 协议层、Host 插件与中继、TypeScript 协议层、Flutter 客户端（含 `flutter build apk --debug`）。第五份是鸿蒙打包，**手动触发**：它在 `windows-latest` 上检查有没有摆好的 OpenHarmony SDK，有就真编译并签名、把 HAP 当产物上传，没有就打印 SDK 的布局要求并失败（CI 上不缓存 3 GB SDK，所以没有替它下载）。详见打包文档。

## 安全

- 所有业务数据走 Noise IK（`Noise_IK_25519_ChaChaPoly_SHA256`）端到端加密；中继与局域网中间设备只见密文。
- 设备私钥只存在电脑的 DSH credentials 服务与手机的应用私有目录里，不进日志、不落明文文件。
- 对端公钥按设备固定，变化即拒绝握手，需人工确认才能重新配对。
- 工具审批沿用 Harness 自身语义：只有「允许一次」与「拒绝」，其余一律 fail-closed。
- 审批与提问由手机作为 owner Peer 抢占 DSH 的 `$events` 转发流；同一时刻只有一端能回答，答不上可以一键转回电脑。
- 明文 TCP 只承载密文帧；公网走 `wss://`。

发现安全问题请私下联系维护者，不要先开公开 issue。

## 许可

MIT，见 [LICENSE](LICENSE)。第三方归属见 [NOTICE](NOTICE)。

本项目的名称、图标与界面素材均为原创，与 `dsh-Go` 项目及其素材无关；本项目也未使用该项目的 AGPL 代码。