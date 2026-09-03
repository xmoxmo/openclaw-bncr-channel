# Bncr

OpenClaw 的 Bncr 频道插件，用于将 Bncr / 无界客户端接入 OpenClaw，实现消息收发、媒体传输和会话管理。

## 安装

```bash
openclaw plugins install @xmoxmo/bncr
openclaw plugins enable bncr
openclaw gateway restart
```

升级插件：

```bash
openclaw plugins update bncr
openclaw gateway restart
```

当前兼容 `OpenClaw >= 2026.8.1`。

## 客户端接入

1. 安装并启用 `openclawclient.js`。
2. 在客户端填写 OpenClaw 网关地址、端口、SSL 和 gateway token。
3. 启动客户端，等待设备连接请求。
4. 在 OpenClaw 上批准设备：

```bash
openclaw devices approve --latest
```

设备批准后，客户端会保存授权信息并自动重连。

## 基础配置

配置位于 `channels.bncr`。最小配置：

```json
{
  "channels": {
    "bncr": {
      "enabled": true,
      "allowTool": false,
      "outboundRequireAck": true
    }
  }
}
```

常用配置：

| 配置 | 说明 |
| --- | --- |
| `enabled` | 是否启用 Bncr 频道 |
| `dmPolicy` | 私聊策略：`open`、`allowlist`、`disabled` |
| `groupPolicy` | 群聊策略：`open`、`allowlist`、`disabled` |
| `allowFrom` | 私聊允许的用户列表 |
| `groupAllowFrom` | 群聊允许的用户列表 |
| `allowTool` | 是否转发工具消息，默认关闭 |
| `outboundRequireAck` | 出站文本是否等待客户端 ACK，默认开启 |
| `accounts` | 多账号配置 |
| `debug.verbose` | 是否输出详细调试日志 |

多账号示例：

```json
{
  "channels": {
    "bncr": {
      "accounts": {
        "Primary": { "enabled": true, "name": "主账号" },
        "Secondary": { "enabled": true, "name": "备用账号" }
      }
    }
  }
}
```

也可以使用命令生成最小配置：

```bash
openclaw bncr miniconfig
```

## 支持的能力

- 文本消息
- 图片、视频、音频和语音
- 文件传输和媒体附件
- 消息撤回和删除
- 离线排队、ACK、重试和重连
- 多账号、私聊和群聊会话
- 会话历史上下文
- 状态和投递诊断

Agent 可以使用 OpenClaw 标准消息能力发送文本或媒体。需要指定目标会话时，使用 Bncr 目标地址并同时指定 `accountId`。

## 命令

### 基础命令

```text
/bncr help
/bncr whoami
/bncr status
/bncr new
/bncr reset
/bncr verbose on|off|full
/stop
```

`/stop` 只支持精确写法，不支持 `/stop@bot`、`/stop extra` 等变体。

### 场景管理

```text
/bncr allow [<SceneId>]
/bncr deny [<SceneId>]
/bncr bind <agentId> [<SceneId>]
/bncr revoke [<SceneId>]
/bncr list pending [filters...]
/bncr list scenes [filters...]
/bncr mode help
/bncr mode <admin|mention|hybrid|all|clear> [<SceneId>]
```

### 会话历史

```text
/bncr history-help
/bncr history-limit [<number>|clear] [<SceneId>]
/bncr history-force on|off|clear [<SceneId>]
```

会话历史统一累计用户消息和 Bot 回复，默认窗口为 50 条。达到上限后会在后续消息到达时整理并发送历史上下文。

### 远程媒体

```text
/bncr download-media on|off|clear|default on|off [<SceneId>]
```

## 权限规则

管理员可以使用全部 Bncr 命令。管理员发送的裸命令优先交给 OpenClaw 原生命令处理，未处理时才允许交给 Agent；`/bncr` 命令由 Bncr 处理。

非管理员的权限按会话类型区分：

- 私聊允许正常对话；`/whoami`、`/status`、`/new`、`/reset`、`/stop`、`/model`、`/verbose` 等受控命令按对应规则执行，不会以提升后的身份转交 Agent。
- 群聊受当前场景模式控制。未授权场景不会进入正常处理流程。
- `/bncr` 命令始终由 Bncr 识别；未知或不可用的 Bncr 命令会直接提示，不会转交 Agent。
- `/bncr help` 会根据当前会话类型和权限，仅展示当前可用的命令。
- 私聊非管理员使用 `history-*` 或 `download-media` 时，只能操作当前私聊会话，不能通过参数修改其他会话。

## 群聊模式

```text
/bncr mode admin
/bncr mode mention
/bncr mode hybrid
/bncr mode all
/bncr mode clear
```

| 模式 | 说明 |
| --- | --- |
| `admin` | 仅管理员消息触发 |
| `mention` | 需要明确提及 Bot |
| `hybrid` | 按管理员或提及条件处理 |
| `all` | 处理群内符合接入条件的消息 |
| `clear` | 清除当前场景的自定义模式 |

新群聊默认需要管理员授权。管理员可以使用 `/bncr allow`、`/bncr deny`、`/bncr bind` 和 `/bncr revoke` 管理场景。

## 检查状态

```bash
openclaw gateway status
openclaw gateway health
openclaw bncr --help
```

如需查看 Bncr 运行状态，可使用 `/bncr status`。如需排查连接、ACK、队列或媒体问题，再开启 `channels.bncr.debug.verbose` 后重启网关。

## 目标地址

发送到指定会话时使用以下形式：

```text
Bncr:<platform>:0:<userId>
Bncr:<platform>:<groupId>:0
```

示例：

```text
Bncr:tgBot:0:10001
Bncr:tgBot:-1001234567890:0
```

私聊目标使用用户 ID，群聊目标使用群 ID。多账号场景同时指定 `accountId`，避免不同账号之间串用会话或连接。

## 常见问题

### 客户端无法连接

确认 gateway token、网关地址、端口和 SSL 配置正确，并执行：

```bash
openclaw devices approve --latest
openclaw gateway restart
```

### 消息没有发出

检查网关、客户端和 Bncr 状态，确认客户端在线，并查看 ACK 与队列状态。

### 媒体发送失败

确认文件路径可被 OpenClaw 访问，文件类型受宿主和客户端支持，并检查客户端文件传输状态。

### 群聊没有响应

检查场景是否已授权、当前群聊模式以及消息是否满足触发条件：

```text
/bncr status
/bncr list scenes
/bncr mode
```
