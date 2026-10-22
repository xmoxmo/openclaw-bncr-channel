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

## 状态目录

Bncr 将持久化状态放在 OpenClaw 状态目录的插件专属子目录：

```text
<stateDir>/plugins/bncr/
├── bncr-bridge-state.json
├── bncr.sqlite3
└── backups/
```

从旧版升级时，启动过程会把 `<stateDir>/bncr-bridge-state.json`、
`<stateDir>/bncr.sqlite3`（包括 WAL 中已提交的数据）和旧版备份复制到新目录。
旧文件会保留用于回滚，已存在的新文件不会被覆盖。
插件状态目录会收紧为 `0700`，其中的状态文件为 `0600`。

`BNCR_SQLITE_STORE=1` 强制启用 SQLite，`BNCR_SQLITE_STORE=0` 强制使用 JSON；
未设置时沿用自动检测。

### 快照与启动自愈

每次成功启动后，插件会在 `backups/` 目录发布一份经 `quick_check` 校验的
SQLite 快照（独占硬链接发布、同秒递增后缀、仅保留最近 3 份）；JSON cutover
备份不受影响。若启动时主库通过完整性校验失败（打开失败、`quick_check`、
外键违规或结构契约漂移），插件会自动晋升 14 天窗口内最新且通过全套启动
校验的快照继续运行，损坏的主库文件归档为 `bncr.sqlite3.corrupt-<时间戳>`
（保留最近 3 份），并在启动日志与 `state_meta` 留痕。迁移 lineage 失败
（数据库来自更新版本或迁移名漂移）不参与自动恢复，保持 fail closed。

### 多 agent 共享状态库（agent 作用域持久化）

多个 agent 共用同一个状态目录（同一份 SQLite 库）时，控制态与 outbox
按 agent 作用域保存，避免互相覆盖：

- `session_routes`：只增删本 agent 键空间（`agent:<id>:bncr:...`）的行；
  其他 agent 的行不受影响。
- `scenes`：只增删 `agent_id` 为本 agent 的行；唯一身份是
  `(agent_id, scene_key)`，两个 agent 服务同一个会话时各自持有自己的
  status、群回复模式与历史上限，不会互相抢占。
- `scenes` 运行态同样按 `(agent_id, scene_key)` 保存全部行（一个 bridge
  可能承载多个 agent 的会话）：入站时按 host 路由到的 agent 取该 agent
  自己的行，其次才用无归属的遗留行，最后才用同名最新行兜底。运行时新建
  的场景自动归属当前 agent，不再写成无人认领的行，重启后设置不会回退成
  默认值。无 agent 归属的遗留行保持不动。
- 场景回写只覆盖本 agent 的行；他人行原样保留，且较新的他人行不会被本
  进程的旧副本覆盖。
- `outbound_messages`：outbox 只重写本 agent 会话前缀的条目；他人条目与
  无 agent 前缀的遗留条目原样保留，加载侧同样按作用域过滤。
- `account_activity`（账号级 lastX）是共享表：不做全量替换，按
  `(account_id, activity_type)` 合并，仅当活动事件时间更新（`event_at`）
  时才覆盖，避免陈旧实例冲掉新活动。
- 无 agent 归属（遗留格式）的 session route 与场景不再被任何实例认领：
  它们留在库中，会话活动时按当前键空间自动重建；宁可不留归属不明的
  映射。
- 无 agent 作用域的调用（单 agent 部署、cutover 导入）保持原有全量
  替换语义。

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
| `allowFrom` | 供宿主识别的 owner/pairing 名单，不参与 Bncr 入站准入 |
| `allowBridgeCall` | 是否允许 `message` 工具把 `bridgeMethod` 原样透传给客户端，默认开启 |
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

### 媒体大小限制

Bncr 的媒体与文件大小只由 OpenClaw 配置层决定，插件内不再维护独立阈值：

```bash
openclaw config set channels.bncr.mediaMaxMb 2048
openclaw config set channels.bncr.accounts.<accountId>.mediaMaxMb 1024
openclaw config get channels.bncr.mediaMaxMb
```

优先级为 `accounts.<accountId>.mediaMaxMb` > `channels.bncr.mediaMaxMb` > `agents.defaults.mediaMaxMb` > 默认 `2048` MiB。该值同时约束入站媒体、入站文件分片和出站媒体；未显式配置时使用 2 GiB 默认值。传输层仍受分片大小、ACK 超时和网络条件限制。


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

- 私聊先过准入：未批准的私聊场景保持 `pending` 且完全静默，需要管理员执行 `/bncr allow <SceneId>` 放行。历史场景没有管理员显式批准标记时同样回落 `pending`。
- 已放行的私聊允许正常对话；`/whoami`、`/status`、`/new`、`/reset`、`/stop`、`/model`、`/verbose` 等受控命令按对应规则执行，不会以提升后的身份转交 Agent。
- 群聊受当前场景模式控制。未授权场景不会进入正常处理流程。
- `/bncr` 命令始终由 Bncr 识别；未知或不可用的 Bncr 命令会直接提示，不会转交 Agent。
- `/bncr help` 会根据当前会话类型和权限，仅展示当前可用的命令。
- 私聊非管理员使用 `history-*` 或 `download-media` 时，只能操作当前私聊会话，不能通过参数修改其他会话。
- 全局默认值 `/bncr download-media default on|off` 影响所有会话，仅管理员可设置；非管理员执行会被直接拒绝。

### 客户端桥接直通

`message` 工具的 `bridgeMethod` 是有意保留的原始透传面：方法名和参数不做白名单校验，直接转发给已连接的 Bncr 客户端，客户端返回的错误原样回给 Agent。调用始终落在本次工具调用解析出的 `accountId` 上，`extra.accountId` 不能改写到其他账号。该能力默认开启，可在 `channels.bncr.allowBridgeCall=false` 关闭。

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
