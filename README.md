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

当前兼容 `OpenClaw >= 2026.10.5`。会话存储通过 `getSessionEntryAsync`、`patchSessionEntry`、`readSessionUpdatedAtAsync` 访问，不使用已弃用的同步接口。

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
/bncr allow [<agentId>] [<SceneId>]
/bncr deny [<agentId>] [<SceneId>]
/bncr bind <agentId> [<SceneId>]
/bncr revoke [<agentId>] [<SceneId>]
/bncr list pending [filters...]
/bncr list scenes [filters...]
/bncr mode help
/bncr mode [<agentId>] [<SceneId>]
/bncr mode <admin|mention|hybrid|all|clear> [<agentId>] [<SceneId>]
```

省略 `<agentId>` 时改动该场景所有 agent 的行；同群多 agent 因此始终统一。新建场景行会继承同场景已有的
模式、名字和分组，不会退回默认值。

`<agentId>` 可以是任意 agent 名字（数字也算），但必须真在这个场景里有一行；点不到时所有命令统一回
`Agent <id> has no scene row for <SceneId>. Agents here: ...`，后半句列出这个场景实际有哪些 agent。

`/bncr list` 显示的是准入实际生效的状态——私聊行如果是历史遗留的
`allowed` 但没有批准记录，会写成 `status=pending (stored allowed)`，因为它下一条消息就会被判成待批准。

### 会话名与分组

```text
/bncr name [<agentId>] [<SceneId>]
/bncr name set <text> [<agentId>] [<SceneId>]
/bncr name clear [<agentId>] [<SceneId>]
/bncr group [<agentId>] [<SceneId>]
/bncr group set <name> [<agentId>] [<SceneId>]
/bncr group clear [<agentId>] [<SceneId>]
/bncr name help
/bncr group help
```

会话展示名由插件在每次入站时写入，格式为 `平台 · 名称 · id`；用 `name set` 设置自定义名后变成 `平台 · 自定义名`，
不再带 id。群名或用户名为空（含只有空白）时省略中间段，直接显示 `平台 · id`；名称会去掉换行和控制字符，
`·` 转成 `-`，超过 32 字截断。分隔符用半角空格隔开。网页端改名或拖动分组只保留到下一条消息。

私聊默认归入「私聊」分组；`group clear` 对私聊仍然回到「私聊」。群聊不设置时沿用宿主的 Groups 分区。
分组在侧边栏的先后顺序由宿主维护，插件只写会话归属，不碰分组目录，也不新建、改名或删除任何分组。
名字和分组按场景保存：省略 `<agentId>` 时把该场景所有 agent 的行写成同一份，写 `<agentId>`
时只改那一行，和 `/bncr mode` 完全一致。`mode`、准入状态和历史设置存在各自 agent 的行里，
省略 `<agentId>` 只是让一条命令把这些行一次写齐。

展示名只影响显示，投递目标 `delivery.context.to` 不随名字变化。

`[<agentId>] [<SceneId>]` 是所有场景设置的统一尾缀：两个都省略作用于当前会话，只写 `<SceneId>` 作用于该场景的
全部 agent，只写 `<agentId>` 作用于当前会话里的那个 agent，两个都写则精确定位。`mode`、`name`、`group`、
`history-limit`、`history-force`、`download-media` 都是这一套。

### 会话历史

```text
/bncr history-help
/bncr history-limit [<number>|clear] [<agentId>] [<SceneId>]
/bncr history-force on|off|clear [<agentId>] [<SceneId>]
```

会话历史统一累计用户消息和 Bot 回复，默认窗口为 50 条。达到上限后会在后续消息到达时整理并发送历史上下文。

### 远程媒体

```text
/bncr download-media on|off|clear|default on|off [<agentId>] [<SceneId>]
```

`on` / `off` 只决定发送远端 URL 媒体时的默认行为，不是总控开关：每条消息都可以用 `downloadMedia` 自行选择下载或直接透传 URL。默认不下载是为了减少不必要的下载和缓存占用，属于推荐值；需要时单条消息可以覆盖。`clear` 清除本会话设置并回落到全局值。

媒体目的地（预期行为）：入站和出站都不区分公网与内网，均可下载和探测；只校验 URL 形状（http/https、无内嵌凭据、有 host），不做 SSRF 或目的地限制。需要内网隔离请在网络出口或宿主侧处理。

### 场景清理

```text
/bncr stale [all|swapped|solo|missing|archived]
/bncr stale help
/bncr prune <SceneId> [<agentId>] [force]
```

`stale` 只读，列出两种清理候选。一是静默：场景行的最后活动时间超过 72 小时（入站，或管理员改配置时刷新该行），并且该行对应 sessionKey 的宿主会话活动时间也超过 72 小时。只满足一条的不列——例如 cron 直接投递的会话，场景行很久没更新，但会话还在动。二是会话异常：用宿主 SDK 只读列出该 agent 的会话项（`listSessionEntries`，不建库、不迁移），再按 sessionKey 查；查不到就是 `missing`（被 UI 删除或从未建过），`archivedAt` 有值就是 `archived`（被 UI 归档）；这两种不看场景行时钟，直接列出。列表读不出来时回退到时间戳判定：只按上面那条 72 小时双静默规则列，状态标 `unreadable (unknown)`，不会判 `missing` / `archived`；列表和时间戳都读不出来才整行跳过，不当成死行。

每条给出侧边栏 label、agent、两个时间和各自静默时长，会话异常时改为标 `missing (no session row)` 或 `archived`。第三个维度是兄弟场景：同一个 `group_id`、不同平台的另一行在 24 小时内有活动（取行入站与会话活动里较新的那个；只有确认仍然存活的会话才算活动，missing / archived / 读不出来的兄弟只按行入站算，避免归档动作或读不到的时间冒充活动），说明这个群已经换到那个平台。`swapped` 只列这一类，`solo` 只列既没有兄弟活动、也没有会话异常的行（就是单纯静默），`missing` / `archived` 只列对应异常，默认 `all`。私聊不参与兄弟匹配。

`prune` 必须显式写 `<SceneId>`，不提供当前会话快捷方式；`<SceneId>` 和 `<agentId>` 顺序不限，末位的 `force` 是保留字（agent 名字真叫 force 时写两遍）。执行顺序：归档宿主 transcript → 清掉桥接侧会话状态（路由、历史分片、发件队列）→ 删除场景行。目标 72 小时内还有活动会拒绝，确认要删再加 `force`；会话状态读不出来（unknown）同样拒绝，因为读不到不等于没在动；会话说 `missing` / `archived` 的行本身已是清理候选，不需要 `force`。删除前会再核对一次行的 `lastSeenAt`，期间来了新消息就跳过并回报。内部配置行（`__global__` 全局媒体默认值）不会被列出，也不能删除。

一次最多列 50 行，超出的部分会提示还剩多少行，可用上面的过滤收窄。场景表还是空的（这台桥上没进来过任何消息）时直接回一句 `No scene rows yet`，不输出空列表。

删除会带走该场景的模式、名字和分组设置，群再进来会新建默认行；如果定时任务仍按旧 sessionKey 投递，宿主会重新建一个空会话。

列表带各场景的名称和 id（含私聊），和 `/bncr list scenes` 一样，管理员在群里执行会展示给群成员；这类操作建议私聊里跑。

## 权限规则

管理员可以使用全部 Bncr 命令。管理员发送的裸命令优先交给 OpenClaw 原生命令处理，未处理时才允许交给 Agent；`/bncr` 命令由 Bncr 处理。

非管理员的权限按会话类型区分：

- 私聊先过准入：未批准的私聊场景保持 `pending` 且完全静默，需要管理员执行 `/bncr allow <SceneId>` 放行。历史场景没有管理员显式批准标记时同样回落 `pending`。
- 已放行的私聊允许正常对话；`/whoami`、`/status`、`/new`、`/reset`、`/stop`、`/model`、`/verbose` 等受控命令按对应规则执行，不会以提升后的身份转交 Agent。
- 群聊受当前场景模式控制。未授权场景不会进入正常处理流程。
- `/bncr` 命令始终由 Bncr 识别；未知或不可用的 Bncr 命令会直接提示，不会转交 Agent。
- `/bncr help` 会根据当前会话类型和权限，仅展示当前可用的命令。
- 私聊非管理员使用 `history-*` 或 `download-media` 时，只能操作当前私聊会话，不能通过参数修改其他会话。
- `/bncr name`、`/bncr group` 在当前私聊由本人操作，在群聊需要管理员；带其他 `<SceneId>` 时仅管理员可用。
- 带 `<agentId>` 只允许管理员使用，或者指定自己所在的那个 agent；指向别的 agent 会被直接拒绝。
- 全局默认值 `/bncr download-media default on|off` 影响所有会话，仅管理员可设置；非管理员执行会被直接拒绝。

### 客户端桥接直通

`message` 工具的 `bridgeMethod` 是有意保留的原始透传面：方法名和参数不做白名单校验，直接转发给已连接的 Bncr 客户端，客户端返回的错误原样回给 Agent。调用始终落在本次工具调用解析出的 `accountId` 上，`extra.accountId` 不能改写到其他账号。该能力默认开启，可在 `channels.bncr.allowBridgeCall=false` 关闭。

指令作用域（预期行为）：`bridgeMethod` 不做方法级鉴权，也不提供会话级作用域；需要收敛时用 `allowBridgeCall=false` 整体关闭。

## 群聊模式

```text
/bncr mode admin
/bncr mode mention
/bncr mode hybrid
/bncr mode all
/bncr mode clear
/bncr mode all orion
/bncr mode all orion tnBot:123456
```

| 模式 | 说明 |
| --- | --- |
| `admin` | 仅管理员消息触发 |
| `mention` | 需要明确提及 Bot |
| `hybrid` | 按管理员或提及条件处理 |
| `all` | 处理群内符合接入条件的消息 |
| `clear` | 清除当前场景的自定义模式 |

`/bncr mode` 不带参数时列出该场景各 agent 的模式；不一致时逐行列出。

新群聊默认需要管理员授权。管理员可以使用 `/bncr allow`、`/bncr deny`、`/bncr bind` 和 `/bncr revoke` 管理场景。
`allow` / `deny` 和其它场景设置同一套尾缀：省略 `<agentId>` 时把该场景所有 agent 的行一起改，写 `<agentId>` 只改那一行；
同一群由两个 agent 负责时不会出现一个已放行、另一个静默被挡。

`revoke` 是这套规则里唯一的例外：放行可以一次给全场，删除只能一行一行来。场景只有一个 agent 时
`/bncr revoke` 直接生效；同群多 agent 时不写 `<agentId>` 只会得到一句提示，不会替你挑一个删掉。
删完若还有别的 agent 持有该场景，会明说 `Still admitted for ...`。

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
