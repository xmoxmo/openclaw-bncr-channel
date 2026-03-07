# bncr-channel

OpenClaw 的 Bncr WebSocket Bridge 频道插件（`channelId=bncr`）。

这份文档按“拿到插件就能对接”的目标编写：你只看本 README，也能完成接入。

---

## 1. 概览

- **OpenClaw Channel ID**：`bncr`
- **Bridge Version**：`2`
- **出站事件名**：`bncr.push`
- **出站模式**：`push-only`（不依赖 pull 轮询）
- **活动心跳方法**：`bncr.activity`
- **诊断方法**：`bncr.diagnostics`
- **文件互传方法（V1）**：
  - `bncr.file.init`
  - `bncr.file.chunk`
  - `bncr.file.complete`
  - `bncr.file.abort`
  - `bncr.file.ack`

---

## 2. 工作模式（重点）

当前是 **push-only**：

- Bncr 在线：OpenClaw 通过 WS `event=bncr.push` 直接下发回复。
- Bncr 离线：消息进入 outbox；重连后自动冲队列。
- `bncr.activity` 仅用于在线保活，不承载拉取。
- `bncr.ack` 保留兼容，当前主链路不强依赖。

> 结论：客户端最小实现只需两件事：
> 1) 发 `bncr.inbound`；2) 监听 `bncr.push`。

---

## 3. SessionKey 规则（严格）

标准格式（canonical）：

```text
agent:main:bncr:direct:<hexScope>
```

其中：

- `<hexScope>` = `platform:groupId:userId` 的 UTF-8 十六进制。
- 推荐使用小写 hex（插件兼容大小写输入）。
- 兼容输入会在内部归一到 `agent:main:bncr:direct:<hexScope>`。

示例：

```text
scope      = qq:0:888888
hexScope   = 71713a303a383838383838
sessionKey = agent:main:bncr:direct:71713a303a383838383838
```

---

## 4. Gateway Methods

插件注册方法：

- `bncr.connect`
- `bncr.inbound`
- `bncr.activity`
- `bncr.ack`
- `bncr.diagnostics`
- `bncr.file.init`
- `bncr.file.chunk`
- `bncr.file.complete`
- `bncr.file.abort`
- `bncr.file.ack`

---

## 5. 接入流程（最小可用）

### Step A：建立 WS 并发送 `bncr.connect`

请求示例：

```json
{
  "type": "req",
  "id": "c1",
  "method": "bncr.connect",
  "params": {
    "accountId": "Primary",
    "clientId": "bncr-client-1"
  }
}
```

响应示例：

```json
{
  "type": "res",
  "id": "c1",
  "ok": true,
  "result": {
    "channel": "bncr",
    "accountId": "Primary",
    "bridgeVersion": 2,
    "pushEvent": "bncr.push",
    "online": true,
    "isPrimary": true,
    "activeConnections": 1,
    "pending": 0,
    "deadLetter": 0,
    "diagnostics": {
      "health": {
        "connected": true,
        "pending": 0,
        "deadLetter": 0,
        "activeConnections": 1
      },
      "regression": {
        "ok": true
      }
    },
    "now": 1772476800000
  }
}
```

> `accountId` 示例是 `Primary`，请按你实际配置替换；不传默认使用 `Primary`。

### Step B：上行消息用 `bncr.inbound`

文本请求示例（`msg` 形态）：

```json
{
  "type": "req",
  "id": "i1",
  "method": "bncr.inbound",
  "params": {
    "accountId": "Primary",
    "platform": "qq",
    "groupId": "0",
    "userId": "888888",
    "sessionKey": "agent:main:bncr:direct:71713a303a383838383838",
    "msgId": "msg-1001",
    "type": "text",
    "msg": "你好"
  }
}
```

媒体请求示例（字段是 `base64`）：

```json
{
  "type": "req",
  "id": "i2",
  "method": "bncr.inbound",
  "params": {
    "accountId": "Primary",
    "platform": "qq",
    "groupId": "0",
    "userId": "888888",
    "sessionKey": "agent:main:bncr:direct:71713a303a383838383838",
    "msgId": "msg-1002",
    "type": "image/png",
    "msg": "",
    "base64": "<BASE64_PAYLOAD>",
    "mimeType": "image/png",
    "fileName": "demo.png"
  }
}
```

响应示例：

```json
{
  "type": "res",
  "id": "i1",
  "ok": true,
  "result": {
    "accepted": true,
    "accountId": "Primary",
    "sessionKey": "agent:main:bncr:direct:71713a303a383838383838",
    "msgId": "msg-1001",
    "taskKey": null
  }
}
```

> `bncr.inbound` 先快速 ACK，再异步处理，最终回复经 `bncr.push` 回推。

### Step C：消费 `bncr.push`

事件示例：

```json
{
  "type": "event",
  "event": "bncr.push",
  "payload": {
    "type": "message.outbound",
    "messageId": "3f8b1f9b-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "idempotencyKey": "3f8b1f9b-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "sessionKey": "agent:main:bncr:direct:71713a303a383838383838",
    "message": {
      "platform": "qq",
      "groupId": "0",
      "userId": "888888",
      "type": "text",
      "msg": "收到，已处理。",
      "path": "",
      "base64": "",
      "fileName": ""
    },
    "ts": 1772476801234
  }
}
```

---

## 6. 字段协议

### 6.1 Bncr -> OpenClaw（`bncr.inbound`）

常用字段：

- `accountId`：可选（默认 `Primary`）
- `platform`：必填
- `groupId`：可选，默认 `"0"`（私聊）
- `userId`：建议填写（私聊/群聊都建议带上）
- `sessionKey`：可选，建议传严格 sessionKey
- `msgId`：建议传（便于短窗口去重）
- `type`：`text/image/video/file/...`
- `msg`：文本
- `base64`：媒体 base64
- `path`：可选，文件直传完成后的落盘路径（与 `base64` 二选一）
- `mimeType` / `fileName`：媒体元数据（可选）

校验失败常见错误：

- `platform/groupId/userId required`

#### 6.1.1 任务分流前缀（可选）

`msg` 支持前缀：

- `#task:foo`
- `/task:foo`
- `/task foo 正文...`

命中后会把会话键附加为 `:task:<taskKey>` 用于子任务分流，ACK 中会返回 `taskKey`。

### 6.2 OpenClaw -> Bncr（`bncr.push`）

关键字段：

- `type`（固定 `message.outbound`）
- `messageId`
- `idempotencyKey`（当前等于 `messageId`）
- `sessionKey`
- `message.platform/groupId/userId`
- `message.type/msg/path/base64/fileName/mimeType`
- `message.transferMode`（媒体场景可出现：`base64`/`chunk`）
- `ts`

说明：

- 主类型固定为 `type="message.outbound"`。
- 推荐客户端仅消费 `message.outbound` 主链路。

---

## 7. `message.send(channel=bncr)` 目标解析规则（重要）

发送前支持并兼容以下 6 种目标输入：

1. `agent:main:bncr:direct:<hex>`
2. `agent:main:bncr:group:<hex>`
3. `bncr:<hex>`
4. `bncr:g-<hex>`
5. `bncr:<platform>:<groupId>:<userId>`
6. `bncr:g-<platform>:<groupId>:<userId>`

推荐写法：

- `to=bncr:<platform>:<groupId>:<userId>`

内部会做**反查校验**：

- 必须在已知会话路由中反查到真实 session 才发送。
- 查不到会报：`target not found in known sessions`。

---

## 8. 文件互传（V1）

### 8.1 OpenClaw -> Bncr（下行媒体）

当前默认 **强制分块**（chunk）传输：

- `bncr.file.init`
- `bncr.file.chunk`
- `bncr.file.complete`
- Bncr 客户端通过 `bncr.file.ack` 回 ACK

特性：

- 分块大小默认 256KB
- chunk ACK 超时/失败会重试
- 完成后 `message.outbound.message.path` 回填客户端可用路径

### 8.2 Bncr -> OpenClaw（上行文件）

Bncr 客户端可通过：

- `bncr.file.init`
- `bncr.file.chunk`
- `bncr.file.complete`
- `bncr.file.abort`

完成上传后，OpenClaw 会落盘并在后续 `bncr.inbound` 中通过 `path` 传递。

---

## 9. 可靠性

- 离线入队 + 重连自动冲队列。
- 指数退避：`1s,2s,4s,8s...`
- 最大重试次数：`10`
- 超限进入 dead-letter。

---

## 10. 状态判定与诊断

- 实际链路在线：`linked`
- 已配置但离线：`configured`
- 账户卡片离线展示口径会显示 `Status`

常用状态字段：

- `pending`
- `deadLetter`
- `lastSessionKey`
- `lastSessionScope`（`bncr:platform:group:user`）
- `lastSessionAt`
- `lastActivityAt`
- `lastInboundAt`
- `lastOutboundAt`
- `diagnostics`

`diagnostics` 中包含：

- `health`：连接数、pending、dead-letter、事件计数、uptime
- `regression`：已知路由数、无效 sessionKey 残留、账号残留等

---

## 11. FAQ

### Q1：为什么看不到回复？

1. 先确认 `bncr.connect` 成功。
2. 客户端确认监听的是 `bncr.push`。
3. `sessionKey` 是否符合规范。
4. 若用 `message.send`，目标是否能反查到已知会话。

### Q2：为什么不需要 `bncr.pull`？

因为当前是 push-only，统一走 `bncr.push`。

### Q3：如何避免重复消息？

- 入站带稳定 `msgId`。
- 出站按 `idempotencyKey` 幂等处理。
- 客户端侧建议仅消费 `message.outbound`，并按需过滤 `NO_REPLY/HEARTBEAT_OK`。

### Q4：如何看桥接健康状态？

- 可直接调用 `bncr.diagnostics`。
- 或看 `bncr.connect`/状态卡片中的 `diagnostics` 字段。

---

## 12. 版本提示

历史版本接入过的话，请以当前文档（push-only + 6 格式目标兼容 + 文件互传 V1 + 诊断字段）为准。
