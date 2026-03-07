# @xmoxmo/bncr

OpenClaw 的 Bncr WebSocket Bridge 频道插件（`channelId=bncr`）。

> 目标：只看这一份 README，就能完成接入、联调和排障。

## 🚀 QuickStart（30 秒）

1) 建立 WS 并发送 `bncr.connect`（拿到 `pushEvent=bncr.push`）  
2) 用 `bncr.inbound` 上行（建议带 `msgId`）  
3) 监听 `bncr.push`，只处理 `type=message.outbound`

最小消息链路（可直接抄）：

```json
{
  "type": "req",
  "id": "c1",
  "method": "bncr.connect",
  "params": { "accountId": "Primary", "clientId": "demo-client" }
}
```

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

```json
{
  "type": "event",
  "event": "bncr.push",
  "payload": {
    "type": "message.outbound",
    "messageId": "...",
    "sessionKey": "agent:main:bncr:direct:71713a303a383838383838",
    "message": {
      "platform": "qq",
      "groupId": "0",
      "userId": "888888",
      "type": "text",
      "msg": "收到，已处理。"
    }
  }
}
```

主动发送推荐写法（`message.send(channel=bncr)`）：

- `to=bncr:<platform>:<groupId>:<userId>`

> 注意：目标会做“已知会话反查”，若未建立过会话会报 `target not found in known sessions`。

## 📦 OpenClaw 快速安装插件

> 适合直接放在服务器/主机上一步到位安装。

### 1) 安装并启用

```bash
openclaw plugins install @xmoxmo/bncr
openclaw plugins enable bncr
openclaw gateway restart
```

### 2) 验证是否生效

```bash
openclaw plugins list
openclaw status
```

### 3) 推荐：固定版本安装（生产环境）

```bash
openclaw plugins install @xmoxmo/bncr@0.0.3 --pin
```

### 4) 更新 / 卸载（可选）

```bash
openclaw plugins update bncr
openclaw plugins uninstall bncr
```

### 5) 常见提示

- 如果出现 `plugins.allow is empty` 相关提示，建议在配置里把可信插件显式加入 allow 列表。
- 安装后若通道仍未显示，优先执行一次 `openclaw gateway restart` 再看状态。

---

## 1) 概览

- **NPM 包名**：`@xmoxmo/bncr`
- **OpenClaw Channel ID**：`bncr`
- **Bridge Version**：`2`
- **主下行事件**：`bncr.push`
- **工作模式**：`push-only`（不依赖 pull）
- **在线保活方法**：`bncr.activity`
- **诊断方法**：`bncr.diagnostics`
- **文件互传方法（V1）**：
  - `bncr.file.init`
  - `bncr.file.chunk`
  - `bncr.file.complete`
  - `bncr.file.abort`
  - `bncr.file.ack`

---

## 2) 工作模式（重点）

当前为 **push-only**：

- Bncr 在线：OpenClaw 通过 `event=bncr.push` 主动推送回复。
- Bncr 离线：消息进入 outbox；重连后自动冲队列。
- `bncr.activity` 只用于刷新在线活跃状态，不承担拉取。
- `bncr.ack` 保留兼容，主链路不强依赖。

> 客户端最小实现：
>
> 1. 发送 `bncr.inbound`
> 2. 监听 `bncr.push`

---

## 3) SessionKey 规则（canonical）

标准格式：

```text
agent:main:bncr:direct:<hexScope>
```

其中：

- `<hexScope>` = `platform:groupId:userId` 的 UTF-8 十六进制
- 推荐小写 hex（插件兼容大小写输入）
- 插件会兼容 `group` 形式并归一到 `direct`

示例：

```text
scope      = qq:0:888888
hexScope   = 71713a303a383838383838
sessionKey = agent:main:bncr:direct:71713a303a383838383838
```

---

## 4) Gateway Methods

插件注册的方法：

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

## 5) 接入流程（最小可用）

### Step A：建立 WS 并发送 `bncr.connect`

请求：

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

响应（示例）：

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

说明：

- `accountId` 不传时默认折叠为 `Primary`（历史 `default/primary` 也会折叠）。

### Step B：上行消息用 `bncr.inbound`

文本（`msg`）示例：

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

媒体（`base64`）示例：

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

响应（示例）：

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

说明：

- `bncr.inbound` 是 **先 ACK、后异步处理**。
- AI 最终回复统一经 `bncr.push` 推送。

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

## 6) 字段协议

### 6.1 Bncr -> OpenClaw（`bncr.inbound`）

常用字段：

- `accountId`：可选（默认 `Primary`）
- `platform`：必填
- `groupId`：可选，默认 `"0"`
- `userId`：建议必填
- `sessionKey`：可选，建议传 canonical
- `msgId`：建议传（用于短窗口去重）
- `type`：`text/image/video/file/...`
- `msg`：文本
- `base64`：媒体内容
- `path`：可选（文件分块上行完成后的路径）
- `mimeType` / `fileName`：媒体元数据（可选）

常见校验错误：

- `platform/groupId/userId required`

#### 6.1.1 任务分流前缀（可选）

`msg` 支持任务前缀：

- `#task:foo`
- `/task:foo`
- `/task foo 正文...`

命中后会把会话键附加 `:task:<taskKey>`，ACK 中会返回 `taskKey`。

#### 6.1.2 去重窗口

- 有 `msgId`：按 `accountId+platform+groupId+userId+msgId` 去重
- 无 `msgId`：按文本/媒体摘要去重
- 去重窗口约 90 秒

### 6.2 OpenClaw -> Bncr（`bncr.push`）

关键字段：

- `type`（固定 `message.outbound`）
- `messageId`
- `idempotencyKey`（当前等于 `messageId`）
- `sessionKey`
- `message.platform/groupId/userId`
- `message.type/msg/path/base64/fileName/mimeType`
- `message.transferMode`（媒体可能为 `base64` / `chunk`）
- `ts`

客户端建议：

- 仅消费 `type=message.outbound` 主链路
- 按需过滤 `NO_REPLY/HEARTBEAT_OK`

---

## 7) `message.send(channel=bncr)` 目标解析规则（重要）

发送时兼容以下 6 种输入：

1. `agent:main:bncr:direct:<hex>`
2. `agent:main:bncr:group:<hex>`
3. `bncr:<hex>`
4. `bncr:g-<hex>`
5. `bncr:<platform>:<groupId>:<userId>`
6. `bncr:g-<platform>:<groupId>:<userId>`

推荐写法：

- `to=bncr:<platform>:<groupId>:<userId>`

发送前会做“已知会话反查校验”：

- 能反查到：归一后发送
- 反查不到：报错 `target not found in known sessions`

> 实务建议：先让对端至少发过一次 `bncr.inbound`，建立会话路由后再主动发。

---

## 8) 文件互传（V1）

### 8.1 OpenClaw -> Bncr（下行媒体）

默认 **强制分块**（`FILE_FORCE_CHUNK=true`）：

- 事件：`bncr.file.init` -> `bncr.file.chunk` -> `bncr.file.complete`
- Bncr 侧通过 `bncr.file.ack` 回 ACK

参数口径：

- chunk 大小：`256KB`
- 单 chunk 重试：`3` 次
- chunk ACK 超时：`30s`

完成后：

- `bncr.file.ack(stage=complete)` 可回传落地 `path`
- `message.outbound.message.path` 会携带可用路径

### 8.2 Bncr -> OpenClaw（上行文件）

Bncr 侧调用：

- `bncr.file.init`
- `bncr.file.chunk`
- `bncr.file.complete`
- `bncr.file.abort`

完成后 OpenClaw 校验并落盘，在后续 `bncr.inbound` 中可通过 `path` 传递。

---

## 9) 可靠性与重试

- 离线入队 + 重连自动冲队列
- 指数退避：`1s, 2s, 4s, 8s...`
- 最大重试次数：`10`
- 超限进入 dead-letter

---

## 10) 状态与诊断

状态关键字段：

- `pending`
- `deadLetter`
- `lastSessionKey`
- `lastSessionScope`（展示为 `bncr:platform:group:user`）
- `lastSessionAt`
- `lastActivityAt`
- `lastInboundAt`
- `lastOutboundAt`
- `diagnostics`

`diagnostics` 包含：

- `health`：连接数、pending、dead-letter、事件计数、uptime
- `regression`：已知路由数、异常 sessionKey 残留、账号残留等

状态摘要（`healthSummary`）格式：

- 正常：`diag:ok p:<pending> d:<dead> c:<conn>`
- 异常：`diag:warn ...`（并附带 `invalid/legacy` 计数）

---

## 11) FAQ

### Q1：为什么看不到回复？

1. `bncr.connect` 是否成功
2. 客户端是否在监听 `bncr.push`
3. `sessionKey` 是否符合 canonical
4. 若用 `message.send`，目标是否能反查到已知会话

### Q2：为什么不需要 `bncr.pull`？

当前是 push-only，统一走 `bncr.push`。

### Q3：如何避免重复消息？

- 入站带稳定 `msgId`
- 出站按 `idempotencyKey` 做幂等
- 客户端仅消费 `message.outbound` 主链路

### Q4：怎么查看桥接健康状态？

- 调 `bncr.diagnostics`
- 或看 `bncr.connect` / 插件状态卡片里的 `diagnostics`

---

## 12) 版本迁移提示

如果你接过老版本，请以当前口径为准：

- push-only
- 6 格式目标兼容 + canonical 统一
- 文件互传 V1（默认强制分块）
- 诊断字段与 `healthSummary` 统一口径
