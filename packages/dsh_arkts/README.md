# dsh_arkts — 协议核心的 TypeScript/ArkTS 版本

鸿蒙侧的 Dart AOT 产物只能由 macOS arm64 生成（`gen_snapshot` 没有 Windows 版），所以
「鸿蒙 7.0 能不能跑 Pocket Harness」这个问题，在 Flutter 路线下永远卡在一台我们没有的机器上。

这个包换一条路：把协议核心用 TypeScript 重写一遍，让鸿蒙 App 是纯 ArkTS 的。

## 它包含什么

| 文件 | 内容 |
| --- | --- |
| `src/bytes.ts` | 字节拼接、base64url、Noise 的 12 字节计数器、手写 UTF-8 |
| `src/sha256.ts` | SHA-256 与 HMAC-SHA-256 |
| `src/curve25519.ts` | RFC 7748 X25519（BigInt 实现） |
| `src/chacha20_poly1305.ts` | RFC 8439 AEAD |
| `src/noise.ts` | Noise IK 双角色握手与传输密钥 |
| `src/wire.ts` | 帧、DSHF 分片、JSON 信封 |
| `src/json.ts` | `JsonObject` 与收口用的取值函数（ArkTS 禁 `unknown`） |
| `src/rpc.ts` | 请求/响应关联与流式端点 |
| `src/pairing.ts` | 配对票据、端点解析 |
| `src/identity.ts` | 设备身份与 UUIDv7 形状的 id |
| `src/link_protocol.ts` | 明文 hello 与配对证明 |

## 为什么能信

`npm test` 跑两套断言：

1. **`test/vectors.ts`** —— 读 `probe/noise-fixture.b64`（来自 ds-harness-remote 的
   MIT 金标向量），把 fixture 的静态密钥、临时密钥、prologue 喂进来，逐字节比对
   握手消息、传输密文与计数器。Dart 侧 `packages/dsh_link/test/noise_vector_test.dart`
   与 Node 侧 `probe/noise_vector.mjs` 读的是同一份数据 —— **三端同时绿，才说明协议真互通**。
2. **`test/protocol.ts`** —— 帧、分片（含乱序重组、形状不一致拒绝）、信封版本校验、
   配对票据往返、prologue 逐字节固定、握手乱序拒绝。

`npm run test:live` 更进一步：它连上**运行中的** DeepSeek Harness，跑完整 hello →
Noise 握手 → `session/list` → `job/list` 流。这一步证明的不只是数学正确，而是
「这份代码能跟真正的 Host 说话」。

## 在鸿蒙工程里怎么用

`src/` 是平台无关的（除了 `test/`），hvigor 直接编译即可。已经实测：拷进
`tools/ohos-probe/entry/src/main/ets/core/` 后能通过 ArkTS 编译，`.abc` 里能搜到
`x25519`、`NoiseIkSession`、`createNoisePrologue`、`decodeTicket` 等符号。

需要替换的只有两处：

- **随机数**：`RandomSource` 由调用方注入，鸿蒙侧用 `cryptoFramework.createRandom()`。
- **传输**：`FrameTransport` 是一个四方法的接口，鸿蒙侧用 `@ohos.net.socket` 的 TCP
  或 `@ohos.net.webSocket` 实现，字节口径与 Node 侧 `test/live.ts` 的 `openTcp` 相同
  （TCP 上是 `[uint32 大端长度][帧]`）。

### ArkTS 的两个硬约束（写码时必须绕开）

1. **没有 `TextEncoder`/`TextDecoder`** —— 用 `bytes.ts` 的 `utf8`/`fromUtf8`。
2. **禁 `unknown`/隐式 any**（`arkts-no-any-unknown`）—— 一律用 `json.ts` 的
   `JsonObject`，不要写 `Record<string, unknown>` 或 `let parsed: unknown`。

## 与 Dart 版本的关系

两者不是替代关系，是同一份协议的两个实现。改动任何一侧都必须让另一侧的金标测试
仍然通过 —— 这是这套协议唯一可靠的跨端保证。
