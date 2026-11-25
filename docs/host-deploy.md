# 部署 Host 插件

手机要连上跑在电脑上的 DeepSeek Harness，中间只隔这一层：**Host 插件**。它由 Host 侧负责
监听端口、和手机做 Noise 握手、把手机的 RPC 转给 Harness 的 typert gateway。

这份文档讲怎么把它装好、怎么改配置、出问题怎么查。

- 只想尽快用起来 → 看 [最快路径](#最快路径)
- 装完了想知道能调什么 → 看 [配置](#配置)
- 连不上 → 看 [排查](#排查)
- 想走公网 → 先看 [接中继](#接中继)，再看 [relay-deployment.md](relay-deployment.md)

---

## 前提

| 项 | 要求 | 怎么确认 |
| --- | --- | --- |
| DeepSeek Harness | **0.2.2 及以上** | Harness 设置页底部的版本号 |
| 操作系统 | Windows / macOS / Linux 都行 | — |
| 端口 | 默认 `48100/tcp` 可监听 | 见 [端口被占](#端口被占) |
| 网络 | 手机与电脑同一局域网（否则要中继） | 见 [只有公网](#只有公网) |

插件本身**没有 npm 依赖**，也不需要 Node 单独装——它跑在 Harness 的进程里。

---

## 最快路径

### 从 release 装（不用 git）

1. 到 [releases](https://github.com/xuxue04403/pocket-harness/releases) 下载
   `dsh-pocketharness-host-0.1.1.tgz`。
2. 核对完整性（可选，但公网下载建议做）：

   ```powershell
   # PowerShell
   $expected = (Select-String -Path SHA256SUMS.txt -Pattern 'dsh-pocketharness-host').Line.Split(' ')[0]
   (Get-FileHash -Algorithm SHA256 .\dsh-pocketharness-host-0.1.1.tgz).Hash.ToLower() -eq $expected
   ```

   ```bash
   # macOS / Linux
   grep dsh-pocketharness-host SHA256SUMS.txt | sha256sum -c -
   ```

3. 打开 Harness → 设置 → 插件（Plugin Manager）→ 安装 → 目标填**压缩包的绝对路径**。
   Windows 形如 `D:\下载\dsh-pocketharness-host-0.1.1.tgz`；Unix 形如
   `/home/me/下载/dsh-pocketharness-host-0.1.1.tgz`。
4. 装完它会出现在插件列表里，默认已启用。**不需要重启 Harness**。

### 从仓库装（开发用）

插件管理器 → 安装本地目录 → 指向仓库的 `host/`。这条路是目录直链，改完 `host/*.js`
只要在插件列表里关掉再打开一次就生效，不用重新打包。

> `desktop` profile 由 Electron 独占，`dsh plugin` CLI 操作不了它；两种装法都走插件管理器。

---

## 怎么确认装好了

### 1. 日志里会出现两行

```
pocket-harness: link server listening on port 48100
pocket-harness: pairing code pocketharness://pair?t=...
```

日志位置：

| 平台 | 路径 |
| --- | --- |
| Windows | `%USERPROFILE%\.dsh\logs\ft\current.log` |
| macOS / Linux | `~/.dsh/logs/ft/current.log` |

用 PowerShell 盯最新的几行：

```powershell
Get-Content "$env:USERPROFILE\.dsh\logs\ft\current.log" -Tail 20 |
  Select-String 'pocket-harness'
```

配对码每 10 分钟轮换一条，所以隔一会儿再 `-Tail` 会看到新的那条。

### 2. 端口真的在监听

```powershell
Get-NetTCPConnection -LocalPort 48100 -State Listen
```

```bash
ss -ltnp | grep 48100
```

如果没有输出，说明插件没启用，或者端口换成了别的值（见 [改端口](#改端口)）。

### 3. 设置页里有「手机配对」

Harness → 设置 → 左侧应该多出一项 **手机配对**，打开是一张二维码和倒计时。
这张码和日志里那串 `pocketharness://pair?t=...` 是同一张，只是换了呈现方式。

> 如果设置页没有这一项，但日志里两行都在，那是**前端 bundle 没被宿主收进去**：
> 检查 `host/client.js` 是否存在、`host/package.json` 里 `dsh.client` 与 `exports["./client"]` 是否完整。
> 具体见 [前端卡片不出现](#前端卡片不出现)。

### 4. 手机连得上

手机 App 扫码（或手贴配对码）后应当进入会话列表。要到这一步，还需要
[手机端](../app) 与同一台电脑。

---

## 配置

配置写在 profile 的 Cordis 配置里，插件通过 `apply(ctx, config)` 读它。所有键都可省略。

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | bool | `true` | 设 `false` 时插件加载但不开监听，日志打 `disabled by configuration` |
| `hostName` | string | `Pocket Harness Host` | 显示在手机与配对页上的电脑名，多台电脑时用来区分 |
| `port` | number | `48100` | 监听端口。**显式配置时不回落**：被占就直接失败，因为悄悄换端口会让人以为防火墙没开 |
| `bindHost` | string | `0.0.0.0` | 监听地址。只让本机用就设 `127.0.0.1`（此时手机连不上，仅用于调试） |
| `relayUrl` | string | 无 | 中继地址，形如 `wss://relay.example.com/ph-relay` |
| `relayToken` | string | 无 | 与中继共享的 token，**必须和 `relayUrl` 一起给** |

### 配置写在哪

`desktop` profile 的配置在：

```
%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
```

追加一段（`id` 必须与插件 bundle 里的一致，即 `pocket-harness-host`）：

```yaml
- id: pocket-harness-host
  name: dsh-pocketharness-host
  config:
    enabled: true
    hostName: 我的工作站
    port: 48100
```

改完**不用重启**：插件列表里把这一项关掉再打开，配置就重载了。

> 只填 `relayUrl` 不填 `relayToken` 时，日志会打
> `relayUrl is set but relayToken is missing; the LAN listener still works`——
> 局域网照常，公网走不通。这是故意的：半套配置比没有配置更容易让人查半天。

### 改端口

把 `port` 设成想要的值即可。注意两件事：

1. **显式设置的端口不会回落**。占了就失败，日志里有 `EADDRINUSE`。这是为了不让
   防火墙规则与实际监听悄悄错开。
2. 手机端拿到的地址来自插件自己探测的网卡列表，所以改端口后**重新扫码**最稳；
   已经在册的手机会在下次连上时自动取到新地址。

### 只让本机访问

```yaml
    bindHost: 127.0.0.1
```

这样局域网里其他机器（包括手机）都连不上。用途是配合本机转发、或者只想验证握手时。

---

## 接中继

手机与电脑不在同一网络时，需要一个双方都能连到的中转。仓库里带了
[`relay/`](../relay)，也可以部署到自己的 VPS，步骤见
[relay-deployment.md](relay-deployment.md)。

配好中继后在插件配置里加两行：

```yaml
  config:
    relayUrl: wss://relay.example.com/ph-relay
    relayToken: <与中继相同的 token>
```

Host 会**主动出站**连中继，所以电脑这边不需要开放任何入站端口。
手机连上后拿到的票据里会带 `relay`、`room`、`rtok` 三个字段，设置页那张卡片的
「外网可达」会显示「是（经中继）」。

### 中继与局域网是并存的

票据里同时带局域网地址与中继信息。手机端的选择顺序是：

1. 先按 `lan` 列表逐个试（8 秒超时）
2. 局域网全部失败、且票据带中继，才走 `wss://`

所以同一张票在家里走直连、在外面走中继，**不需要重新扫码**。

---

## 排查

### 插件列表里没有它

- 确认 Harness 版本 ≥ 0.2.2。
- 从压缩包装的话，看安装有没有报错；常见原因是路径不是绝对路径，或者文件扩展名不是
  `.tgz`/`.tar.gz`（插件管理器按扩展名判断类型）。
- 从目录装的话，确认指向的是 `host/` 而不是仓库根——`host/` 里要有 `package.json`，
  且 `package.json` 里有 `dsh.bundle.patch`。

### 日志里没有 `listening on port`

按顺序查：

1. 日志有没有 `pocket-harness: disabled by configuration` —— 配置里 `enabled: false`。
2. 有没有 `EADDRINUSE` —— 端口被占，见 [端口被占](#端口被占)。
3. 插件在列表里的状态是不是 `failed`。`plugin_manager` 的 `list_plugins` 里
   `fiberPhase` 应当是 `active`。

### 端口被占

```powershell
Get-NetTCPConnection -LocalPort 48100 -State Listen | Select-Object OwningProcess
Get-Process -Id <上面那个 PID>
```

```bash
ss -ltnp | grep 48100
```

占用的可能是上一份还没退干净的 Harness 进程。要么结束它，要么在配置里换个端口
（例如 `48101`）然后重新扫码。

### 手机连不上

先分清是**局域网**还是**公网**：

| 现象 | 大概率原因 |
| --- | --- |
| 同一 Wi-Fi 下都连不上 | 防火墙拦了 48100；或者 `bindHost` 设成了 `127.0.0.1` |
| 同一 Wi-Fi 能连、出门不行 | 没配中继，或 `relayToken` 填错 |
| 昨天能连、今天不行 | 电脑换了 IP，手机里存的票据是旧的；重连一次让它刷新（见下） |

**防火墙放行**（Windows）：

```powershell
New-NetFirewallRule -DisplayName "Pocket Harness Host" -Direction Inbound `
  -Protocol TCP -LocalPort 48100 -Action Allow -Profile Private
```

只放 `Private`：这是局域网用的，不该出现在咖啡店的公共网络上。

**手机换了网络连不上**：配对成功后手机存的是电脑身份，连上时会自己向电脑要一张
新票据（有效期 30 天）覆盖旧的。所以正常情况下换网络不用重扫。如果电脑把
局域网 IP 从 `192.168.1.x` 换到了别的网段、而且没有配中继，那就真的找不到——
这种情况要么配中继，要么重新扫码。

### 前端卡片不出现

日志里两行都在、端口也在听，但设置页没有「手机配对」。这说明 **Host 侧正常，
是浏览器侧的 bundle 没被装配**。逐项确认：

1. `host/client.js` 存在；
2. `host/package.json` 里有 `"dsh.client": { "platform": "web", ... }`，
   并且 `exports` 里有 `"./client"`；
3. 插件重新加载后，用带 token 的地址访问
   `http://127.0.0.1:<web端口>/api/pocket-harness/pair?format=json`，应当返回 JSON。
   返回 401 是浏览器认证拦的（正常），用 Harness 打印的那条带 `?token=` 的 URL 打开即可。

### 二维码扫不出来

卡片上的二维码按 **每模块 6 像素** 渲染，票据再长也不会小于 240px。如果手机仍读不出：

1. 点卡片上的「打开大图」，用系统相机扫那一页；
2. 确认没有隔着屏幕反光/缩放（截屏再扫经常失败，直接对屏拍更可靠）；
3. 二维码的版本信息块曾在 v0.1.0-beta 里写反（自家解码器也反着读，所以自测一直是绿的），
   v0.1.1 已修。装的是旧包请升级。

---

## 升级与卸载

### 升级

- 压缩包安装：下载新的 `.tgz`，用同样的方式再装一次。插件管理器会替换同名的包。
- 目录安装：`git pull` 后把插件关掉再打开。

升级后**手机不需要重新扫码**：Host 身份存在 Harness 的 credentials 里，不随插件文件变。

### 卸载

插件管理器里移除 `dsh-pocketharness-host` 即可。它会顺带清掉 bundle 注册，
但**不会**删除已配对手机的记录——那份记录在 credentials 里（键
`dsh-pocketharness-host/identity`），想彻底断掉得手动删那条。

端口在卸载后应当立刻释放；如果 `ss`/`netstat` 还能看到 48100，说明 Harness 进程没退干净。

---

## 它到底做了什么

便于排查时对照。插件加载后：

1. 从 credentials 读出或生成一份设备身份（X25519 密钥对 + deviceId），落盘在
   `dsh-pocketharness-host/identity`。
2. 在 `bindHost:port` 上开一个 TCP 监听，等手机连进来。
3. 每 10 分钟换一次配对 secret，把新的配对码写进日志；设置页那张卡片从
   `GET /api/pocket-harness/pair` 取同一张码（这个路由只对回环地址、同源页面、
   以及桌面宿主的 `dsh-app://` 协议开放，其他来源一律 404）。
4. 手机连上后做 Noise IK 握手，用配对 secret 做一次性认证；成功后把这条连接交给
   typert gateway，之后手机发的每个 RPC 都原样转发给 Harness。
5. 如果配了 `relayUrl`，同时向中继拨一条出站连接，房间号存在 credentials 里，
   断线按 1s/2s/5s/10s/30s 退避重连。

**它不做什么**：不解密业务数据（那是手机与 Harness 之间的事）、不记录对话内容、
不主动向外发起除中继以外的连接。
