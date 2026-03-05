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

---

## 2. 工作模式（重点）

当前是 **push-only**：

- Bncr 在线：OpenClaw 通过 WS `event=bncr.push` 直接下发回复。
- Bncr 离线：消息进入 outbox；重连后自动冲队列。
- `bncr.activity` 仅用于在线保活，不承载拉取。
- `bncr.ack` 兼容保留，当前不是必需链路（fire-and-forget）。

> 结论：客户端最小实现只需两件事：
> 1) 发 `bncr.inbound`；2) 监听 `bncr.push`。

---

## 3. SessionKey 规则（严格）

严格格式：

```text
agent:main:bncr:direct:<hexScope>
```

其中：

- `<hexScope>` = `platform:groupId:userId` 的 UTF-8 hex（小写）。
- 仅允许 `0-9a-f` 且长度为偶数。
- 旧格式（如 `...:<hexScope>:0`）不再作为标准形态。

示例：

```text
scope     = qq:0:888888
hexScope  = 71713a303a383838383838
sessionKey= agent:main:bncr:direct:71713a303a383838383838
```

---

## 4. Gateway Methods

插件注册：

- `bncr.connect`
- `bncr.inbound`
- `bncr.activity`
- `bncr.ack`

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
    "accountId": "primary",
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
    "accountId": "primary",
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

> `accountId` 示例是 `primary`，请按你实际配置替换；不传默认使用 `default`。

### Step B：上行消息用 `bncr.inbound`

文本请求示例（`msg` 形态）：

```json
{
  "type": "req",
  "id": "i1",
  "method": "bncr.inbound",
  "params": {
    "accountId": "primary",
    "platform": "qq",
    "groupId": "0",
    "userId": "888888",
    "scope": "agent:main:bncr:direct:71713a303a383838383838",
    "msgId": "msg-1001",
    "type": "text",
    "msg": "你好"
  }
}
```

文本请求示例（`text` 别名，代码同样兼容）：

```json
{
  "type": "req",
  "id": "i1b",
  "method": "bncr.inbound",
  "params": {
    "accountId": "primary",
    "platform": "qq",
    "groupId": "0",
    "userId": "888888",
    "scope": "agent:main:bncr:direct:71713a303a383838383838",
    "msgId": "msg-1001b",
    "type": "text",
    "text": "你好"
  }
}
```

媒体请求示例（字段是 `mediaBase64`）：

```json
{
  "type": "req",
  "id": "i2",
  "method": "bncr.inbound",
  "params": {
    "accountId": "primary",
    "platform": "qq",
    "groupId": "0",
    "userId": "888888",
    "scope": "agent:main:bncr:direct:71713a303a383838383838",
    "msgId": "msg-1002",
    "type": "image/png",
    "msg": "",
    "mediaBase64": "<BASE64_PAYLOAD>",
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
    "accountId": "primary",
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

- `accountId`：可选（默认 `default`）
- `platform`：必填
- `groupId`：可选，默认 `"0"`（私聊）
- `userId`：必填
- `scope`：可选，建议传严格 sessionKey（见第 3 节）
- `msgId`：建议传（便于短窗口去重）
- `type`：`text/image/video/file/...`
- `msg`（或兼容 `text`）：文本
- `mediaBase64`：媒体 base64
- `mimeType` / `fileName`：媒体元数据（可选）

校验失败常见错误：

- `platform/userId required`

#### 6.1.1 openclawclient.js（发送端）对齐说明

基于你当前附件版本（`openclawclient` 注释版本 `0.0.2`）核对结果：

- 当前 `inboundSend()` 上行字段是 `sessionKey`；插件入站读取字段是 `scope`。
  - 现状仍可工作（未传 `scope` 时会按 `platform/groupId/userId` 回退路由）。
  - 若要与 strict key 完全对齐，建议把 `sessionKey` 改成 `scope`（值保持 strict sessionKey）。
- 当前 `inboundSend()` 里有 `base64/path/fileName` 占位；插件媒体入站识别字段是 `mediaBase64`。
  - 文本消息不受影响；若后续要上行媒体，请改为 `mediaBase64(+mimeType/fileName)`。
- 当前发送端默认账号写的是 `Primary`（首字母大写）；请确保与网关账户 ID 大小写一致。

### 6.2 OpenClaw -> Bncr（`bncr.push`）

关键字段：

- `messageId`
- `idempotencyKey`（当前等于 `messageId`）
- `sessionKey`
- `message.platform/groupId/userId`
- `message.type/msg/path/base64/fileName`
- `ts`

说明：

- 主类型固定为 `type="message.outbound"`。
- 仅输出嵌套结构 `message.{...}`，不再输出平铺兼容字段。
- 不附带 webchat 的 `stream/state/data` 语义字段。

---

## 7. `message.send(channel=bncr)` 目标解析规则（重要）

插件发送目标支持三种输入：

1. 严格 `sessionKey`
2. `platform:groupId:userId`
3. `Bncr-platform:groupId:userId`

但发送前会做**反查校验**：

- 必须在已知会话路由里反查到真实 `sessionKey` 才会发送。
- 禁止拼凑 key 直接发；查不到会报：`target not found in known sessions`。

---

## 8. 重试与可靠性

- 离线入队 + 重连自动冲队列。
- 指数退避：`1s,2s,4s,8s...`
- 最大重试次数：`10`
- 超限进入 dead-letter。

---

## 9. 状态判定与观测

- 实际链路在线：`linked`
- 已配置但离线：`configured`
- 账户卡片中离线模式会显示 `Status`（展示口径）

常用状态字段：

- `pending`
- `deadLetter`
- `lastSessionKey`
- `lastSessionScope`（`Bncr-platform:group:user`）
- `lastSessionAt`
- `lastActivityAt`
- `lastInboundAt`
- `lastOutboundAt`

> 已知现象：`openclaw status` 顶层与 `status --deep` 在个别版本可能出现口径不一致；排障时优先看 `status --deep` 的 Health。

---

## 10. 兼容接口说明

### `bncr.activity`

用于活动保活，建议节流（例如 60s 一次）。

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

`reason` 为可选自定义字段，插件会忽略业务外字段。

### `bncr.ack`

可调用，但当前模式下不是必需链路。

---

## 11. FAQ

### Q1：为什么看不到回复？

1. 先确认 `bncr.connect` 成功。
2. 客户端确认监听的是 `bncr.push`。
3. `scope/sessionKey` 是否符合严格格式。
4. 若用 `message.send`，目标是否能反查到已知会话。

### Q2：为什么不需要 `bncr.pull`？

因为当前是 push-only，统一走 `bncr.push`。

### Q3：如何避免重复消息？

- 入站带稳定 `msgId`。
- 出站按 `idempotencyKey` 幂等处理。
- 客户端侧建议只消费 `message.outbound` 主链路。

---

## 12. 版本提示

历史版本接入过的话，请以当前文档（push-only + strict sessionKey + 目标反查）为准。
