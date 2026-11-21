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

- **ArkTS 侧的真编译**：`hvigor` + `restool` + `ets-loader` + `es2abc` 已在本机跑通，产出 `entry-default-unsigned.hap`（445 KB，内含 `ets/modules.abc` 235,348 字节）。这条路只能编原生代码，**编不了 Dart AOT**。
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

## 二期路线建议

1. 先在一台 Apple Silicon Mac 上把 HAP 打出来并旁加载，确认 `dart:io` 的 TCP 与 WebSocket 在真机上可用。
2. 相机扫码如受阻，先只保留"粘贴配对码"入口。
3. 把设备私钥迁到 Asset Store Kit。
4. 若要在鸿蒙应用市场上架，需要走 HarmonyOS 分支用 Command Line Tools 重新打包（`compileSdkType` 必须是 HarmonyOS 而非 OpenHarmony）。
