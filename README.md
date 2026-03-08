# bncr

OpenClaw 的 Bncr 频道插件（`channelId=bncr`）。

作用很简单：把 **Bncr / 无界客户端** 接到 **OpenClaw 网关**，用于消息双向通信与媒体/文件传输。

> 当前定位说明：bncr **不是 agent**。它保留既有 **WS 接入链路** 作为 transport / 通信承载，
> 在 OpenClaw 内部则按 **正式频道插件（channel plugin）** 建模。

---

## 安装

### OpenClaw 侧

在 OpenClaw 上执行：

```bash
openclaw plugins install @xmoxmo/bncr
openclaw plugins enable bncr
openclaw gateway restart
```

### Bncr / 无界侧

安装：

- `openclawclient.js`

然后完成客户端配置，至少包括：

- OpenClaw 地址
- 端口
- Token
- 连接相关参数

配置完成后，让客户端成功连到 OpenClaw 网关即可。

---

## 支持能力

### 支持内容

- 文本
- 图片
- 视频
- 语音
- 音频
- 文件

### 其它特性

- 下行推送
- 离线消息自动排队
- 重连后继续发送
- 支持诊断信息
- 支持文件互传

---

## 当前架构说明

### 设计原则

bncr 当前采用两层模型：

1. **WS 承载层（保留现状）**
   - Bncr 客户端通过 WebSocket 接入 OpenClaw 网关
   - 这一层负责连接、消息传输、推送、ACK、文件分块等 transport 能力
   - 本插件**不重做这层通信**

2. **OpenClaw 频道插件层（当前主线）**
   - 在 OpenClaw 内部，bncr 作为正式 `channel plugin` 存在
   - 负责渠道身份、入站解析、准入治理、消息分发、出站适配、状态与权限解释

### 不再采用的错误理解

以下理解现在都不准确：

- “bncr 是一个 agent”
- “bncr 只是临时桥接脚本”
- “为了正式化，需要再新开一条通信层”

正确理解是：

> **bncr 保留现有 WS 通信承载，但在 OpenClaw 内部已经按正式频道插件分层。**

---

## 当前代码结构

```text
plugins/bncr/src/
  channel.ts
  core/
    types.ts
    accounts.ts
    targets.ts
    status.ts
    probe.ts
    config-schema.ts
    policy.ts
    permissions.ts
  messaging/
    inbound/
      parse.ts
      gate.ts
      dispatch.ts
    outbound/
      send.ts
      media.ts
      actions.ts
```

### 各层职责

#### `channel.ts`
运行时宿主（runtime host）与 transport orchestration：
- 持有连接状态
- 处理 gateway methods
- 维护 outbox / deadLetter / retry / push
- 保留文件互传主链

#### `core/*`
插件的核心语义与治理层：
- `types.ts`：基础类型
- `accounts.ts`：账号模型
- `targets.ts`：target / sessionKey / route 协议
- `status.ts`：状态摘要拼装
- `probe.ts`：探测 / 健康判断
- `config-schema.ts`：正式配置字段
- `policy.ts`：渠道治理默认口径
- `permissions.ts`：elevated / approvals 解释层

#### `messaging/inbound/*`
入站消息主链：
- `parse.ts`：原始入站解析
- `gate.ts`：准入控制（如 dm/group policy、allowlist）
- `dispatch.ts`：进入 OpenClaw reply pipeline

#### `messaging/outbound/*`
出站消息主链：
- `send.ts`：文本/媒体发送入口
- `media.ts`：媒体消息语义与 frame 组装
- `actions.ts`：reply / delete / react / edit 等动作挂点

---

## 当前配置字段

bncr 已正式收口的主要配置字段：

- `enabled`
- `dmPolicy`
- `groupPolicy`
- `allowFrom`
- `groupAllowFrom`
- `requireMention`（保留字段，待实现）
- `accounts`

其中：

- `dmPolicy` / `groupPolicy` 支持：`open | allowlist | disabled`
- `allowFrom` / `groupAllowFrom` 用于渠道侧准入
- `requireMention` 当前仅保留配置位，尚未接通稳定的 mention 解析与拦截链路，暂按待实现处理
- `accounts` 用于账号启停与显示名等配置

---

## 权限说明

bncr 当前已经有正式的权限解释层，但要区分两件事：

1. **是否允许 bncr 请求 elevated**
   - 取决于 `tools.elevated.allowFrom.bncr`

2. **请求后是否直接执行**
   - 仍可能受 OpenClaw approvals 策略约束

也就是说：

> `allowFrom.bncr` 表示 bncr 可以申请 elevated，
> **不等于** bncr 可以绕过 approvals 直接执行。

---

## 自检

当前提供轻量自检：

```bash
cd plugins/bncr
npm run selfcheck
```

用途：
- 检查正式插件骨架是否完整
- 检查核心分层文件是否存在
- 作为继续重构前的轻量护栏

如果输出：

```json
{
  "ok": true
}
```

说明当前插件结构至少在文件层面完整。

---

## 安装后如何确认成功

可以通过以下方式检查：

```bash
openclaw gateway status
openclaw health --json
```

重点看：

- 网关是否正常运行
- bncr 是否已经 `linked`
- 是否存在异常 pending / deadLetter
- diagnostics / probe / permissions 是否输出正常

如果 bncr 已成功连上，一般就说明插件安装和基础链路已经正常。

---

## 说明

如果你接触过旧版本，请以当前 README 和当前代码为准。

当前 README 描述的是：
- **保留 WS 承载**
- **内部已按正式频道插件分层**

而不是旧的“单文件桥接实现”理解。
