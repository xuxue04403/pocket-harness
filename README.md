# Pocket Harness

Drive a DeepSeek Harness running on your computer from your phone, over an end-to-end encrypted link.

The computer keeps the workspace, the agent runtime and the session history. The phone is a window onto it: pair
once by scanning a code, then list sessions, read transcripts, and send prompts from anywhere on the same network —
or across the internet through a relay you run yourself.

Nothing is stored on anyone else's server. There is no account system, no hosted broker and no telemetry.

```
 phone (Flutter)                                computer (DeepSeek Harness)
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

## What works today

| 能力 | 状态 |
|---|---|
| 配对（扫码 / 粘贴配对码） | ✅ 一次性携带公钥与端点，天然 TOFU |
| 局域网直连 | ✅ TCP + Noise IK |
| 公网中继（自建） | ✅ 双方出站，中继只见密文 |
| 会话列表、历史、新建会话 | ✅ |
| 发送提示词、抢断、停止 | ✅ |
| 运行中逐字流式显示 | ✅ 思考与正文分栏 |
| 工具调用与结果卡片 | ✅ |
| Android | ✅ 模拟器与构建均通过 |
| HarmonyOS 7.0 | ⏳ 二期，见 [docs/harmony-packaging.md](docs/harmony-packaging.md) |
| WebRTC P2P / TURN | ⏳ 二期（局域网直连 + 中继已覆盖当前场景） |

## Repository layout

| 目录 | 内容 |
|---|---|
| [`app/`](app) | Flutter 客户端（Android 已通；鸿蒙共用同一套 Dart） |
| [`packages/dsh_link/`](packages/dsh_link) | 纯 Dart 协议核心：Noise IK、分片、信封、RPC、双传输 |
| [`host/`](host) | DSH Host 插件，零运行时依赖的 ESM |
| [`relay/`](relay) | 极简中继，只做房间配对与密文转发 |
| [`docs/`](docs) | 设计文档与打包说明 |
| [`probe/`](probe) | 诊断脚本（金标向量回放、真实 Harness 探测） |

## Quick start

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
flutter build apk --release
```

### 3. 配对

用手机扫码（或把 `pocketharness://pair?...` 整串粘进去）。第一次连上会把电脑的公钥固定在手机上，之后不再需要配对码。

### 4.（可选）公网：跑自己的中继

```bash
cd relay
npm install
$env:POCKET_HARNESS_RELAY_TOKEN = "<至少 16 字符的随机串>"
node run.mjs          # 监听 8080，/healthz 可探活
```

然后在 Host 插件的配置里设置 `relayUrl`（例如 `wss://relay.example.com/relay`）并重启 Harness。之后手机在局域网内会直连，出了局域网就自动走中继。中继只转发密文，也看不到你的 token。

## 开发

```powershell
# Dart 协议层：38 个测试
cd packages\dsh_link; dart analyze; dart test

# Host 插件与中继：11 个测试
node --test host

# Flutter 客户端：11 个测试
cd app; flutter analyze; flutter test
```

金标向量来自 MIT 授权的 `ds-harness-remote` fixtures，用来证明我们的 Noise IK 与 AEAD 与参考实现**字节级**一致：

```powershell
node probe/aead_vector.mjs      # RFC 8439 向量
node probe/noise_vector.mjs     # 完整握手 + 传输密钥回放
```

设计细节见 [docs/superpowers/specs/2026-11-20-pocket-harness-design.md](docs/superpowers/specs/2026-11-20-pocket-harness-design.md)。

## Security

- 所有业务数据走 Noise IK（`Noise_IK_25519_ChaChaPoly_SHA256`）端到端加密；中继与局域网中间设备只见密文。
- 设备私钥只存在电脑的 DSH credentials 服务与手机的应用私有目录里，不进日志、不落明文文件。
- 对端公钥按设备固定，变化即拒绝握手，需人工确认才能重新配对。
- 工具审批沿用 Harness 自身语义：只有「允许一次」与「拒绝」。
- 明文 TCP 只承载密文帧；公网走 `wss://`。

发现安全问题请私下联系维护者，不要先开公开 issue。

## License

MIT，见 [LICENSE](LICENSE)。第三方归属见 [NOTICE](NOTICE)。

本项目的名称、图标与界面素材均为原创，与 `dsh-Go` 项目及其素材无关；本项目也未使用该项目的 AGPL 代码。
