# Pocket Harness — 移动端远程操控 DSH 设计文档

日期：2026-11-20（v3，已按实现同步）
状态：已实现 M1–M5
作者：Claude（与用户协作）

## 0. 与 v1 的差异

用户在 m00447 明确：**为防止数据泄密，先参考这些 GitHub 项目重写一个 Host 插件**，然后本机安装做联调。
这否定了 v1 的"直接用现成 ds-harness-remote 插件"方案。好处是链路两端都由我们掌控，协议可以大幅简化，且默认不需要信任任何第三方服务器。

## 0.1 已确认的决策（m00447 / m00449 / m00503 / m00851）

| 决策 | 选择 |
|---|---|
| Host 来源 | **自研** `host/` 插件（数据不经第三方） |
| 业务层 | **直接透传** DSH 的 `ctx.typertGateway`（客户端天然拥有桌面端全部能力） |
| 传输 | **局域网直连 + 自建中继**（WebRTC 留二期） |
| 配对 | **二维码扫码配对**（也可粘贴配对码文本） |
| 鸿蒙 | 先 Android 打通，鸿蒙二期（同一套 Dart 代码） |
| 配置 | 全局默认生效 + 每次置顶可显式覆盖；数据可放 harness 配置或 AGENTS 类文件，支持多个 skill |

## 1. 目标与非目标

### 1.1 目标（按用户优先级）

1. **P0 远程操控**：手机连接并操控运行在 PC（或服务器）上的 DeepSeek Harness，局域网与公网都要能用。
2. **P1 鸿蒙优先**：鸿蒙 7.0（API 26）为第一目标平台，Android 紧随其后。
3. **数据自主**：端到端加密；默认不经过任何第三方服务器；中继服务器可由用户自建。
4. **P2 本机运行**：最终能在手机上直接跑 dsh 引擎（第一期不做，见 §9）。
5. **开源**：新仓库、原创名称与素材，不复制 AGPL 代码，只借鉴 MIT 协议的设计思路。

### 1.2 非目标（第一期不做）

- WebRTC（P2P / TURN）。第一期用「局域网直连 + 自建中继」覆盖用户场景，WebRTC 二期再加。
- 多账号、设备管理后台、应用市场发布。
- 移动端本机跑 dsh 引擎。

## 2. 可行性结论（已实测）

| 能力 | 本机（Windows） | 证据 |
|---|---|---|
| Dart 3.14.0 / Flutter 3.50.1 | ✅ | `dart --version` ok |
| Android 模拟器 | ✅ | AVD `phone35`（android-35 x86_64），已跑通全流程 |
| Android 构建 | ✅ | SDK 35 + build-tools 35 + JDK 21；`flutter build apk --debug` 产出 181 MB APK |
| Windows 桌面构建 | ✅ | VS Build Tools 2026 18.1 |
| Node / pnpm（Host 插件开发） | ✅ | Node 26.8.1、pnpm 9.10.0 |
| ArkTS 真编译（出未签名 HAP） | ✅ 需下载 3.2GB OpenHarmony SDK | dsh-Go 的 `check-arkts.sh` 证明免登录可行 |
| **Flutter 鸿蒙 AOT** | ❌ **需要 macOS arm64** | dsh-Go `app/ohos/README.md`：`gen_snapshot` 只发 macOS 版 |

**结论**：鸿蒙优先 ≠ 鸿蒙可本地构建。第一期先把**协议与 UI 在 Android/Windows 上跑通**，鸿蒙作为同一套 Dart 代码的第二个打包目标（见 `docs/harmony-packaging.md`）。用户已确认此安排（m00449）。

### 2.1 构建踩过的坑（Windows）

- Gradle wrapper 无法自下载 `gradle-9.5.0-all.zip`（TLS 连接被重置）。手工放到 `%USERPROFILE%\.gradle\wrapper\dists\gradle-9.5.0-all\<hash>\` 并建 `.zip.ok` 标记即可。
- Windows 上 Kotlin 增量缓存会报 `Could not close incremental caches`。在 `app/android/gradle.properties` 里加 `kotlin.incremental=false`。
- `flutter pub add` 会警告 `Building with plugins requires symlink support`（需开发者模式）；不影响 `analyze`，构建 APK 也不需要。

## 3. 架构

### 3.1 总览

```
┌─────────────── 手机客户端 ─────────────────┐        ┌────────── PC（Host）──────────┐
│  app/  Flutter（Android 已通 / 鸿蒙二期）    │        │  DSH Desktop / CLI            │
│  ┌─────────────────────────────────────┐  │        │  └─ dsh-pocketharness-host    │
│  │ packages/dsh_link（纯 Dart 协议核心） │  │        │     ├─ Noise IK 安全通道      │
│  │  NoiseIK · 分片 · RPC · 双传输       │  │◄──────►│     ├─ TCP Server（局域网）   │
│  └─────────────────────────────────────┘  │  加密   │     └─ Relay Client（公网）   │
└───────────────────────────────────────────┘        │           │                   │
                     ▲                               │           ▼                   │
                     │                               │   ctx.typertGateway.invoke()  │
                     │ 公网时                         │   （DSH 官方 RPC 网关）        │
              ┌──────┴───────┐                       └───────────────────────────────┘
              │ relay/       │  自建中继（Node，单文件，可 Docker）
              │  只转发密文   │
              └──────────────┘
```

### 3.2 四个自有组件

| 组件 | 语言 | 职责 | 实际规模 |
|---|---|---|---|
| `host/` | JS（DSH 插件，ESM） | 接 `ctx.typertGateway`，暴露成加密 TCP 服务；局域网监听 + 出站中继 | ~2000 行，**零运行时依赖** |
| `relay/` | JS（Node） | 极简密文转发 + 房间配对；部署在用户自己的 VPS | ~300 行 |
| `packages/dsh_link` | Dart | 客户端协议核心：Noise IK、分片、信封、RPC、双传输 | ~2500 行 |
| `app/` | Flutter/Dart | UI：配对、连接、会话列表、对话、工具卡片 | ~2000 行 |

### 3.3 为什么协议可以大幅简化

`ds-harness-remote` 的 v1 协议有 1883 行，因为它要兼容 4 种传输（LAN/P2P/TURN/Relay）、多版本 DSH、多客户端（Desktop/Browser/Android/iOS/TUI）、托管多租户服务器。我们两端自研，第一期只需：

- **2 种传输**：局域网直连（Host 监听） + 中继（双方出站）。
- **1 个 Host 版本**：跟本机 DSH 0.2.2-rc.5 对齐。
- **1 个客户端形态**：手机 App。

因此协议只需要：配对 → 连接 → Noise IK 握手 → 加密信封 → 调用 `typertGateway`。

**关键简化**：业务层不做二次建模，直接把 `namespace/method` 与 `args` 透传给 `ctx.typertGateway.invoke/stream`。DSH 自己的 Web UI 走的就是这条路，所以客户端天然拥有和桌面端完全一样的能力，Host 侧不需要知道任何业务语义。

### 3.4 安全模型

| 项 | 设计 |
|---|---|
| 身份 | 每台设备一对 X25519 静态密钥。Host 在插件首次启用时生成，存 DSH 的 credentials 服务记录 `dsh-pocketharness-host/identity`（不落明文文件）；手机存 SharedPreferences 的应用私有目录 |
| 配对 | Host 在日志里打印 `pocketharness://pair?t=…`（10 分钟有效，到点自动轮换）；手机扫码或粘贴，一次携带 Host 公钥、端点与配对 secret，天然完成 TOFU |
| 握手 | Noise IK（`Noise_IK_25519_ChaChaPoly_SHA256`），Initiator=Client，Responder=Host |
| Prologue | 绑定 `DSH-REMOTE\0v=1\0connection=<id>\0host=<hostId>\0client=<clientId>`，防止连接被换绑（沿用该前缀以复用已通过的金标向量） |
| 传输加密 | 握手后所有帧 ChaCha20-Poly1305，counter 单调递增，防重放 |
| 中继可见性 | 中继只看到 `{room, token, counter, ciphertext}`，**无明文、无业务元数据**（房间号是随机量；token 只在配对码里、且 10 分钟轮换） |
| 局域网 | 明文 TCP 承载密文帧，与 TLS 正交 |
| 日志 | 永不记录：密钥、token、提示词正文、工作区路径、工具输出正文。只记阶段/耗时/计数 |
| 权限 | 与 DSH 一致：工具审批只有「允许一次」「拒绝」 |

**与 ds-harness-remote 的关系**：借鉴其 Noise IK prologue 绑定思路、分片帧格式（DSHF）与「Host 只出站」的网络模型（均为 MIT）。不复制其代码，也不使用其服务器、WebRTC 栈与托管账号体系。金标向量取自其 MIT 授权的 fixtures，用于证明我们的实现字节级兼容。

## 4. 协议（v1，已实现）

以下为实际落地的协议，与代码逐条对应。

### 4.1 传输层

两条路径共享同一个 `FrameTransport` 接口，因此 Noise、RPC、UI 代码只有一份。

- **局域网直连**（先试）：Host 在 `0.0.0.0:<port>`（默认 `48100`）`listen` TCP，绑定端口可配。
  - 帧格式：`[uint32 big-endian 长度][payload]`，长度上限 `4 MiB + 64`（`host/framed-socket.js`、`packages/dsh_link/lib/src/transport/socket_transport.dart`）。
  - 设 `TCP_NODELAY`；`MAX_CONNECTIONS = 8`。
- **中继**（局域网都不通时）：Host 与手机各自**出站**连接 `ws://`/`wss://<relay>/relay`，中继只做配对与双向转发。
  - 首帧必须是**文本** hello：Host 侧 `{v:1, role:'host', room, token}`，手机侧同上但 `role:'client'`。
  - 中继回 `{v:1, ok:true, role, paired}`；两端齐了各推 `{v:1, type:'ready'}`。一方断开给幸存方推 `{v:1, type:'peer-gone'}`。
  - 回执分两件事：`{v:1, ok:true, ...}` 表示**已进房**（此时可以一直等手机，不算超时）；`{v:1, type:ready}` 才表示**手机也到了**。把两者混为一谈会让一个空房间每 15 秒自我重连一次。
  - 之后 WebSocket 的**每条二进制消息就是一整帧**，不再加长度前缀。
  - 一个房间只容纳一个 host 与一个 client；第二个 client 以 `4409` 关闭；join 超时 10 秒关 `4408`。
  - 中继侧限制：`MAX_FRAME_BYTES = 4 MiB + 64`、`MAX_BUFFERED_BYTES = 8 MiB`、`ROOM_IDLE_MS = 60s`。
  - token 用 `timingSafeEqual` 比对；它是**中继启动时配置的那一个**，由 Host 从自身配置读出、写进配对码，因此手机也持有同一份——它只用来进房，解密仍然只靠 Noise。

### 4.2 帧类型与分片

`FrameKind`：`handshake = 1`、`secure = 2`、`fragment = 3`、`control = 4`。

- 明文 `control` 帧只用于连接最初的一句 hello（见 §4.5）；握手完成后再收到 `handshake` 帧即视为协议错误。
- 单条加密消息上限 `48 KiB`（`MAX_SEALED_PAYLOAD`）。超过则切分片：
  - 头 17 字节：magic `'DSHF'`(4) + version(1) + messageId(4) + index(2) + total(2) + totalBytes(4)，全大端。
  - 重组上限 `4 MiB`；并发重组最多 `8` 条，超限丢最旧的 partial；分片形状前后不一致直接报错。

### 4.3 握手（Noise IK）

1. Client → Host：`e, es, s(加密), ss` + payload。
2. Host → Client：`e, ee, se` + payload。

- 套件固定为 `Noise_IK_25519_ChaChaPoly_SHA256`；Initiator=Client，Responder=Host。
- **payload 段永远存在**，即使长度为 0 也会产生 16 字节 AEAD tag——省略它会让对端解密失败，而报错文本只谈 authentication，极易误判。
- Prologue 见 §3.4。
- 握手完成后每条消息用一个 12 字节 nonce（其中低 8 字节是该方向的单调计数器）。
- 两侧实现字节级互通，并被 `ref/ds-harness-remote/fixtures/crypto/v1/noise-ik.json` 的金标向量固定：
  - Dart：`packages/dsh_link/test/noise_ik_test.dart`
  - JS：`probe/noise_vector.mjs`

### 4.4 应用层信封（密文内）

```json
{"v":1,"id":"<请求 id>","type":"request|response|error|event|ping|pong",
 "timestamp":1730000000000,"payload":{...}}
```

- `request` 的 payload 是 `{endpoint, payload:{args}}`，`endpoint` 形如 `session/list`。
- **业务方法直接透传** `ctx.typertGateway`：Host 侧把 `namespace/method` 与 `args` 原样交给 `invoke`/`stream`，不建模、不白名单、不解释语义。因此手机端天然拥有桌面端的全部能力，DSH 每次新增 Remote 方法都不需要我们改代码。
- 链路自身的控制端点只有两个，命名空间 `link/` 与 DSH 的业务命名空间不会冲突：
  - `link/stream.open`，args `{endpoint, args}` → `{streamId}`
  - `link/stream.close`，args `{streamId}`
- 流帧：`{streamId, hasValue:true, value}` / `{streamId, done:true}` / `{streamId, done:true, error:{code,message,details}}`。每连接最多 16 条并发流。
- `ping` → `pong` 原样回传 payload。

### 4.5 配对与准入

1. Host 插件在启动时以及每 10 分钟打印一次配对码：`pocketharness://pair?t=<base64url JSON>`。
   字段：`v` / `id`(hostDeviceId) / `key`(hostPublicKey) / `name` / `lan`(端点数组) / `relay` / `room` / `rtok` / `secret` / `exp`。
2. 手机扫码或粘贴该字符串，**一次拿到 Host 公钥、LAN 端点、中继坐标与配对 secret**，不需要查询任何服务器。
3. 连接第一帧（明文 `control`）是 hello：`{v:1, connection:<uuidv7>, client:<clientDeviceId>, proof}`。
   - `proof = base64url(HMAC-SHA256(secret, "v1\0<connectionId>\0<clientDeviceId>"))`；**secret 本身不过线**。
4. Host 回 `{v:1, accepted:true, host, name}`，或 `{v:1, accepted:false, reason}`，`reason ∈ {not-paired, pairing-expired, bad-proof}`。
5. 通过后立刻进入 Noise IK；握手成功时若该手机是首次连接，则把它的静态公钥**固定**下来（TOFU）。此后该设备不再需要 secret，secret 轮换也不影响已配对设备。
6. 已配对设备再次连接时，Host 用固定公钥做 `expectedRemoteStatic` 校验，不符即 `PEER_IDENTITY_MISMATCH`。

**为什么用二维码而不是配对码**：二维码一次性携带公钥与端点，天然完成 TOFU，避免了"输入码 → 查询服务器 → 拿到公钥"这一中间人可插入的环节。这是对 ds-harness-remote 配对码方案的改进。

### 4.6 业务层接法（Host 侧）

```
LinkServer ── Link ── SecureChannel ── RpcServer ── new Peer(ctx, {principal:{kind:'owner'}, interactions:'answer'})
                                                            │
                                                            └── ctx.typertGateway.invoke({namespace, method, args, peer})
```

- `Peer` 从 `ctx.get('connection').createPeer(...)` 取得（`@deepseek-ai/dsh-client-connection` 的正规入口），插件卸载时 `dispose()`。
- 用 `owner` 身份是**安全上的自觉选择**：DSH 的 `PeerScope` 注释明确写着"调用方身份在创建时由进程内 Host 代码固定，任何线路字段都无法设置它"。因此手机端能不能当主人，完全由我们自己的准入（配对 secret + Noise 固定公钥）负责。

### 4.7 一个易错的 DSH 约定

`typertGateway` 按方法签名里的**参数名**精确匹配，不能猜：

| 端点 | 参数名 |
|---|---|
| `session/list` | `{_request: {}}`（注意下划线） |
| `session/create` / `prompt` / `follow` / `page` / `cancel` / `rename` / `selectModel` / `projections` / `state` / `attachment` / `search` | `{request: {...}}` |
| `session/modelCatalog` | `{}`（无参数） |
| `skills/list` | `{request: {sessionId}}` |
| `agentPresets/list` | `{}`（命名空间是 camelCase，不是 `agent-preset`） |
| `settings/describe` | `{}` |
| `settings/update` | `{ns, patch, expectedRevision}`（**无** `request` 包装） |
| `job/list` / `job/follow` / `job/kill` | `{request: {sessionId, ...}}` |
| `workspaceFiles/list` / `read` / `search` | `{workspaceFileScopeId, path, range?}`，**扁平命名参数，无 `request` 包装** |

三个额外的坑：

- `session/follow` 与 `session/observeEvent` 不带 `activate: true` 时**永远不产出帧**（DSH 有意不让“跟随”唤醒空闲 Agent）；`assistantStream: true` 才会推逐字增量。
- `workspaceFiles/list` 的根目录必须传 `'.'`，传空串会被 Host 以 `path is required` 拒绝；`workspaceFileScopeId` 传的是 **Session id**，Host 自己据会话推出工作区根，所以手机只能看会话拥有的目录。
- `job/list` 是不会结束的整集流：读一次要用 `.first` 而不是 `toList()`，否则永远挂着。

## 5. 验证策略与实际结果

| 层 | 验证物 | 手段 | 结果 |
|---|---|---|---|
| L1 字节级 | Noise 握手、分片、信封、AEAD | 金标向量 + RFC 8439 官方向量 | ✅ `dart test` / `node probe/aead_vector.mjs` / `node probe/noise_vector.mjs` |
| L2 协议级 | Host ↔ Dart 完成握手 + RPC | 真 Host 桩 + 集成测试 | ✅ `link_integration_test.dart`、`plugin_integration_test.dart` |
| L3 真实业务 | 列出会话、读历史、发消息 | 对运行中的 Harness 调用 | ✅ `live_harness_test.dart`；模拟器上真实收发 |
| L3b 实时任务 | 后台任务名单与输出 | 对运行中的 Harness 调 `job/list`、`job/follow` | ✅ `probe_job_follow_test.dart`；模拟器上看到名单与输出 |
| L4 UI | 端到端 | Android 模拟器 `phone35` | ✅ 配对→列表→会话→逐字流式→文件→任务→设置 |
| L5 公网 | 经中继 | 本机中继 + `relayToken` 配进 profile，手机**只带中继坐标**连接 | ✅ `plugin_relay_integration_test.dart`（真实插件）、`tool/live_relay_test.dart`（真实 DSH `session/list`，854 会话）、模拟器显示「经中继」 |

**回归命令**：

```powershell
# Dart 协议层（38 例）
cd packages\dsh_link; dart analyze; dart test

# Host 插件与中继（13 例）
node --test host

# Flutter 客户端（11 例）
cd app; flutter analyze; flutter test
```

`packages/dsh_link/tool/` 下另有若干探针脚本，需要运行中的 Harness 与新鲜票据，因此不放进默认套件。

## 6. 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | `packages/dsh_link` 协议核心 | ✅ 金标向量全绿（Noise、分片、信封、AEAD） |
| M2 | `host/` 插件 + 局域网直连 | ✅ 已装进 desktop profile，真机 Hello + Noise + RPC 通 |
| M3 | 透传 `typertGateway` | ✅ 能列真实会话、读历史、发消息并收流式回复 |
| M4 | Flutter UI | ✅ 模拟器完成「配对→连接→会话列表→对话→发消息」闭环 |
| M5 | 中继 + 公网 | ✅ 模拟器与 Host 经本机中继互通 |
| M6 | 鸿蒙打包路径 | ⏳ 只有文档与结论，需 macOS/CI 实跑 |

## 7. 目录结构（实际）

```
D:\IDE\dsh-bot\
├─ app\                       Flutter 客户端（Android 已通；鸿蒙二期）
│  └─ lib\src\
│     ├─ app.dart             应用入口与主题
│     ├─ storage\             设备身份与已配对 Host 的本地存储
│     ├─ dsh\                 HostLink（DSH 调用封装）与 transcript 构建
│     └─ pages\               hosts / scan / paste / sessions / chat
├─ packages\dsh_link\         纯 Dart 协议核心
│  ├─ lib\src\crypto\         curve25519, chacha20_poly1305, noise_ik
│  ├─ lib\src\wire\           codec, frame, fragment
│  ├─ lib\src\transport\      socket_transport, relay, secure_channel, lan_client, loopback
│  ├─ lib\src\rpc\            envelope, rpc_client
│  ├─ lib\src\pairing\        pairing（票据 + 设备身份）
│  ├─ test\                   7 个稳定套件
│  └─ tool\                   探针脚本（需运行中的 Harness）
├─ host\                      DSH Host 插件（零依赖 ESM）
├─ relay\                     自建中继（Node + ws）
├─ probe\                     诊断脚本与样本
├─ docs\                      设计文档与说明
├─ ref\                       参考仓库（不参与构建，不入库）
├─ toolchain\                 本地工具链（不入库）
└─ tools\                     生成脚本
```

## 8. 安全不变量（实现中必须遵守）

1. 私钥只进 DSH credentials 服务或应用私有存储，**永不落明文日志、永不进日志**。
2. 对端公钥按设备固定，变化即拒绝握手，需用户显式确认才能忘记。
3. 日志禁记 token、密钥、提示词正文、工作区路径、工具输出正文。
4. 明文 TCP 只用于承载密文帧；公网必须走 `wss://`。
5. 工具审批只有「允许一次」「拒绝」——透传 DSH 自身的审批语义，不新增提权路径。
6. 中继不可见任何业务明文；token 只出现在配对码里（10 分钟轮换），不出现在任何 RPC 或日志中。

## 9. 二期：移动端本机运行 dsh（设计预留）

参考 dsh-Go 的 PRoot 方案（AGPL，只借鉴思路）：App 内解压 rootfs，用 PRoot 跑 Linux 用户态，装 Node + dsh 引擎，通过 App 桥接进同一个 `FrameTransport` 接口。成本主要在包体（数百 MB）与首次解压。第一期已把 `FrameTransport` 做成接口（局域网、中继、loopback 三种实现），二期接「本地进程 carrier」即可复用全部 UI 与协议代码。

## 10. 名称与许可

- 产品名：**Pocket Harness**（中文：口袋 Harness）。
- 包名：`cn.pocketharness.pocket_harness`；Host 插件包名 `dsh-pocketharness-host`。
- 素材全部原创，不使用 "DSH Go"、"Deepy"、鲸娘等任何原作名称与形象。
- LICENSE：MIT。借鉴 ds-harness-remote（MIT）之处在 NOTICE 中署名；未使用 dsh-Go 的 AGPL 代码。
