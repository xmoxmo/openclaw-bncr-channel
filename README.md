# bncr-channel

OpenClaw 的 Bncr WebSocket Bridge 频道插件（`channelId=bncr`）。

这份文档按“拿到插件就能对接”的目标编写：你只看本 README，也能完成接入。

---

## 1. 你会得到什么

- **OpenClaw Channel ID**：`bncr`
- **Bridge Version**：`2`
- **出站事件名**：`bncr.push`
- **出站模式**：`push-only`（不再依赖 pull 轮询）
- **活动心跳方法**：`bncr.activity`（用于轻量在线保活）

---

## 2. 工作模式（重点）

本插件当前是 **push-only**：

- Bncr 在线：OpenClaw 通过 WS `event=bncr.push` 直接下发回复。
- Bncr 离线：消息进入 outbox；重连后自动冲队列。
- `bncr.activity` 用于活动心跳（刷新在线状态，不承载消息拉取）。
- `bncr.ack` 兼容保留，**非必需**（当前为 fire-and-forget，不依赖 ack 出队）。

> 结论：新客户端只需要做两件事：
> 1) 发 `bncr.inbound` 上行消息；2) 消费 `bncr.push` 下行消息。

---

## 3. SessionKey 规则（严格）

仅接受一种格式：

```text
agent:main:bncr:direct:<hexScope>
```

其中：

- `<hexScope>` 是 `platform:groupId:userId` 的 UTF-8 十六进制编码。
- 仅允许小写十六进制字符（`0-9a-f`，且长度为偶数）。
- **不兼容**旧格式（如 `...:<hexScope>:0`、`agent:main:bncr:<hexScope>:0` 等）。

### 3.1 编码示例

原始 scope：

```text
qq:123456:888888
```

hex 后（示例）：

```text
71713a3132333435363a383838383838
```

最终 sessionKey：

```text
agent:main:bncr:direct:71713a3132333435363a383838383838
```

---

## 4. Gateway Methods

插件注册了以下网关方法：

- `bncr.connect`
- `bncr.inbound`
- `bncr.activity`（活动心跳，推荐客户端节流调用）
- `bncr.ack`（兼容保留，非必需）

---

## 5. 接入流程（最小可用）

### Step A：建立 WS 并发送 `bncr.connect`

请求（示例）：

```json
{
  "type": "req",
  "id": "c1",
  "method": "bncr.connect",
  "params": {
    "accountId": "default",
    "clientId": "bncr-client-1"
  }
}
```

成功响应（示例）：

```json
{
  "type": "res",
  "id": "c1",
  "ok": true,
  "result": {
    "channel": "bncr",
    "accountId": "default",
    "bridgeVersion": 2,
    "pushEvent": "bncr.push",
    "online": true,
    "isPrimary": true,
    "activeConnections": 1,
    "pending": 0,
    "deadLetter": 0,
    "now": 1772476800000
  }
}
```

### Step B：上行消息用 `bncr.inbound`

请求（文本示例）：

```json
{
  "type": "req",
  "id": "i1",
  "method": "bncr.inbound",
  "params": {
    "accountId": "default",
    "platform": "qq",
    "groupId": "0",
    "userId": "888888",
    "scope": "agent:main:bncr:direct:71713a303a383838383838",
    "msgId": "msg-1001",
    "type": "text",
    "text": "你好"
  }
}
```

成功响应（示例）：

```json
{
  "type": "res",
  "id": "i1",
  "ok": true,
  "result": {
    "accepted": true,
    "accountId": "default",
    "sessionKey": "agent:main:bncr:direct:71713a303a383838383838",
    "msgId": "msg-1001",
    "taskKey": null
  }
}
```

> 说明：`bncr.inbound` 会先快速 ACK，再异步触发 OpenClaw 处理并经 `bncr.push` 回推结果。

### Step C：消费 `bncr.push`

事件（文本示例）：

```json
{
  "type": "event",
  "event": "bncr.push",
  "payload": {
    "type": "message.outbound",
    "messageId": "3f8b1f9b-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "idempotencyKey": "3f8b1f9b-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "sessionKey": "agent:main:bncr:direct:71713a303a383838383838",
    "platform": "qq",
    "groupId": "0",
    "userId": "888888",
    "msg": "收到，已处理。",
    "text": "收到，已处理。",
    "mediaBase64": "",
    "messageType": "text",
    "ts": 1772476801234
  }
}
```

媒体事件（示例字段差异）：

- `messageType = "media"`
- 包含 `mediaBase64`
- 可能包含 `mimeType`、`fileName`、`mediaType`

---

## 6. 字段协议

### 6.1 Bncr -> OpenClaw（`bncr.inbound`）

常用字段：

- `accountId`：可选，默认 `default`
- `platform`：必填
- `groupId`：建议必填；私聊可用 `"0"`
- `userId`：必填
- `scope`：建议传严格 sessionKey（见第 3 节）
- `msgId`：建议必填（用于去重）
- `type`：`text/image/video/file/...`
- `text` 或 `msg`：文本内容
- `mediaBase64`：媒体内容（base64）
- `mimeType` / `fileName`：媒体可选元数据

校验失败时常见错误：

- `platform/userId required`

### 6.2 OpenClaw -> Bncr（`bncr.push`）

关键字段：

- `messageId`
- `idempotencyKey`（当前等于 `messageId`）
- `sessionKey`
- `platform` / `groupId` / `userId`
- `msg` / `text`
- `mediaBase64`（媒体时）
- `messageType`（`text` / `media`）
- `ts`

---

## 7. 重试与可靠性

- 离线入队 + 重连自动冲队列。
- 指数退避：`1s, 2s, 4s, 8s...`
- 最大重试次数：`10`
- 超限进入 dead-letter。

---

## 8. 状态判定与观测

- WS 在线且心跳有效：状态应为 **linked**。
- 已配置但离线：状态应为 **configured**。

状态快照常用字段：

- `lastSessionKey`
- `lastSessionScope`
- `lastSessionAt`
- `lastActivityAt`
- `lastActivityAgo`
- `pending`
- `deadLetter`

---

## 9. 兼容接口说明（旧客户端）

### `bncr.activity`

用于客户端活动保活（刷新在线状态），推荐结合节流策略（例如 60s 一次）。

请求示例：

```json
{
  "type": "req",
  "id": "a1",
  "method": "bncr.activity",
  "params": {
    "accountId": "primary",
    "clientId": "bncr-client-1",
    "reason": "heartbeat"
  }
}
```

响应示例：

```json
{
  "type": "res",
  "id": "a1",
  "ok": true,
  "result": {
    "accountId": "primary",
    "ok": true,
    "event": "activity",
    "activeConnections": 1,
    "pending": 0,
    "deadLetter": 0,
    "now": 1772476800000
  }
}
```

### `bncr.ack`

可调用，但在当前模式下不是必需链路。

---

## 10. 常见问题（FAQ）

### Q1：为什么看不到回复？

先检查：

1. 是否先成功 `bncr.connect`。
2. 客户端是否监听了 `bncr.push`（不是只监听 `chat` / `agent` 事件）。
3. `scope/sessionKey` 是否严格符合 `agent:main:bncr:direct:<hexScope>`。

### Q2：为什么我不需要 `bncr.pull`？

因为插件已切换 push-only，消息下发统一走 `bncr.push`。客户端如需维持在线状态，调用 `bncr.activity` 即可。

### Q3：重复消息如何避免？

- 入站建议总是带稳定的 `msgId`，插件有短窗口去重。
- 出站可按 `idempotencyKey`（当前同 `messageId`）做幂等处理。

---

## 11. 对接建议（生产）

- 一个逻辑账号维持一个主连接，避免热重载拉起多个活跃连接。
- 保留自动重连，并在重连后立即再次 `bncr.connect`。
- 对 `bncr.push` 做幂等落地（按 `idempotencyKey`）。
- 记录 `sessionKey -> 路由` 映射，便于排障。

---

## 12. 版本提示

如果你在历史版本上对接过：

- 现在请按本文档以 **push-only + strict sessionKey** 为准。
- 旧 sessionKey 形态与 pull 主链路均不再作为当前标准用法。
