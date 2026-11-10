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

当前兼容 `OpenClaw >= 2026.10.10`。会话存储通过 `getSessionEntryAsync`、`listSessionEntriesAsync`、`prepareSessionEntryPatch`、`applySessionEntryPatch`、`readSessionUpdatedAtAsync` 访问，不使用已弃用的同步接口。

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
  默认值。无 agent 归属的遗留行只保留兼容读取，管理员的准入或绑定操作可以
  认领；已获批私聊会在正常准入时先完成归属迁移，非管理员的会话设置不会把
  仍无归属的行当成自己的行。
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
openclaw devices list
openclaw devices approve <device-id>
```

先核对 pending 设备的名称、地址和请求时间，再批准对应 ID。只有确认当前仅有一个可信请求时，才可用
`openclaw devices approve --latest` 作为快捷方式。设备批准后，客户端会保存授权信息并自动重连。

## 基础配置

配置位于 `channels.bncr`。最小配置：

宿主侧还有两处是插件管不到的，缺了装上也接不到消息：`plugins.allow` 里要有 `bncr`，`bindings`
至少要有一条把 `channel: "bncr"` 路由到某个 agent。`openclaw bncr miniconfig` 只补
`channels.bncr` 的 `enabled` / `allowTool`，这两处得单独确认。要一份完整推荐配置（含
`bindings`、`plugins.allow`、`public` 兜底 agent），在 BNCR 侧发 `config` 看，发 `autoconfig`
交给 agent 按现有配置最小化补齐。

一条 `bindings` 都没有时，插件按宿主默认 agent `main` 运行，并在首条消息处理时 warn 一条，
重启前一直沿用这个结果。

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

入站、出站媒体和单个文件的总大小由 OpenClaw 配置层决定；分片协议另有固定安全上限：

```bash
openclaw config set channels.bncr.mediaMaxMb 2048
openclaw config set channels.bncr.accounts.<accountId>.mediaMaxMb 1024
openclaw config get channels.bncr.mediaMaxMb
```

优先级为 `accounts.<accountId>.mediaMaxMb` > `channels.bncr.mediaMaxMb` > `agents.defaults.mediaMaxMb` > 默认 `2048` MiB，未显式配置时使用 2 GiB。该值决定单个文件可声明的总大小；服务端不信任客户端声明，会按实际序号、偏移、分片长度和累计字节逐片校验。为隔离共享 Gateway，单个分片最多 1 MiB，每账户最多 4 个、整个桥最多 8 个活动入站传输，同账户活动传输的声明总大小不得超过该账户的 `mediaMaxMb`。传输超时仍受 ACK 和网络条件限制。

### 入站媒体和历史媒体

- 当前轮的远端 URL 会尝试下载一次，下载成功后以本地文件进入当前轮的 `ctx.media`，同时保留原始 URL。
- 当前轮本地媒体先校验来源位于路由 Agent 的真实工作区或 OpenClaw 管理媒体目录，再按路由 Agent 保存到管理媒体目录，把托管路径交给 `ctx.media`。
- 历史消息中的远端 URL 在入站时不下载，只在 `conversation_context` 中保存 `mediaRef`、`source`、`sourceKind` 和状态，不会进入当前轮顶层媒体。
- 历史消息中的本地文件同样延迟读取；`conversation_context` 保留来源路径，等 Agent 明确调用媒体工具时再校验并复制。
- Agent 读取历史媒体时，把上下文中的 `source`、`sourceKind`、`mediaRef`、`contentType` 和 `fileName` 原样传给 `bncr_download_media`。工具只下载或复制该来源到当前 Agent 工作区，不按 `mediaRef` 反查会话。
- `sourceKind=url` 支持公网和内网地址；`sourceKind=local` 只接受 OpenClaw 管理媒体目录或调用 Agent 的真实工作区，越界路径和越界软链按 `SOURCE_NOT_FOUND` 拒绝。
- 工具失败时返回稳定错误码：`SOURCE_REQUIRED`、`SOURCE_KIND_INVALID`、`SOURCE_NOT_FOUND`、`SOURCE_TOO_LARGE` 或 `SOURCE_FETCH_FAILED`。
- `sandbox.mode` 为 `all` 时，宿主会按 Agent 的沙箱工具白名单过滤插件工具；需把 `bncr_download_media` 加入对应 Agent，例如：

  ```bash
  openclaw config set 'agents.entries.public.tools.sandbox.tools.alsoAllow' \
    '["group:messaging","bncr_download_media"]' --strict-json
  ```

  已存在其他项时必须保留原数组，只追加缺少的工具。该白名单由宿主执行，插件无法绕过。
- base64 历史媒体会按来源 Agent 保存副本；本地历史媒体在首次工具读取时复制。来源被清理后不承诺凭 `mediaRef` 恢复。
- 历史媒体始终是历史附件，不能提升为当前轮顶层媒体。

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

管理员省略 `<agentId>` 时改动该场景所有 agent 的行；私聊非管理员省略时只作用于自己的 agent 行。
新建场景行会继承同场景已有的模式、名字和分组，不会退回默认值。

`<agentId>` 可以是任意 agent 名字（数字也算），但必须真在这个场景里有一行；点不到时所有命令统一回
`Agent <id> has no scene row for <SceneId>. Agents here: ...`，后半句列出这个场景实际有哪些 agent。

`/bncr bind` 会先核对宿主配置里的 agent 清单（`agents.entries`）。绑定宿主没声明的 agent 直接
拒绝，并给出 `openclaw agents add <id>` 的补救命令，不会写出一行的 `agentId` 指向不存在的 agent。
配置里根本没有 `agents` 段时读不到清单，这时不拦，维持原有行为。

未绑定场景的落点默认是 `public`。宿主没配置 `public` 时不会把消息塞给一个不存在的 agent，
而是留在当前正在服务的 agent 上；启动日志会 warn 一条，`/bncr status` 也会在末尾带一行 `Warn`。
补法在 BNCR 侧：管理员发 `oc config` 看推荐配置（里面含 `public` 的沙箱最小骨架，可直接投喂
`openclaw config patch`），或发 `oc autoconfig` 由 agent 按推荐配置做最小化补齐。

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

会话展示名由插件在真实入站时写入，格式为 `平台 · 名称 · id`；用 `name set` 设置自定义名后变成 `平台 · 自定义名`，
不再带 id。本次入站没有携带名称时沿用该场景上次保存的名称；从未取得过名称才省略中间段，显示 `平台 · id`。名称会去掉换行和控制字符，
`·` 转成 `-`，超过 32 字截断。分隔符用半角空格隔开。网页端改名或拖动分组只保留到下一条消息。

私聊默认归入「私聊」分组；`group clear` 对私聊仍然回到「私聊」。群聊不设置时沿用宿主的 Groups 分区。
分组在侧边栏的先后顺序由宿主维护，插件只写会话归属，不碰分组目录，也不新建、改名或删除任何分组。
名字和分组按场景保存：管理员省略 `<agentId>` 时把该场景所有 agent 的行写成同一份，私聊非管理员
省略时只写自己的 agent 行；写 `<agentId>` 时只改那一行。`mode`、准入状态和历史设置存在各自
agent 的行里，管理员省略 `<agentId>` 只是让一条命令把这些行一次写齐。

展示名只影响显示，投递目标 `delivery.context.to` 不随名字变化。

`[<agentId>] [<SceneId>]` 是所有场景设置的统一尾缀：两个都省略作用于当前会话，只写 `<SceneId>` 时管理员作用于
该场景的全部 agent、私聊非管理员只作用于自己的行，只写 `<agentId>` 作用于当前会话里的那个 agent，两个都写则
精确定位。`mode`、`name`、`group`、`history-limit`、`history-force`、`download-media` 都是这一套。

### 会话历史

```text
/bncr history-help
/bncr history-limit [<number>|clear] [<agentId>] [<SceneId>]
/bncr history-force [on|off|clear] [<agentId>] [<SceneId>]
```

会话历史统一累计用户消息和 Bot 回复，默认窗口为 50 条。达到上限后会在后续消息到达时整理并发送历史上下文；
这条内部载体不更新会话展示名、分组或 last-route。

### 远程媒体

```text
/bncr download-media on|off|clear|default on|off [<agentId>] [<SceneId>]
```

`on` / `off` 只决定发送远端 URL 媒体时的默认行为，不是总控开关：每条消息都可以用 `downloadMedia` 自行选择下载或直接透传 URL。默认不下载是为了减少不必要的下载和缓存占用，属于推荐值；需要时单条消息可以覆盖。`clear` 清除本会话设置并回落到全局值。

媒体目的地（预期行为）：入站和出站都不区分公网与内网，均可下载和探测；只校验 URL 形状（http/https、无内嵌凭据、有 host），不做 SSRF 或目的地限制。需要内网隔离请在网络出口或宿主侧处理。

### 场景清理

```text
/bncr stale
/bncr stale [all|swapped|solo|missing|archived]
/bncr stale help
/bncr stale orphans
/bncr prune <SceneId> [<agentId>] [force]
/bncr prune state <SceneId> [force]
```

批量清理：

```text
/bncr stale <days>
/bncr prune stale [<days>] [force]
```

不带参数的 `stale` 是清理视图：180 天时钟，只看静默。会话异常本身不会把一行拉进这个视图；时钟也已经静默的行照常列出，不管它的会话是 missing 还是 archived。带过滤词（含 `all`）是诊断视图：72 小时时钟，并把 `missing` / `archived` 的会话异常一并列出。`stale <days>` 是清理视图换窗口，只改这一次的判定窗口，候选规则不变。`prune stale` 批量清理场景行，默认 180 天，单次最多 50 行，最久远的先删；每一行走与单条 `prune` 完全相同的步骤（归档 transcript、清桥接侧状态、删行），会话读不出来的行默认跳过，加 `force` 才删。

批量还要清 BNCR 侧 openclawclient 的 `state:<hex>`（模式 / occ）。这份状态是**场景级**的，键只有 `平台:群:用户`，没有 agent 维度；所以清理前先做一次场景归一：只有这条场景已经没有任何 agent 行才下发 RPC `bncr.state.clear`，同场景还有别的 agent 行在用就整条留着，只删过期的场景行，回复里标 `Client state kept for N scene(s) with another agent row still in use`。单条 `prune` 走同一套判定：客户端只透传命令，删完行由宿主判断这条场景是否已经空了再决定清不清，客户端本地不再自己删状态。客户端版本旧、没有这个方法时，回复里会标 `too old to expose bncr.state.clear`，场景行照常删除，不回滚。

`stale orphans` 是反向核对：经 RPC `bncr.state.list` 只读读一遍客户端的 `state:<hex>` 表（不建行、不改 rev、不归一脏值），按 `平台:群` / `平台:用户` 还原成场景键，列出「客户端有门控状态、场景表里没有对应行」的场景。多出来的只有两种来历：超级门控（oc/occ）已经打开但消息还没进场景表；或者场景行已经清掉、客户端那份留在原地。每行标 `gate on|off`、开启时间（`rev`）和 `mode`，只做展示，删不删由管理员判断；这些场景没有场景行，`/bncr prune` 也就没有目标行，要用 `/bncr prune state <SceneId>` 只清客户端那份门控：不归档 transcript、不动会话、不碰场景表；门控在 72 小时内开过要加 `force`（那也可能是还没来消息的超级门控），下发 RPC 前会再查一次场景表，期间冒出场景行就放弃并提示重跑；场景表还有行时这条路直接拒绝，提示改用 `/bncr prune <SceneId>`。客户端太旧时提示 `too old to expose bncr.state.list`。

`stale` 只读，列出两种清理候选。一是静默：场景行的最后活动时间超过判定窗口（入站，或管理员改配置时刷新该行），并且该行对应 sessionKey 的宿主会话最近真实聊天活动也超过同一窗口（清理视图 180 天，诊断视图 72 小时）。活动优先取 `lastInteractionAt`；旧会话库没有这个字段时才退回 `updatedAt`，并在列表标 `(store-write fallback)`。只满足一条的不列——例如 cron 直接投递的会话，场景行很久没更新，但会话还在动。二是会话异常：用宿主 SDK 只读列出该 agent 的会话项（`listSessionEntriesAsync`，不建库、不迁移），再按 sessionKey 查；查不到就是 `missing`（被 UI 删除或从未建过），`archivedAt` 有值就是 `archived`（被 UI 归档）；这两种不看场景行时钟，直接列出。列表读不出来时回退到时间戳判定：只按上面那条 72 小时双静默规则列，状态标 `unreadable (unknown)`，不会判 `missing` / `archived`；列表和时间戳都读不出来才整行跳过，不当成死行。

每条给出侧边栏 label、agent、两个时间和各自静默时长，会话异常时改为标 `missing (no session row)` 或 `archived`。第三个维度是兄弟场景：同一个 `group_id`、不同平台的另一行在 24 小时内有活动（取行入站与会话 `lastInteractionAt` 里较新的那个；只有确认仍然存活的会话才算活动，missing / archived / 读不出来的兄弟只按行入站算）。改标签、归档等只写库的时间不会被算成聊天活动。`swapped` 只列这一类，`solo` 只列既没有兄弟活动、也没有会话异常的行（就是单纯静默），`missing` / `archived` 只列对应异常，`all` 是全部候选（诊断视图）。私聊不参与兄弟匹配。

`prune` 必须显式写 `<SceneId>`，不提供当前会话快捷方式；`<SceneId>` 和 `<agentId>` 顺序不限，末位的 `force` 是保留字（agent 名字真叫 force 时写两遍）。执行顺序：归档宿主 transcript → 清掉桥接侧会话状态（路由、历史分片、发件队列）→ 删除场景行。目标 72 小时内还有活动会拒绝，确认要删再加 `force`；会话状态读不出来（unknown）同样拒绝，因为读不到不等于没在动；会话说 `missing` / `archived` 的行本身已是清理候选，不需要 `force`。宿主删除会带上读取时的 `sessionId` 与 `updatedAt` 作为条件；期间来了消息、重建了会话或发生写库时，条件删除失败并保留场景行。桥接侧状态也会在 SQLite 写事务内再次核对场景行，清理期间有新消息刷新该行就保留该行的整批桥接数据；未知会话连 `updatedAt` 条件也拿不到时，只有显式 `force` 才允许继续。内部配置行（`__global__` 全局媒体默认值）不会被列出，也不能删除。

一次最多列 50 行，超出的部分会提示还剩多少行，可用上面的过滤收窄。场景表还是空的（这台桥上没进来过任何消息）时直接回一句 `No scene rows yet`，不输出空列表。

删除会带走该场景的模式、名字和分组设置，群再进来会新建默认行；如果定时任务仍按旧 sessionKey 投递，宿主会重新建一个空会话。

列表带各场景的名称和 id（含私聊），和 `/bncr list scenes` 一样，管理员在群里执行会展示给群成员；这类操作建议私聊里跑。

### 会话清理

```text
/bncr sessions [<days>]
/bncr sessions prune [<days>]
/bncr sessions help
```

只清理宿主会话条目，不动场景行。默认 30 天，列出或删除超过 N 天没有活动的 bncr 会话（取 `lastInteractionAt`，没有则退回 `updatedAt`，并在行尾标 `(store write, no message)` 说明这个时间只是写库、不是消息），按天从久到近排列，单次最多 50 条。

一条会话对应一个 agent。同一个群换了绑定的 agent 后，旧 agent 的会话会留下来，所以列表按 (agent, 会话) 统计而不是按群统计；同一场景下别的 agent 还在用时，这一行会带 `other=<agent> <天数> (active chat)`，表示群本身是活的，只是这条会话已经没用了。

数据源是宿主 session store，所以场景行已经不在的孤儿会话也列得出（标 `scene=missing (orphan)`），这些是 `/bncr stale` 看不到的。场景行还在的标 `scene=kept`：删掉会话后准入、模式、名字、分组都保留，下条消息自动重建会话。标签优先取场景名，孤儿会话用 sessionKey 的 hex 反解成 `平台:id`，都读不出来时标 `(no label)`。

删除只删会话条目并归档 transcript，其他渠道的会话一律不碰。删前会再读一次，并把最新 `sessionId` 与 `updatedAt` 交给宿主做条件删除；期间来了消息或发生写库时删除失败并跳过。插件侧的会话历史窗口不受影响：下条消息仍会带上最近 50 条历史；要连历史、路由和模式一起清，用 `/bncr prune`。30 天这个默认值安全的前提是宿主 72 小时不活动就会重置会话：真正还在用的对话早重建过，能命中的都是没人再打开的老条目。列表带完整场景 id，管理员在群里执行会展示给群成员，这类清理建议私聊里跑。

## 权限规则

管理员可以使用全部 Bncr 命令。管理员发送的裸命令优先交给 OpenClaw 原生命令处理，未处理时才允许交给 Agent；`/bncr` 命令由 Bncr 处理。

非管理员的权限按会话类型区分：

- 私聊先过准入：未批准的私聊场景保持 `pending` 且完全静默，需要管理员执行 `/bncr allow <SceneId>` 放行。历史场景没有管理员显式批准标记时同样回落 `pending`。
- 已放行的私聊允许正常对话；`/whoami`、`/status`、`/new`、`/reset`、`/stop`、`/model`、`/verbose` 等受控命令按对应规则执行，不会以提升后的身份转交 Agent。
- 群聊受当前场景模式控制。未授权场景不会进入正常处理流程。
- `/bncr` 命令始终由 Bncr 识别；未知或不可用的 Bncr 命令会直接提示，不会转交 Agent。
- `/bncr help` 会根据当前会话类型和权限，仅展示当前可用的命令。
- 私聊非管理员使用 `history-*` 或 `download-media` 时，只能操作当前私聊会话和自己的 agent 行；省略 `agentId` 也不会 fan-out 到同场景的其他 agent，不能通过参数修改其他会话。
- 无 agent 归属的遗留行不会因非管理员命令自动变成当前 agent 的行；私聊准入会先完成归属迁移，遗留行认领仍由管理员执行。
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
openclaw devices list
openclaw devices approve <device-id>
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
