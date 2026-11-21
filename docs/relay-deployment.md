# 部署中继（公网访问用）

中继只做两件事：把同一房间的一个 Host 与一个手机凑到一起，然后**原样转发二进制帧**。它看不到密钥，解不开 Noise 会话，也拿不到房间 token 之外的身份信息。

不跑中继也能用——局域网内手机与电脑直连。只有当手机不在同一网络时才需要它。

## 启动

```bash
cd relay
npm install
POCKET_HARNESS_RELAY_TOKEN='<至少 16 字符的随机串>' node run.mjs
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `POCKET_HARNESS_RELAY_TOKEN` | 必填 | 少于 16 字符直接退出；Host 与中继共享它，手机从配对码里拿到同一份 |
| `PORT` | `8080` | 传 `0` 会打印内核分配的真实端口 |
| `HOST` | `0.0.0.0` | 反向代理后面建议改 `127.0.0.1` |

启动后打印 `relay listening on <host>:<port>`；`GET /healthz` 返回 `ok rooms=N`。

生成 token：

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

## 接到 Host

在 Host 插件配置里加 `relayUrl`，值必须是手机能访问到的地址；同时把**中继启动时用的那个 token** 填进 `relayToken`。两者缺一不可：只有 `relayUrl` 时 Host 会拒绝生成带中继的配对码，并在日志里提示 `relayUrl is set but relayToken is missing`，局域网仍然可用。

```json
{
  "relayUrl": "wss://relay.example.com/relay",
  "relayToken": "<中继启动时的 POCKET_HARNESS_RELAY_TOKEN 值>"
}
```

重启 Harness 后，插件日志会显示它以 host 身份加入了房间。此后生成的配对码里会多出中继坐标；手机扫码后**优先尝试局域网**，局域网不通才走中继。

配置写在 profile 的 `cordis.patch.yml` 里，按插件的行 id 覆盖（不要改插件包内的 patch）：

```yaml
- id: pocket-harness-host
  config:
    relayUrl: wss://relay.example.com/relay
    relayToken: <中继启动时的 token>
```

## 反向代理（Caddy）

```
relay.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy 默认支持 WebSocket 升级。用 Nginx 的话需要：

```nginx
location /relay {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

## 容量与限制

| 项 | 值 | 含义 |
|---|---|---|
| 单帧上限 | `4 MiB + 64` | 与协议层一致；超了直接断开 |
| 房间缓冲 | `8 MiB` | 一方变慢时不无限攒包 |
| 房间空闲回收 | `60s` | 两端都断开后房间被清掉 |
| 一房一 host 一 client | — | 第二个 client 以 `4409` 关闭 |
| join 超时 | `10s` | 连上但不发 hello 的以 `4408` 关闭 |

一个房间就是一条手机↔电脑的连接。并发数只受内存与带宽限制；单房间的吞吐主要受 Noise 加解密与网络往返影响，转发本身是零拷贝的 `ws` 管道。

## 房间号与 token 的区别

- **房间号**（`room`）：随机 16 字节 hex，写在配对码里，手机和 Host 都知道。它只是路由标签，泄露了也无法解密任何东西。
- **token**：Host 与中继之间的共享凭据。它**会**写进配对码（手机要拿它才能进房间），所以拿到配对码的人在配对码有效期内也能占住 client 位置——但他过不了 Noise 握手的 proof 校验，读不到任何会话。配对码 10 分钟轮换，过期后这条路径自动失效。

因此即使有人拿到配对码（比如截图），他能做的也只是成为一个 client——而 Noise 握手要求他知道 Host 的静态公钥并完成配对 proof，冒充不了 Host，也读不到别人的会话。

## 排障

| 现象 | 原因 |
|---|---|
| Host 日志反复 `relay closed (…403…)` | `relayToken` 与中继的 `POCKET_HARNESS_RELAY_TOKEN` 不一致 |
| Host 日志 `relayUrl is set but relayToken is missing` | 只配了地址没配 token；插件不会生成带中继的配对码 |
| 手机 15 秒超时 | 中继地址手机访问不到；或 `relayUrl` 写成了 `ws://` 但代理只收 `wss://` |
| 一个手机断开后新手机连不上 | 老版本 Host 的已知问题（僵尸 host 占住房间），已修：`host/relay-socket.js` 在失败时真正关闭 WebSocket |
| `ok rooms=0` 但 Host 说已连接 | 两者连的不是同一个中继进程 |
