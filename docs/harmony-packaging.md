# 鸿蒙 7.0（HarmonyOS / OpenHarmony API 26）打包说明

**结论先行**：手机端代码已经是跨平台的纯 Dart，鸿蒙只差一个打包目标。**Flutter 的鸿蒙产物（带 Dart AOT 的完整 HAP）无法在 Windows 上生成**——`gen_snapshot` 与 `frontend_server` 的鸿蒙版只发布了 macOS arm64，因此完整的 App 需要一台 macOS（Apple Silicon）或对应 CI runner。

但**ArkTS 宿主侧可以在 Windows 上真编译出 HAP**，这条路已在本仓库实测跑通（见下文「在 Windows 上能做的部分」）：OpenHarmony 7.0 的公开 SDK 自带 Windows 工具链，`hvigor` 也能从 `repo.harmonyos.com` 免登录安装。它能证明鸿蒙宿主的工程结构、资源、权限声明与 ArkTS 代码是对的，只缺 Dart AOT 那一半。

这条结论不是推测：`dsh-Go/app/ohos/README.md` 用自己的构建矩阵写明了同一件事。我们读过它的文档来了解边界，没有使用它的代码（它是 AGPL-3.0）。

## 需要的工具链

| 组件 | 来源 | 备注 |
|---|---|---|
| oh-flutter（Flutter 的鸿蒙分支） | `https://atomgit.com/oh-flutter/flutter_flutter` | 用 `oh-3.47.4-dev` 或更新的 release 分支；**不要**用 `gitee.com/openharmony-sig/flutter_flutter`（停在 3.22） |
| 鸿蒙插件 fork | `https://atomgit.com/oh-flutter/flutter_packages` | 下面列出的依赖要换成对应的 ohos 版本 |
| OpenHarmony SDK（API 26） | `https://repo.huaweicloud.com/openharmony/os/7.0-Release/ohos-sdk-windows_linux-public.tar.gz` | 公开下载，约 3.2 GB，免登录 |
| hvigor / ohpm | HarmonyOS Command Line Tools | 需登录华为账号；`ohpm` 另有免登录的社区版 `ohpm/5.0.2/oh-command-line-tools-20240715.zip` |
| 签名 | AGC 调试证书 + profile | 未签名的 HAP 装不进华为手机 |

## 依赖替换

`app/pubspec.yaml` 里的四个插件在鸿蒙上要用 ohos fork：

```yaml
# app/pubspec_overrides.yaml —— 只在鸿蒙构建时存在，Android 构建不要这个文件
dependency_overrides:
  mobile_scanner:
    git:
      url: https://atomgit.com/oh-flutter/flutter_packages
      path: packages/mobile_scanner/mobile_scanner
      ref: <该分支的 tag>
  shared_preferences:
    git:
      url: https://atomgit.com/oh-flutter/flutter_packages
      path: packages/shared_preferences/shared_preferences
      ref: <该分支的 tag>
```

`dsh_link` 是纯 Dart（`crypto` 包也是纯 Dart），**不需要任何替换**，这是把协议层做成独立包的主要收益。

用到的 dart:io、dart:async、dart:convert 在鸿蒙上都有对应实现；`WebSocket` 走 `dart:io`，中继路径同理。

## 需要改的应用层代码

1. **`dart:io` 的 `Socket` 与 `ServerSocket`**：鸿蒙的 Flutter 引擎支持 `dart:io`，但要确认网络权限已在 `module.json5` 里声明：

   ```json5
   "requestPermissions": [
     { "name": "ohos.permission.INTERNET" },
     { "name": "ohos.permission.GET_NETWORK_INFO" },
     { "name": "ohos.permission.CAMERA" }
   ]
   ```

2. **相机（扫码）**：`mobile_scanner` 的鸿蒙 fork 需要 `ohos.permission.CAMERA`，并在 `module.json5` 里声明 `abilities` 的 `orientation`。若该 fork 的扫码 API 有差异，`app/lib/src/pages/scan_page.dart` 是唯一需要改的文件；`paste_page.dart` 已经提供了不依赖相机的备用入口，可先保底可用。

3. **安全存储**：目前手机端用 `shared_preferences` 存设备私钥（应用私有目录）。鸿蒙上建议改为 Asset Store Kit（`@ohos.security.asset`），至少要保证 `DEVICE_UNLOCKED` 语义与不落明文。这需要写一个 method channel，属于二期工作。

4. **`flutter_secure_storage`**：本项目没有用它，因此不需要它的 fork。

## 构建命令

在 macOS arm64 上：

```bash
export PATH=/path/to/oh-flutter/bin:$PATH
export OHOS_SDK=/path/to/ohos-sdk/26
cd app
flutter pub get
flutter build hap --release \
  --dart-define=POCKET_HARNESS_PAIR_TICKET= \
  --target-platform ohos-arm64
```

产物在 `app/ohos/entry/build/default/outputs/default/` 下。签名后：

```bash
hdc install -r entry-default-signed.hap
```

## 在 Windows 上能做的部分（已实测跑通，可产出未签名 HAP）

界面层已经是真的了：`tools/ohos-probe` 里有三个页面 —— 配对码页（粘贴 `pocketharness://pair?...`、保存身份）、会话列表页（`session/list`，运行中优先排序）、对话页（`session/follow` 带 `activate` 与 `assistantStream`，逐字增量 + 工具调用 + 异常的 `turn/end` 有一句话）。从配对到收发消息这条链路在 ArkTS 里是完整的，缺的是扫码、图片、设置这些外围页面。

不需要 macOS 就能验证的：

- **ArkTS 侧的真编译**：`hvigor` + `restool` + `ets-loader` + `es2abc` 已在本机跑通，产出 `entry-default-unsigned.hap`（1100 KB，内含 `ets/modules.abc` 684,664 字节）。这条路只能编原生代码，**编不了 Dart AOT**。
- **协议核心也能编进 ArkTS**：`packages/dsh_arkts` 的 TypeScript 源码由 `build.ps1` 同步进 `entry/src/main/ets/core/` 后能通过 ArkTS 编译，`.abc` 里能搜到 `x25519`、`NoiseIkSession`、`LinkClient`、`runClientCheck`、`bad-proof`、`pocketharness` 等符号 —— 也就是说鸿蒙 App 可以完全不走 Dart，直接用这份协议核心连 Host。
- **连接流程本身也被编过**：探针页的 `entry/src/main/ets/selfcheck.ts` 引用 `LinkClient` 并在页面里跑一遍 hello → Noise → RPC（内存管道扮演 Host）。**被引用这件事是关键**：不被引用就不会进编译图，ArkTS 也就不会检查它 —— 第一次接进去立刻报出 `client.ts` 里把 `hasRelay` 当属性读的真实 bug（Node 只擦类型不检查，中继分支因此长期静默失效）。
- **鸿蒙的平台接口也接好了**：`entry/src/main/ets/platform.ohos.ts` 用 `@ohos.net.socket` 的 `constructTCPSocketInstance` 实现 `FrameTransport`、用 `cryptoFramework.createRandom().generateRandomSync` 实现 `RandomSource`，页面上的第三个按钮可以粘贴配对码 + `host:port` 去连真实的 Host。这份文件不参与 Node 测试（esbuild 解析不了 `@ohos.*`），所以里面的字节处理全部下沉到 `src/framing.ts` —— 15 条断言在 Node 里跑，鸿蒙侧用的正是同一份代码。
- **纯 Dart 层**：`dart test` 全覆盖，与平台无关。

### ArkTS 不支持的四件事（真编译时报出来的）

1. **没有 `TextEncoder`/`TextDecoder`**。鸿蒙的 lib 目标里不带 Web Encoding API，`new TextEncoder()` 直接是 `Cannot find name 'TextEncoder'`。`packages/dsh_arkts/src/bytes.ts` 里的 `utf8`/`fromUtf8` 是手写的（含代理对与非法序列的 U+FFFD 处理），用它们替代。
2. **禁 `unknown`/隐式 any**（`arkts-no-any-unknown`）。`JSON.parse` 在鸿蒙 lib 里返回 `Object`，所以不能写 `let parsed: unknown = JSON.parse(...)`。`packages/dsh_arkts/src/json.ts` 的 `JsonObject`/`parseJsonObject`/`*Field` 就是为了收口这件事；协议内部一律用 `JsonObject` 而不是 `Record<string, unknown>`。

3. **禁对象展开**（`arkts-no-spread`）：`{ ...base, field: value }` 不合法，构造对象要把每个字段写出来（见 `src/transcript.ts` 的 `row()`）。
4. **`AsyncGenerator` 的类型参数必须给全**：`AsyncGenerator<JsonObject>` 会因默认的 `any` 报错，要写 `AsyncGenerator<JsonObject, void, undefined>`。

改完这四处后，同一份源码在 Node 上跑金标向量、在鸿蒙上编译 HAP，两边都过。

### 最小可复现步骤（Windows，无需华为账号）

样例工程在 `tools/ohos-probe`，可直接照着搭：

```powershell
# 1. 公开 SDK（约 3.2 GB，免登录）
#    https://repo.huaweicloud.com/openharmony/os/7.0-Release/ohos-sdk-windows_linux-public.tar.gz
#    解压后 windows/ 下有 5 个 zip：ets / js / native / previewer / toolchains

# 2. 关键：SDK 必须按 <root>/<完整版本号>/<组件> 布局，否则 hvigor 报 00308018
#    "The SDK management mode has changed"
$sdk = 'D:\ohos-sdk'
foreach ($c in 'ets','js','native','toolchains','previewer') {
  New-Item -ItemType Directory -Force "$sdk\26.0.0\$c"
  tar.exe -xf "<解压目录>\windows\$c-windows-x64-26.0.0.38-Beta.zip" -C "$sdk\26.0.0\$c" --strip-components=1
}

# 3. hvigor（repo.harmonyos.com 无需登录）
npm install --registry=https://repo.harmonyos.com/npm `
  @ohos/hvigor@6.26.20 @ohos/hvigor-ohos-plugin@6.26.20

# 4. 构建
$env:DEVECO_SDK_HOME = $sdk
$env:OHOS_BASE_SDK_HOME = $sdk
node node_modules\@ohos\hvigor\bin\hvigor.js --mode module -p product=default assembleHap --no-daemon
```

### 六个必踩的坑（都有原文报错）

1. `00303034` — 产品里必须显式写 `compileSdkVersion`。
2. `00303024` — 必须有 `hvigor/hvigor-config.json5` 且 `modelVersion` 非空（这里用 `6.0.0`）。
3. `00306042` — **API 26+ 的 `compileSdkVersion`/`compatibleSdkVersion`/`targetSdkVersion` 必须是字符串 `"26.0.0"`**，写数字 `26` 直接失败（API 10–25 才是数字）。
4. `00303208` — 需要 `local.properties` 的 `sdk.dir` 或环境变量 `OHOS_BASE_SDK_HOME`，两者都设更稳。
5. `00304067` — 必须有 `AppScope/app.json5`。
6. `00308018` — 两个不同原因共用这个错误码：
   - **SDK 布局**：扁平 `ets/ js/ native/ toolchains/` 会被判为旧的管理模式，必须改成 `<root>/26.0.0/<组件>`。
   - **缺 previewer**：布局对了以后会报 `The SDK license agreement is not accepted … re-download the Previewer:26.0.0.38 SDK`。公开 SDK 的 `windows/` 里有这个 zip，放进去即可，**不需要真的登录**。

另外 `module.json5` 的 `deviceTypes` 在纯 OpenHarmony SDK 下只能写 `"default"`；写 `"phone"` 会报 `00303060`（各设备 systemCapability 交集为空）与 `The systemCapability set corresponding to the 'phone' is not found`。

### 产物核对

```powershell
tar.exe -tf entry\build\default\outputs\default\entry-default-unsigned.hap
# module.json / resources.index / ets/modules.abc / pack.info / rpcid.sc …
```

`ets/modules.abc` 里能直接搜到 ArkUI 页面的字符串与 bundleName，说明 ArkTS 真的被编译进了字节码，不是空壳。签名后才能 `hdc install`，签名材料（AGC 证书 + profile）不入库。

### 中继也在里面

鸿蒙侧现在两条路都能走：局域网的 `openTcpTransport`（`@ohos.net.socket`）与公网的
`openRelayTransport`（`@ohos.net.webSocket`），都在
`tools/ohos-probe/entry/src/main/ets/platform.ohos.ts` 里，`LinkClient` 会自动先试
局域网再退到中继。中继上踩到并修掉的三个坑：

- **首帧必须是文本**：中继读它来分房间，二进制首帧会被 4400 关掉；
- **二进制消息就是整帧**，没有 TCP 那种 4 字节长度前缀 —— 套用 `FrameSplitter` 会把
  帧头当长度、算出天文数字后把连接关掉，表现是「中继连上了但立刻断开」；
- **拒绝不在 JSON 上**：中继用关闭帧（`close(4403, 'bad token')`）拒绝，漏读 `on('close')`
  的 `code` 就是「手机关了但界面一直转圈」。

这三条都由 `packages/dsh_arkts/src/relay_protocol.ts` 表达、被 `test/relay_protocol.ts`
与 `test/relay_contract.ts`（起真中继进程）钉住，`npm run test:live` 里还有一条
`live_relay` 走完真实 Host 插件 + 真实中继的完整链路。

### 审批与提问也能在手机上答

鸿蒙侧订阅了网关的 `$events` 转发流（`platform.ohos.ts` 之外的 `src/remote_events.ts`），
所以 agent 请求工具权限或问选择题时，对话页底部会出现一条「需要你确认」的卡片，
三个按钮分别是允许一次、拒绝、回电脑上处理。

两个必须知道的细节：

- **渲染不了的一定要 delegate**：`readQuestion` 对不认识的 waterfall 返回 `null`，
  这时必须发 `{kind:'next'}` 把它交回电脑。悄悄丢掉它会让那个 waterfall 永远挂着，
  整个 turn 卡在「深度求索中」不动；
- **关闭流不能用生成器的 `return()`**：生成器可能正停在 `await` 上等调用方，
  `return()` 只会排队等它，双方互等就是死锁（真机表现是「点返回后界面不退」）。
  `StreamOptions.cancel` 就是为了这条路加的：置 `aborted` 再 `wake()`，
  生成器会在下一个循环里自己收尾并向 Host 关流。

这两条各有一处断言：`test/questions.ts` 钉住解析与 delegate 的选择，
`test/client.ts` 钉住「回答真的落到 Host、delegate 真的发出 `next`」。

### 模型也能在手机上换

对话页标题下有一行当前路由（例如 `DeepSeek-V4-Pro · high`），点「切换模型」展开
一条面板，列出电脑上所有可用的 provider 与模型；选中后调 `session/selectModel`，
**用 Host 回报的那一条更新标题栏**，而不是用点下去的值 —— 电脑可能把强度换成它
自己的默认。

数据侧的坑都在 `src/models.ts` 里，被 `test/models.ts` 钉住：

- 清单是 `groups[] → models[]` 的两层结构，`groups[].name` 才是 provider 的显示名
  （`id` 只是路由用的键），摊平后每一行都要同时带上 provider 与 providerName；
- **当前路由有两种形状**：`projections` 里是 `values.modelSelection.next`（还有
  `lastUsed` 备份），而 `selectModel` 的回答是扁平的 `{provider, model, reasoningEffort}`；
- 一条坏记录不该让整个选择器打不开，解析器逐条跳过畸形条目。

`test/live_models.ts` 用真实 Host 校验清单与路由能对上，但**故意不真的换模型** ——
那会改掉这台电脑上真实会话的状态。

### 新建会话：预设与工作目录

会话列表右上角的「新建会话」展开一条面板，第一行永远是「跟随电脑的默认预设（<名字>）」，
下面才是这台电脑上的各个预设，再下面是工作目录输入框。数据侧在
`src/agent_presets.ts`，被 `test/agent_presets.ts` 钉住：

- **「跟随电脑」与「显式选了默认预设」不是一回事**。不传 `agentPreset` 表示会话
  跟随电脑的默认设置（以后改默认，新会话跟着变）；传了默认预设的 id 就把会话钉死
  在那个预设上。所以面板不会预先选中默认预设。
- **空的 `cwd` 绝不能变成 `cwd: ''` 发出去**，那是「当前进程目录」而不是「用默认」，
  请求体构造器只在非空时才写这个键。
- 预设读不到不影响列会话：面板退化成只有「跟随电脑」一行，仍能建会话。

`test/live_presets.ts` 用真实 Host 校验预设清单（本机是 `standard, ptc, minimal,
cordis, lean`），同样**不真的新建会话**——那会在电脑上留下记录。

### 技能也能在手机上插

对话页标题下方还有一处「插入技能」，展开后是这个会话可用的 `/指令` 清单
（本机 76 条，其中 8 条标了「仅手动」，即模型不能自己挑到）。插进去就是往输入框
追加 `/name `，和手打完全一样 —— 不另发 RPC，所以不会多一条协议。

数据侧在 `src/skills.ts`，被 `test/skills.ts` 钉住，两处容易错：

- **空查询返回全部**，与会话过滤恰好相反（那里空查询返回空）；
- **拼接要先补分隔符**：原文末尾不是空白时插 `/b` 会粘成 `/a/b`，那是另一个命令。

`test/live_skills.ts` 用真实 Host 校验清单（要求至少一条、每条有名字、调用名是
不带空格的小写 token），同样不插入也不发送。

### 电脑的全局设置也在手机上

会话列表右上角「电脑设置」进 `pages/Settings.ets`：`settings/describe` 一次回 24 个
命名空间，页面把它们列成只读摘要（每个挑两个一眼能懂的键，含密钥的标「含密钥」并
显示成「已隐藏」而不是空框），只有全局默认模型可改 —— 复用对话页那个模型选择器。

数据侧在 `src/settings.ts`，`test/settings.ts` 钉形状，`test/live_settings.ts` 打真
Host。三条规矩值得单独记：

- **写必须带 `expectedRevision`**（来自刚读到的那一份）。不带就是「最后写入者赢」，
  会把电脑上刚改过的值无声覆盖；带了不匹配就得到冲突，这比覆盖好。冲突时界面
  **不自动重试** —— 那等于替人决定要覆盖电脑上的改动。
- **`secrets` 里的字段是被打码的**。显示为空不是「没设置」，是「在电脑上设过但这里
  看不到」，所以摘要要写成「含电脑上保存的密钥，已隐藏」。
- **写同一个值不会递增 `revision`**（实测）。回归脚本正是靠这一点：`test/live_settings.ts`
  把 `agent-default-model` 写回原值，既验证了请求形状，又不在那台电脑上留下改动。

顺带一个只有真链路会暴露的细节：冲突错误的文本在不同构建里长得不一样 —— 有时是
`settings/conflict …`，有时只有一句 `settings namespace "x" changed since it was read`，
所以 `describeSettingsError` 两种都要认（第一版只认前者，真 Host 上直接没翻成中文）。

### 工作区文件也能在手机上看

对话页标题下方还有一处「工作区文件」，进 `pages/Files.ets`：列目录、按名字搜、
按 400 行分页读文本，只读。目录前缀是会话页开的那个会话，所以看到的就是这个会话
的工作区。

数据侧在 `src/workspace.ts`，`test/workspace.ts` 钉形状，`test/live_workspace.ts`
打真 Host（真列出 `.git`/`app`/`docs`、真读 `README.md` 前 20 行、真搜 `pocket`）。
四个坑都是实测踩出来的：

- **`workspaceFileScopeId` 的值是 Session id，不是工作区 id**。Host 自己据会话推出
  工作区根，所以手机只能看到这个会话拥有的目录，也永远出不去（`'/'` 会被拒）。
- **根目录必须传 `'.'`**。空串是 `path is required`，`'/'` 是 `outside-workspace` ——
  第一版传空串，模拟器上整页显示「读不到这个目录」。
- **`search` 的四个字段全部必填**（`query`/`excludedPaths`/`includeHidden`/
  `respectGitignore`），少一个是边界校验失败；空查询在客户端就拦住，否则等于把整个
  工作区扫一遍。
- **参数是扁平的命名参数**，包一层 `request` 会得到 `args fields do not match the
  descriptor`（只有 `search` 的第二个字段才叫 `request`）。

还有一个和设置页同款的坑：越界错误的文本也有两种写法 —— 有时带
`workspace-file/outside-workspace` 前缀，有时只有一句 `"/" is outside the workspace`。
`describeWorkspaceError` 两种都认（同样是被 `test/live_workspace.ts` 逼出来的）。

### 图片也能从手机发出去

对话页输入框旁边多了一个「图片」按钮：走 `@ohos.file.photoAccessHelper` 的
`PhotoViewPicker` 选一张，用 `fileIo` 读成字节，编成 `{type:'image', mediaType, data}`
随消息发出。历史里来的图片只显示「N 张图片」而不去取字节 —— 手机上暂时不画缩略图，
取字节要另一次往返。

数据侧在 `src/composer.ts`，`test/composer.ts` 钉形状，`test/live_composer.ts` 打真
Host（建一个空会话、发一条带图的 prompt、轮询等 `user/message`、再取回字节比对）。
三个坑：

- **`data` 是标准 base64，不是 base64url**（要带 `=` 填充，字母表是 `+/`）。用
  base64url 发过去 Host 解出来是错字节，报错只说图片读不出来。为此在 `bytes.ts` 里
  补了 `encodeBase64`，并用 Node `Buffer` 对过 10 种长度。
- **空 `content` 不是「空消息」**，Host 会把它读成「继续上一轮」，于是误点会真的让
  电脑再跑一遍。`hasContent` 在客户端就拦住；`promptRequest` 也拒绝空数组。
- **`mediaType` 只认四种**（png/jpeg/webp/gif）。相册 uri 常带 `?networkid=…`
  查询串，判后缀前必须切掉，否则 `.jpg?networkid=1` 认不出来。

### 历史里的图片也能看见

收回来的方向是另一套：事件里的图片块只有 `{type:'image', attachment:{attachmentId,
mediaType, bytes, width, height}}`，**没有任何字节** —— Host 把字节留在附件表里，
这样一条历史记录不会因为几张图而变重。`src/images.ts` 负责解析引用与拼
`session/attachment` 的请求体，`images.ohos.ts` 负责把回来的 base64 解成
`PixelMap` 并按最长边缩到 1024。

三个坑：

- **不要预取**。打开一个几百条的会话就把所有图片取一遍，等于几十次加密往返；
  现在是「有一行真的带图」才发请求，而且同一张图按 `attachmentId` 只取一次。
- **`Uint8Array.buffer` 不一定是刚好那一段**。`image.createImageSource` 吃
  `ArrayBuffer`，直接把 `.buffer` 递进去会把底层多余的字节一起喂给解码器，
  必须 `slice(byteOffset, byteOffset + byteLength)`。
- **`PixelMap` 用完要 `release()`**，否则来回翻几次历史就 OOM。缓存放在
  组件的普通字段里而不是 `@State`：原生对象交给状态系统比较反而更贵，界面靠一个
  整数版本号触发重绘。

`test/images.ts` 钉形状，`test/live_composer.ts` 里最后几条断言把**真实 Host 发回来
的那条记录**喂进同一套解析函数，再用它自己的请求体把字节取一遍 —— 这样单测里
造的形状与真链路必须一致，否则那几条会红。

### 配对码只能粘贴，所以粘贴这件事要做得干净

鸿蒙 SDK **没有条码扫描接口**：`@ohos.scan` 是打印扫描仪（`SystemCapability.Print.PrintFramework`），
相机里的 `MetadataObjectType.BAR_CODE_DETECTION` 只回调「这里有个条码」的位置与时间戳，
`MetadataBarcodeObject` 是空接口 —— 拿不到内容。50 个 kit 里也没有 ScanKit / VisionKit。
要做扫码只能接 HMS Scan Kit（需华为账号）或自己用 Camera + 纯 ArkTS 解码。后者已经做完，
见下面「二维码解码器」一节。

于是粘贴成了唯一入口，而粘贴的输入比想象中脏：用户通常整行复制电脑日志

```
2026-11-22T04:00:00.000+08:00 INFO  pocket-harness pocket-harness: pairing code pocketharness://pair?t=...
```

`src/pairing_text.ts` 因此负责三件事，`Index.ets` 每输入一个字就重跑一次：

- **在一整段文字里找配对码**。按 base64url 字符集走到第一个非它的字符为止 —— 这比
  正则去匹配整条 URL 稳，行尾的句号、引号、逗号会被自然截掉而不是被当成载荷。
- **把「找不到」与「读不出」分开说**。前者是复制错了东西（提示以 `pocketharness://pair?t=`
  开头），后者细分「只复制到一半」（指标签被截断）与「码被改动过」。
- **让用户在连之前核对是不是这台电脑**，并显示 `还剩 N 分钟`。配对码 10 分钟轮换，
  最常踩的坑正是拿昨天的码去连，而界面只会说「配对码不匹配」。

`test/pairing_text.ts` 用真实日志行、带引号、带行尾标点、截断、两个码连着贴这几种输入
钉住上面每一条。粘贴本身走 `pasteboard.getSystemPasteboard().getData().getPrimaryText()`。

### 会话列表要能筛

`session/list` 这个部署一次返回 800 多个会话，**没有分页**，所以 ArkTS 侧和 Flutter 侧
都只能在前端筛。`filterSessionRows` 只比 `title` 与 `detail`（目录或相对时间），不比
`sessionId` —— 那是一串机器生成的 id，没人会想起来搜它。

与 `filterSkills` 相反的一条：**空查询返回全部**，而技能筛选的空查询返回空。两个列表
的默认状态不同 —— 技能面板是「点了才出现」的挑选器，空输入时没什么可选；会话列表是
一打开就在那儿的全部内容，空输入时必须还是全部，否则一进页面就空白。这条差异在
`test/session_rows.ts` 里专门有一条断言守着，防止以后被"统一"掉。

### 后台任务：一条不会结束的流

`job/list` 是**流**，首帧就是整集 `{type:"rows", jobs:[...]}`，而且之后**流不结束**。所以
只能取第一帧；等 `done` 会永远等下去。手机上做的是每 5 秒重取一次第一帧，而不是订一条
永不结束的流 —— 这一页是看一眼就走的，秒级同步没有意义，轮询让代码少一层状态。

`job/follow` 相反，它回 `opened` → 若干 `output` → `status` 后**自己结束**，所以可以
一路读到 `done`。`output` 帧里的 `chunks[]` 要按顺序把 `text` 拼起来；`lossy: true` 表示
中间有一段输出已经被电脑丢掉（超过它保留的上限），界面必须说出来，否则会让人以为命令
只输出了这么点。

`job/kill` 对**已经结束**的任务回 `{outcome:"already-finished"}` 而不是报错。所以界面
不能说「已终止」，要说「这个任务在你说之前就已经结束了」。这条差别只有真 Host 会告诉你，
`test/jobs.ts` 与 `test/live_jobs.ts` 各钉了一半。

**不要在同一个会话里验证「杀活任务」**：那个「运行中」的任务很可能就是当前会话自己的工具
调用，杀它等于把自己掐断。我只对已经结束的任务验证过终止路径。

### agent 的计划：`null` 与空数组是两件事

`session/projections` 的 `values.todos` 有三种形态：**缺键**、**`null`**、**数组**。前两者是
「agent 还没列过计划」，整块面板应当隐藏；空数组是「计划被清空了」，该显示成空表而不是
消失。把 `null` 和 `[]` 混成一个（比如都当成空列表）会让界面在会话刚开始时闪一下空面板。

`todo/write` 事件**整表替换**，条目没有 id —— 最新一帧就是真相，合并反而是错的。状态目前
是 `pending` / `in_progress` / `completed` 三种，但**认不出的状态要原样保留**，否则新版 Host
加一个状态会让整个面板消失。

面板默认收起，只留一行「进度 + 正在做的那条」：对话页的面积属于对话本身。从「没有计划」
变成「有计划」时自动展开一次（这一刻用户最想知道 agent 打算做什么），之后用户收起就保持收起。

扫真实数据有个陷阱：这台机器 869 个会话里只有 54 个带计划，扫前 40 个经常一条也遇不到，
早先的 `live_todos` 因此写成 `sawNull > 0 || sawList > 0`，在「一条都没找到」的情况下仍然
通过。现在改成两条独立断言（两种形状都必须真的见到），并把扫描上限提到 200。

### 二维码解码器：自己写一个，因为 SDK 里没有

上面「配对码只能粘贴」那条的二期方案，就是自己从相机帧里解。`packages/dsh_arkts/src/qr/`
把它做完了：GF(256) + Reed-Solomon、格式信息 BCH(15,5)、版本信息 BCH(18,6)、八种掩码、
zig-zag 取码字、去交织、按版本分档的载荷解析（numeric/alnum/byte/kanji/ECI），再加上
一个灰度图 → 矩阵的采样器。**不依赖任何第三方库**，因为鸿蒙工程里引一个 npm 包同样要过
ArkTS 编译器，而纯整数运算恰恰是跨引擎最容易偏的地方 —— 自己写、自己钉金标，反而更稳。

范围划得很清楚：`sampler.ts` **只处理轴对齐、整像素模块的图**，这正好覆盖「电脑屏幕上渲染出来的
配对码」。真实相机帧不是这样 —— 码在场景某处、模块落在非整数像素上、画面还常常是歪的 —— 所以
另有一条 `scan.ts`：Otsu 阈值（不写死 128，屏幕暗一点就不会全黑）、按 1:1:3:1:1 的行程找三个
定位图案、用三个中心解仿射映射后逐模块采样。仿射能吃掉旋转与缩放，吃不掉**透视**（斜着拍），
那需要单应性；这一条同样不在范围内，理由和上面一样：没有测试台就不假装支持。

四条金标由 `packages/dsh_arkts/tools/gen_qr_fixtures.mjs` 用 node-qrcode 生成，落盘成
`probe/qr_fixtures.json`（125,800 字节，含矩阵与灰度像素两组数据），再用 jsQR 独立解一遍
做交叉验证。**生成器里的矩阵坐标是 `get(row, col)`**：第一版写成 `get(x, y)`，转置后的
二维码依然看起来像二维码（两个定位图案对调后还是定位图案），只有解码出乱码才暴露 ——
这个 bug 的修法是先让格式位逐位等于 `formatBits(level, mask)`，再让 jsQR 把像素解回原文。

`selfcheck.ts` 的 `runQrCheck()` 在 ArkTS 运行时里把三张金标真解一遍（v1-H 单块、
v3-M 单块、v5-M 两块交织，版本分支与块交织都会被走到），再把第一张放大成「每模块 4 像素 +
四周 4 模块静区」的灰度图走一遍采样器。首页有「解三张二维码金标」按钮，点一下就能在设备上
看到结果 —— 这是「扫码配对」这条路的地基检查，因为解码器一旦在设备上偏一位，界面只会说
「找不到配对码」，没人能一眼看出是算术问题。

**二维码解码器也在里面**：`src/qr/` 是纯 ArkTS 可编译的 TypeScript（没有 `TextDecoder`、
没有 `Map` 解构迭代、没有 `new Array(n).fill()`），拷进 `core/qr/` 后 `.abc` 里能搜到
`decodeMatrix`、`matrixFromImage`、`readFormat`、`generatorPolynomial`、`deinterleave`、
`countBits`、`locateSymbol`、`sampleSymbol`。

### 相机帧这条路上钉住的一个真实缺陷

`scan.ts` 的第一版在 4 度、12 度旋转下都能解回原文，27 度就抛 `ReedSolomonError`。原因是
**模块边长是从横向行程量出来的，而旋转会把每一段行程拉长 1/cosθ**：27 度时量出来偏大 12%，
`round(间距/边长) + 7` 于是算出小一号的尺寸（33 而不是 37），后面每个模块都采样到邻格。
修法不是调容差，而是把测量值乘上「符号自身的 x 轴在图像 x 轴上的投影」`|Δx| / 间距`。
两个教训：一是**容差型参数掩盖几何错误**（放宽 tolerance 只会让 27 度偶尔碰巧通过）；二是
**测试要真的把图转起来**，`renderScene` 用逆向映射渲染（场景像素 → 模块坐标），所以旋转、
小数倍模块像素、右下角渐暗这三件事是同时发生在一张图上的，改小任何一件都会让这个 bug 藏回去。

## 二期路线建议

1. 把这份 HAP 旁加载到真机，确认 `@ohos.net.socket` 与 `@ohos.net.webSocket` 在真机上能连（模拟器与真机的网络栈不同）。
2. 把 `runQrCheck` 从「三张硬编码金标」推进到真的相机取帧：`@ohos.multimedia.camera` 的
   `imageReceiver` 回调里拿 YUV 帧、只取 Y 平面转灰度、喂 `matrixFromImage`。**这条路的两个
   难点已经有现成答案**：`frame.ts` 的 `grayFromLuma` 处理 `rowStride`/`pixelStride`（当紧密
   排列读会把图剪斜，看着就是「解不出」）、`scan.ts` 的 `locateFrame` 处理非轴对齐，两者都
   已在自己的单测里钉住。剩下的是帧格式对接与节流：每帧都全图找定位图案太贵，先用
   `shrinkGray` 降一半再扫，扫不到才回全分辨率。
3. 把设备私钥迁到 Asset Store Kit。