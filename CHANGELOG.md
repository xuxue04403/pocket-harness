# 更新记录

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## v0.1.0-beta

第一个可以装到手机上用的测试版。范围只有一件事：**用手机远程操控跑在电脑上的 DeepSeek Harness**。

### 能做什么

- **配对**：扫电脑日志里的二维码，或把 `pocketharness://pair?t=...` 整串粘进来。配对码 10 分钟有效，首次连上即把电脑公钥固定在手机上（TOFU），之后不再需要配对码。
- **两条链路**：同一局域网内直接 TCP 直连（`Noise IK` 握手，ChaCha20-Poly1305 帧）；出了局域网自动走你自己部署的中继，中继只见密文。
- **会话**：列出电脑上的全部会话（实测 830 个不卡）、按标题与目录筛选、可选正文检索、新建会话（挑智能体预设与工作目录）、长按改名。
- **对话**：发提示词、逐字流式显示、思考与正文分栏、工具调用与结果卡片、运行中可停止。
- **审批与提问**：电脑上的工具审批和 agent 提问会推到手机上回答；答不上可以一键转回电脑，拒答一律 fail-closed。
- **模型**：按会话切换模型与思考强度（含网关模型），也能改电脑的全局默认模型（带 revision 校验，冲突即拒绝）。
- **图片**：从相册选图随消息发出；历史里的图片按需取回并缓存。
- **工作区文件**：按目录翻、按名字搜、按行读文本（只读）。
- **后台任务**：看会话跑的每条命令、跟随实时输出、远程终止。
- **待办面板**：贴在对话上方显示 agent 的计划与进度，可折叠。
- **会话分支**：从当前会话分出一个副本。
- **技能**：列出电脑上的技能，选中即往输入框追加 `/名称 `。

### 已知限制

- **本机运行 dsh 未开启**：PRoot + Alpine 这条路已经实证能跑起来（`dsh web` 返回 200，见 [docs/mobile-local-dsh.md](mobile-local-dsh.md)），但首次要下载约 1.6 GB 的 rootfs、装完占 2.0 GB，所以这个入口在 beta 里默认不露出。现在支持断点续传（`.part` + `Range`，换镜像也接着下）与装前空间检查（不足 2.6 GB 直接说清楚，不会装到一半 ENOSPC）。要试用可以自行构建：

  ```bash
  flutter build apk --release --dart-define=POCKET_HARNESS_LOCAL_DSH=true
  ```

- **只在 Android 模拟器与构建流水线上验证过**，还没有真机回归。
- **鸿蒙侧不在此版本范围内**：ArkTS 宿主已经能编出**已签名、可校验**的 HAP 并跑通大部分界面（含自研二维码解码器、系统相机扫码），但那是另一条交付线，见 [docs/harmony-packaging.md](harmony-packaging.md)。
- **用的是项目自建 keystore 的 release 签名**（`CN=Pocket Harness`，证书 SHA-256 指纹 `01:A1:01:F8:0B:11:7F:50:B4:43:30:05:51:5C:78:DF:D7:37:D2:56:36:E5:16:F5:D6:50:A2:D1:32:87:FD:69`），不是调试签名，后续同 key 版本可覆盖安装；但没有应用商店级别的签名，装包时系统仍会提示未知来源。keystore 与 `key.properties` 在 `.gitignore` 里，不进仓库。
- 公网中继只在局域网与 loopback 上验证过，**未在公网 VPS 实测**。

### 安全

- 业务数据走 Noise IK（`X25519` + `ChaCha20-Poly1305`），中继与局域网中间设备只见密文。
- 设备私钥只在电脑的 DSH credentials 服务与手机的 keystore 里，不落明文。
- 对端公钥按设备固定，变化即拒绝握手。

### 校验

| 测试面 | 数量 | 命令 |
|---|---|---|
| Dart 协议层 | 46 | `cd packages\dsh_link; dart analyze; dart test` |
| Host 插件与中继 | 13 | `node --test host` |
| TypeScript 协议层（鸿蒙共用） | 22 套 | `cd packages\dsh_arkts; npm test` |
| Flutter 客户端 | 107 | `cd app; flutter analyze; flutter test` |
