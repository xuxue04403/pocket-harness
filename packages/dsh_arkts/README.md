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
| `src/framing.ts` | TCP 上的长度前缀切帧（两端共用，边界都有断言） |
| `src/json.ts` | `JsonObject` 与收口用的取值函数（ArkTS 禁 `unknown`） |
| `src/rpc.ts` | 请求/响应关联与流式端点 |
| `src/pairing.ts` | 配对票据、端点解析 |
| `src/identity.ts` | 设备身份与 UUIDv7 形状的 id |
| `src/link_protocol.ts` | 明文 hello 与配对证明 |
| `src/secure_channel.ts` | 把帧过 Noise 的收发层，超限自动分片 |
| `src/client.ts` | 手机侧连接流程：hello → Noise → RPC，先试局域网再走中继 |
| `src/session_rows.ts` | 会话列表的行：主键 `sessionId`、标题在 `projections` 里、运行中优先排序 |
| `src/transcript.ts` | 会话正文的行：内容块拼接、工具调用、`turn/end` 的异常原因、流式增量 |
| `src/relay_protocol.ts` | 中继控制消息：首帧 hello、进房回执、`ready`、关闭帧里的拒绝码 |
| `src/remote_events.ts` | 网关的 `$events` 转发流：ready 握手、取消、把一次 waterfall 变成一条回复 |
| `src/questions.ts` | 把转发来的 waterfall 说成审批或选择题，并组装 DSH 期望的答案 |
| `src/models.ts` | 模型清单与当前路由：把 provider 分组摊平，两种路由形状都认 |
| `src/agent_presets.ts` | 智能体预设与新建会话的参数：「跟随电脑」与「显式选默认预设」要能区分 |
| `src/skills.ts` | 会话可用的技能清单与 `/name` 插入文本 |
| `src/settings.ts` | 电脑的全局设置：revision 校验、打码密钥、写回后的新 revision |
| `src/workspace.ts` | 工作区文件：根目录的 `'.'`、扁平命名参数、搜索四字段全必填、路径规整 |
| `src/composer.ts` | 发出去的内容块：标准 base64（不是 url 变体）、类型白名单、空 content 必须拦住 |
| `src/images.ts` | 收回来的图片引用：只认 `attachment`、字节另取、标准 base64 解码 |
| `src/pairing_text.ts` | 从一整行日志里挑出配对码、判真伪、写成一句可核对的话 |
| `src/jobs.ts` | 后台任务：`job/list` 是不结束的整集流、`follow` 三段式、`kill` 对已结束任务不报错 |
| `src/todos.ts` | agent 的计划：`todos` 的 `null` 与空数组是两件事，`todo/write` 整表替换 |
| `src/qr/gf256.ts` | GF(256) 的指数/对数表与多项式运算（本原多项式 `0x11d`） |
| `src/qr/rs.ts` | Reed-Solomon：生成多项式、syndrome、Berlekamp-Massey + Chien + Forney 纠错 |
| `src/qr/tables.ts` | 40 个版本 × 4 个纠错等级的分块参数（总码字数、块数、纠错码字数） |
| `src/qr/format.ts` | 格式信息 BCH(15,5) 与版本信息 BCH(18,6)，两份副本容错读、八种掩码公式 |
| `src/qr/decode.ts` | 矩阵 → 文本：定位图案遮罩、zig-zag 取码字、去交织、RS 纠错、按版本分档的载荷解析 |
| `src/qr/sampler.ts` | 灰度图 → 矩阵：找暗像素包围盒、按版本推模块边长、逐模块多数表决 |
| `src/qr/frame.ts` | 相机帧 → 灰度图：按 `rowStride`/`pixelStride` 取亮度平面、RGBA 按 BT.601 转灰度、块平均降采样 |
| `src/qr/scan.ts` | 照片里找码：Otsu 阈值、1:1:3:1:1 定位图案搜索、三点仿射采样（旋转也能读） |

## 为什么能信

`npm test` 跑二十二套断言：

1. **`test/vectors.ts`** —— 读 `probe/noise-fixture.b64`（来自 ds-harness-remote 的
   MIT 金标向量），把 fixture 的静态密钥、临时密钥、prologue 喂进来，逐字节比对
   握手消息、传输密文与计数器。Dart 侧 `packages/dsh_link/test/noise_vector_test.dart`
   与 Node 侧 `probe/noise_vector.mjs` 读的是同一份数据 —— **三端同时绿，才说明协议真互通**。
2. **`test/protocol.ts`** —— 帧、分片（含乱序重组、形状不一致拒绝）、信封版本校验、
   配对票据往返、prologue 逐字节固定、握手乱序拒绝。
3. **`test/client.ts`** —— 在进程内扮演一台 Host（同一条内存管道两端），跑完整的
   `LinkClient.connect`：局域网路由、加密往返、错误配对被拒、冒充 Host id 被拒、
   错误码与 details 透传、流式帧、hello 超时、**只有中继坐标的票据走中继**。
4. **`test/framing.ts`** —— TCP 长度前缀的边界：两条帧粘一块、一帧拆三段、逐字节喂、
   超限长度前缀被拒且之后永久失败、空帧、大端字节序。
5. **`test/session_rows.ts`** —— 会话列表的真实形状：主键是 `sessionId`、标题藏在
   `projections.values.title`、`projections` 可能缺失或为 `null`、没有 `cwd` 时退回
   相对时间、坏条目被跳过、排序把运行中顶到最前且不改入参。
6. **`test/transcript.ts`** —— 正文的真实形状：负载在 `event.data` 里、正文是内容块
   数组、工具参数是未解析的字符串、`turn/end` 只有 `completed`/`aborted` 安静、
   `tool-call-delta` 故意丢弃、snapshot 的 `records` 能被取出。
7. **`test/relay_protocol.ts`** —— 中继控制消息的形状：hello 带版本/角色/房间/token、
   空值与超长被提前拒绝、`ok:true` 是进房回执而 `ready` 才是对端到达、噪音被忽略、
   **拒绝不在 JSON 上而是在关闭帧里**（4403/4409/4400 各有可行动的话）。
8. **`test/relay_contract.ts`** —— 起一个**真的中继进程**（`relay/run.mjs`），证明上面
   那些形状不是我自己想出来的：进房回执、双方 `ready`、字节原样穿过、手机离开时
   Host 收到 `peer-gone`、错 token 关闭帧 4403、二进制首帧关闭帧 4400、第二部手机 4409。
9. **`test/questions.ts`** —— 审批与提问的解析：`displayReason` 优先英文、无理由/无工具名
   也能读、选项两种形状都收（`{label,description}` 与裸字符串）、无 id 的题目用位置兜底、
   **渲染不了的返回 null**（调用方据此 delegate，别把 waterfall 挂死）、答案批次的形状、
   空白自定义答案不出现在载荷里。`test/client.ts` 另有 10 条断言把这条流真的走一遍：
   进 ready、收到 waterfall、解析成审批、回答落到 Host、delegate 发出 `next`。
10. **`test/models.ts`** —— 模型清单与当前路由：provider 分组被摊平、`provider` 与
    `providerName` 分开、`efforts` 保序、缺 `name` 用 id 顶上、坏条目跳过而不炸整个
    选择器、**`selectModel` 的扁平回答与 `projections` 的 `next`/`lastUsed` 两种形状
    都能解析**、未知路由退回 model id。
11. **`test/agent_presets.ts`** —— 预设与新建会话：`order` 排序、缺 `name` 用 id、
    坏条目跳过、默认预设的识别、「跟随电脑」这一行要把默认预设的名字带上、**空
    `cwd` 绝不能变成 `cwd: ''` 发出去**、空预设 id 被丢弃。
12. **`test/skills.ts`** —— 技能清单与插入：坏条目跳过、**空查询返回全部**（与会话
    过滤相反）、名称/说明/用途三处都能筛、`/name ` 的拼接在空草稿与非空草稿下
    都带正确的分隔符、连续插两条不会粘成 `/a/b`。
13. **`test/settings.ts`** —— 全局设置：坏命名空间跳过而不清空整页、`expectedRevision`
    必须来自刚读到的那一份、被打码的密钥显示成「已隐藏」而不是「空」、写回时沿用
    回答里的新 revision、**写同值不递增 revision**、冲突文案能直接照着做。
14. **`test/workspace.ts`** —— 工作区文件：空串与 `'/'` 都被规整成 `'.'`（Host 对这两者
    分别报 `path is required` 与 `outside-workspace`）、反斜杠与 `..` 之外的多余段被
    清掉、`search` 的四个字段一个不少、目录排在文件前面、坏条目跳过、越界的文案
    中文化。
15. **`test/composer.ts`** —— 发出去的内容：**标准 base64 带 `=` 填充**（与 Node 的
    `Buffer` 在十种长度上逐一对齐）、图片类型白名单、uri 的查询串先切掉、文字在前
    图片在后、空 `content` 被拦住（Host 会把它读成「继续上一轮」）、错误文案中文化。
16. **`test/images.ts`** —— 收回来的图片：块里只有 `attachment` 没有字节、引用缺
    `attachmentId` 就丢弃、取字节要把会话 id 放进 `request` 里、`+/` 与 `-_` 两套
    字母表不能混用（用错必须报错而不是解出错字节）、无名图片按字节数显示大小。
17. **`test/pairing_text.ts`** —— 配对码的脏输入：整行日志、带引号、带行尾
    标点、只复制一半、两个码连着贴。找得到与读得出是两件事：找不到时说「以
    `pocketharness://pair?t=` 开头」，读不出时说清是复制截断还是码被改过。
18. **`test/jobs.ts`** —— 后台任务：`job/list` 是**不会结束的整集流**（只能取第一帧）、
    `follow` 的 `opened`/`output`/`status` 三段、`output` 帧要把 `chunks[].text` 拼起来、
    `lossy` 表示中间丢过输出、**`job/kill` 对已结束的任务回 `already-finished` 而不是报错**
    （所以界面要说「已经结束了」，不能假装终止成功）、认不出的状态原样显示而不是写「未知」、
    `startedAt` 缺失时不显示「0 秒」。
19. **`test/todos.ts`** —— agent 的计划：`todos` 缺键、`null`、空数组是**三件不同的事**
    （前两者是「还没列计划」，整块隐藏；空数组是「计划被清空」，显示成空表）；
    `todo/write` 整表替换而不是合并；认不出的状态原样保留；进度的分母是全部条目；
    折叠摘要优先正在做的那条，全做完时说「全部完成」。
20. **`test/qr_rs.ts`** —— Reed-Solomon 本身：GF(256) 的指数/对数表、生成多项式、
    **QR 规范里那个经典例子**（v1-M 的数据码字必须纠出 `[165,36,212,193,237,54,199,135,44,85]`）、
    损坏 1/3 字节可修、损坏 7 字节必须拒绝而不是硬凑、六种纠错码字数各在
    `ecCount/2` 以内随机损坏后全部往返。
21. **`test/qr_fixtures.ts`** —— 完整的二维码解码：金标来自 `probe/qr_fixtures.json`
    （node-qrcode 生成、jsQR 独立验证过），四条样本覆盖 v1/v3/v5 与 L/M/H，
    矩阵入口与**灰度图入口**都必须解回原文；格式信息的 32 种组合要能反解回自己的
    level/mask；平方级别的损坏要能靠 ES 修回来并报出 `repairedBytes`；毁掉一整块
    必须拒绝而不是给出乱码。
22. **`test/qr_scan.ts`** —— 从相机帧里找码：Otsu 阈值要跟着场景变亮变暗一起
    移动，`binarize` 的边界要包含阈值本身；YUV 的亮度平面**按 `rowStride` 走行、
    按 `pixelStride` 取字节**（当紧密排列读会把图剪斜，看起来就是「解不出」）、
    缓冲区不够必须拒绝；降采样取块平均而不是点采样；把金标**逆向渲染**成
    场景（小数倍的模块像素、旋转 4/12/27 度、右下角渐暗）之后，三个定位图案
    仍要找到、版本要认对、文本要解回来。这里钉住过一个真实缺陷：横向行程在
    旋转后会被拉长 1/cosθ，不除掉就会把 27 度读成小一号的版本。**RGBA 那条路**
    也在这里验：BT.601 的整数权重（纯红是 76 而不是 85）、行填充必须跳过、
    缓冲区短了要拒绝而不是读越界。

`npm run test:live` 更进一步，它连上**运行中的** DeepSeek Harness 做十二件事：

1. 跑完整 hello → Noise 握手 → `session/list` → `job/list` 流。这一步证明的不只是
   数学正确，而是「这份代码能跟真正的 Host 说话」。
2. 用 `session/page` 把真实会话记录拉下来喂给 `readTranscript`，统计产出的行数
   （实测 24 个会话：用户 85 行、助手 62 行、工具 115 行）。单元测试证明解析器自洽，
   这一步证明「我以为的形状」和「Host 实际发的形状」是一回事。
3. 起真实 Host 插件 + 真实中继，让 `LinkClient` **只带中继坐标**连过去，跑
   `test/echo` 与 `test/count`（`ARKTS RELAY ROUTE TALKS TO THE REAL HOST`）。
   这一步抓住过一个只有真链路能暴露的 bug：中继上的二进制消息**就是整帧**，
   套用 TCP 的长度前缀切帧会把帧头当长度、算出天文数字后把连接关掉。
4. 读 `session/modelCatalog` 与若干会话的 `session/projections`，要求清单非空、
   每条都有显示名与 provider、**每个会话报告的路由都能在清单里找到**。这里故意
   不真的换模型——那会改掉这台电脑上真实会话的状态，选择动作的形状由第 3、10 套
   断言钉住。
5. 读 `agentPresets/list`，要求至少一个预设、每个都有显示名、默认预设被标出来。
   同样**不真的新建会话**：那会在电脑上留下记录，请求体形状已由第 11 套断言
   与 `test/client.ts` 的假 Host 覆盖。
6. 读 `skills/list`（要带一个真实 `sessionId`，清单是按会话算的），要求至少一条、
   每条有名字、调用名是不带空格的小写 token。不插入也不发送。
7. 读 `settings/describe`（本机 24 个命名空间），把 `agent-default-model` **写回原值**：
   这既验证了 `settings/update` 的请求形状（含 `expectedRevision`），又因为「写同值不
   递增 revision」而不在这台电脑上留下任何改动。随后用一个过期的 revision 确认会被
   拒绝，而不是悄悄覆盖电脑上的值。
8. 用会话 id 当 `workspaceFileScopeId` 列工作区根（真 Host 上列出 `.git`、`app`、
   `docs` …），进一层子目录，读 `README.md` 的前 20 行，再搜一次 `pocket`。最后故意
   传 `'/'` 确认越界被拒 —— 那条断言就是「手机只能看会话拥有的目录」的证据。全程只读。
9. 用 `probe/samples/tiny.png` 建一个**空会话**，发一条带图片的 prompt，然后按
   `session/page` 轮询等 `user/message` 出现：确认文字还在、Host 存下来的是一个
   图片引用（不是字节）、用 `session/attachment` 取回的 base64 与发出去的完全一致。
   这一步证明的正是「手机上选一张图，电脑真的能看见」。测试会话会留在电脑上，是
   这条链路唯一会留下痕迹的地方。
10. 扫最多 40 个会话找有任务的，取 `job/list` 的**第一帧**，再对一个**已经结束**的任务
    试 `job/kill`，确认回的是 `already-finished`。这里故意不杀活任务：那个「运行中」
    的任务很可能就是当前会话自己的工具调用，杀掉它等于把自己掐断。
11. 扫最多 200 个会话的 `session/projections`，直到见过带计划的会话（实测这台机器
    869 个会话里 54 个有计划，所以扫 40 个经常一条也遇不到）：既验证「还没列计划」
    这种形状真的会走到，也验证真遇到计划时每条都有内容与状态、进度是分数、摘要有字。
12. 走一遍 `pocketInstructions`：不带 cwd 也必须有用户级链；带 `ref/dsh-go` 当 cwd
    必须定位到那个**嵌套检出自己的** `.git`（不能一路跑到外层仓库）；然后真改一份
    项目链里的 `AGENTS.md`、确认盘上的字节真的变了、读回来一致、再写回原样。最后
    确认两个拒绝路径：不在任何 scope 里的目录、以及 `package.json` 这种非候选文件名。
    这是「手机改 AGENTS 类文件」唯一的端到端证据，也是唯一会**写**指令文件的脚本
    （所以它只挑项目链、不碰全机器共用的 `~/.dsh/AGENTS.md`）。

## 在鸿蒙工程里怎么用

`src/` 是平台无关的（除了 `test/`），hvigor 直接编译即可。已经实测：拷进
`tools/ohos-probe/entry/src/main/ets/core/` 后能通过 ArkTS 编译；探针页
`entry/src/main/ets/selfcheck.ts` 引用了 `client.ts` 并带一个「跑一次完整客户端链路」
的按钮，因此**连接流程本身也在 ArkTS 的检查范围里**（不引用就不会被编译，
这是第一次接进去才发现 `hasRelay` 那个 bug 的原因）。产物 `.abc` 里能搜到
`x25519`、`NoiseIkSession`、`LinkClient`、`runClientCheck`、`bad-proof` 等符号。

二维码解码器同理：`selfcheck.ts` 的 `runQrCheck` 引用了 `qr/decode.ts` 与
`qr/sampler.ts`，页面上有「解三张二维码金标」按钮，`.abc` 里能搜到 `decodeMatrix`、
`matrixFromImage`、`readFormat`、`generatorPolynomial`、`deinterleave`、`countBits`。
把它接进去还有一层原因：`src/qr/` 里的整数运算、位域解析与数组下标恰恰是换个
JavaScript 引擎最容易偏的地方，而 Node 侧的绿只证明了 TypeScript 语义正确。

需要替换的只有两处，探针工程里都已经写好并编译过：

- **随机数**：`RandomSource` 由调用方注入。鸿蒙侧见
  `tools/ohos-probe/entry/src/main/ets/platform.ohos.ts` 的 `systemRandom`，用
  `cryptoFramework.createRandom().generateRandomSync(n)`。
- **传输**：`FrameTransport` 是一个四方法接口。同一个文件里的 `openTcpTransport` 用
  `@ohos.net.socket` 的 `constructTCPSocketInstance`，线上口径与 Dart 的
  `FramedSocket`、Node 的 `test/live.ts` 一致：`[uint32 大端长度][帧]`。

中继走 `@ohos.net.webSocket`，同一个文件里的 `openRelayTransport` 已经写好并编译过：
**首帧发文本 hello**（中继靠它分房间，二进制会被 4400 关掉），之后一条二进制消息
就是一整帧、没有长度前缀，拒绝则落在关闭帧的 `code` 上（4403 错 token、4409 房间已满）。
这几条全部由 `src/relay_protocol.ts` 表达、被第 7、8 套断言钉住，平台桥接只是搬运。

切帧逻辑抽在 `src/framing.ts`（`FrameSplitter`/`frameWithLength`），因为它是 TCP 那条路
最容易在边界上出错的部分 —— Node 的 live 测试与鸿蒙的 TCP 传输用的是**同一份**代码，
所以「framing 自检通过」对两边同时成立。

### ArkTS 的两个硬约束（写码时必须绕开）

1. **没有 `TextEncoder`/`TextDecoder`** —— 用 `bytes.ts` 的 `utf8`/`fromUtf8`。
   二维码载荷的解码也一样：`src/qr/decode.ts` 里是手写的严格 UTF-8 解码器
   （会拒绝 overlong 与代理对形态），不是 `TextDecoder`。
2. **禁 `unknown`/隐式 any**（`arkts-no-any-unknown`）—— 一律用 `json.ts` 的
   `JsonObject`，不要写 `Record<string, unknown>` 或 `let parsed: unknown`。

`src/qr/format.ts` 还有一处为了跨运行时一致而做的妥协：32 组格式信息的查表不用
`Map` 的解构迭代，而是两个平行数组（`FORMAT_CODES`/`FORMAT_INFOS`）。ArkTS 允许
`Map`，但对它的 `for (const [k, v] of map)` 在两个引擎上不保证一致。

### 扫码这条路为什么要自己写解码器

鸿蒙 SDK **没有条码扫描接口**：`@ohos.scan.d.ets` 是打印扫描仪；约五十个 kit 里
没有 ScanKit/VisionKit；`@ohos.multimedia.camera` 的
`MetadataObjectType.BAR_CODE_DETECTION` 只给位置，`MetadataBarcodeObject` 是个空接口。
所以配对码的获取只有两条路：粘贴（已经做了），或者自己从相机帧里解。

`src/qr/` 就是这个「自己解」。范围划得很清楚：**只处理轴对齐、整像素模块的图**
（配对码本身就是电脑屏幕上的渲染图，探针工程的 `runQrCheck` 用「每模块 4 像素 +
4 模块静区」的灰度图验证过这条路径）。拍照的透视变换、倾斜、模糊不在范围内 ——
本项目没有测试台，写一个测不了的几何校正只会把「有时候能扫」伪装成「支持扫码」。

`tools/gen_qr_fixtures.mjs` 生成金标，`tools/gen_qr_samples.mjs` 把它抄成
`qr_samples.ts` 供 ArkTS 运行时自检（`selfcheck.ts` 的 `runQrCheck`）。**两个生成器
都必须在 `packages/dsh_arkts` 里跑**，因为 Node 只从这个包的 `node_modules` 解析
`qrcode`。

### 平台代码为什么不在 `src/` 里

`platform.ohos.ts` 依赖 `@ohos.net.socket` 与 `@kit.CryptoArchitectureKit`，
Node 的 esbuild 解析不了，所以它放在探针工程里而不是 `src/`。代价是它只被 ArkTS
编译器检查、没有 Node 单测；补偿是它里面几乎没有逻辑 —— 真正的字节处理都在
`framing.ts`，那部分有 15 条断言。

## 与 Dart 版本的关系

两者不是替代关系，是同一份协议的两个实现。改动任何一侧都必须让另一侧的金标测试
仍然通过 —— 这是这套协议唯一可靠的跨端保证。
