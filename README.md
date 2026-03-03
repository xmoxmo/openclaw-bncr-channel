# bncr-channel

OpenClaw 的 Bncr WebSocket Bridge 频道插件。

- **Channel ID:** `bncr`
- **Bridge Version:** `2`
- **Push Event:** `bncr.push`

## 标准安装（OpenClaw）

```bash
openclaw plugins install @xmoxmo/openclaw-bncr-channel
openclaw gateway restart
openclaw plugins doctor
```

更新：

```bash
openclaw plugins update bncr-channel
```

## 当前工作模式（已切换为 push-only）

- 出站消息采用 **push-only**：
  - Bncr 在线时，网关通过 `event=bncr.push` 直接推送。
  - Bncr 离线时，消息进入 outbox 队列，连接恢复后自动冲队列。
- `bncr.pull` 为兼容保留，但固定返回空：`disabled: "push-only-mode"`。
- 当前不依赖 `bncr.ack` 才出队（fire-and-forget）。

## Gateway Methods

- `bncr.connect`
- `bncr.inbound`
- `bncr.pull`（兼容接口，push-only 模式下返回空）
- `bncr.ack`（兼容接口，非必需）

## SessionKey 规则（严格）

仅接受一种格式：

`agent:main:bncr:direct:<hexScope>`

其中：

- `<hexScope>` = `platform:groupId:userId` 的 UTF-8 十六进制编码
- 仅允许小写十六进制字符（`0-9a-f`）
- 不再兼容旧格式（例如带 `:0` 或其它历史形态）

## 帧字段约定

### Bncr -> OpenClaw（入站）

必需/常用字段：

- `platform`
- `groupId`
- `userId`
- `scope`（建议使用上述严格 sessionKey）
- `text` / `msg`
- `msgId`
- `type`（如 `text/image/video/file`）
- `mediaBase64`（媒体消息时）

### OpenClaw -> Bncr（出站）

按 OpenClaw 约定格式发送，并附带：

- `messageId`
- `sessionKey`
- `msg` / `text`
- `mediaBase64`（媒体消息时）

## 状态判定

- 当 Bncr WS 连接在线且心跳有效时，频道状态视为 **enabled / linked**。
- 离线时显示为 **configured**（已配置但未在线）。
- 状态快照包含：
  - `lastSessionKey`
  - `lastSessionScope`
  - `lastSessionAt`
  - `lastActivityAt`
  - `lastActivityAgo`
  - `pending` / `deadLetter`
