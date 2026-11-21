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

- **ArkTS 侧的真编译**：`hvigor` + `restool` + `ets-loader` + `es2abc` 已在本机跑通，产出 `entry-default-unsigned.hap`（546 KB，内含 `ets/modules.abc` 308,308 字节）。这条路只能编原生代码，**编不了 Dart AOT**。
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

## 二期路线建议

1. 把这份 HAP 旁加载到真机，确认 `@ohos.net.socket` 与 `@ohos.net.webSocket` 在真机上能连（模拟器与真机的网络栈不同）。
2. 相机扫码如受阻，先只保留"粘贴配对码"入口。
3. 把设备私钥迁到 Asset Store Kit。
