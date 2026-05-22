# bncr

OpenClaw 的 Bncr 频道插件（`channelId=bncr`）。

作用很简单：把 **Bncr / 无界客户端** 接到 **OpenClaw 网关**，用于消息双向通信与媒体/文件传输。

> 当前定位说明：bncr **不是 agent**。它保留既有 **WS 接入链路** 作为 transport / 通信承载，
> 在 OpenClaw 内部则按 **正式频道插件（channel plugin）** 建模。

---

## 1. 这是什么

- 一个 OpenClaw 的正式频道插件
- 负责把 Bncr / 无界客户端接入 OpenClaw
- 负责消息、媒体、文件与基础状态链路

---

## 2. 安装方式

### OpenClaw 侧

```bash
openclaw plugins install @xmoxmo/bncr
openclaw plugins enable bncr
openclaw gateway restart
```

### 升级插件

```bash
openclaw plugins update bncr
openclaw gateway restart
```

> 兼容范围：`openclaw >= 2026.5.3-1`
>
> 如果你是从精确版本升级，或本地安装记录仍钉在旧版本，也可以显式执行：
>
> ```bash
> openclaw plugins install @xmoxmo/bncr@0.1.1
> openclaw gateway restart
> ```

### Bncr / 无界侧

安装：

- `openclawclient.js`

然后完成客户端配置并连上 OpenClaw 网关即可。

---

## 3. 客户端接入流程（最简）

1. 在客户端插件配置中，将 **OpenClaw Token** 填写为 **gateway token**，并正确填写 host / port / ssl 后启用插件。
2. 启动（或重启）bncr 客户端后，在 OpenClaw 侧执行：

```bash
openclaw devices approve --latest
```

完成后，客户端会使用自己的身份并自动保存后续授权。

---

## 4. 当前能力

- 文本
- 图片
- 视频
- 语音
- 音频
- 文件
- 下行推送
- ACK
- 离线消息排队
- 重连后继续发送
- 状态诊断
- 文件互传

---

## 5. 架构定位

bncr 当前采用两层模型：

1. **WS 承载层**
   - Bncr 客户端通过 WebSocket 接入 OpenClaw 网关
   - 负责连接、推送、ACK、文件分块等 transport 能力

2. **OpenClaw 频道插件层**
   - 在 OpenClaw 内部按正式 `channel plugin` 建模
   - 负责入站解析、消息分发、出站适配、状态与治理

当前代码结构：

```text
plugins/bncr/src/
  channel.ts
  core/
  messaging/
```

---

## 6. 配置项总览

当前主要配置字段：

- `enabled`
- `dmPolicy`
- `groupPolicy`
- `allowFrom`
- `groupAllowFrom`
- `outboundRequireAck`
- `requireMention`
- `accounts`

补充：

- `dmPolicy` / `groupPolicy` 支持：`open | allowlist | disabled`
- `outboundRequireAck` 是当前**单账号场景**使用的顶层字段：`channels.bncr.outboundRequireAck`
- `outboundRequireAck=true` 时，文本外发会等待 `bncr.ack` 再出队；关闭后不再强制等待文本 ACK，超时类错误会显示为 `push-delivery-unconfirmed`
- `requireMention` 当前仍是保留字段

---

## 7. 媒体发送（OpenClaw 2026.5.18 验证适用）

当前有两种常见媒体发送方式，它们都属于 OpenClaw 标准能力，但**不是同一条实现链路**。

### 方式 A：Agent 回复中的 `MEDIA:<path>`

适用场景：

- agent 在当前会话中直接回附件
- 由宿主 reply-media / outbound attachment 链统一处理

示例：

```text
MEDIA:/root/.openclaw/workspace/tmp/demo.png
```

说明：

- 这条链先经过 OpenClaw 宿主的 `reply-media-paths` / `loadWebMedia` 预处理
- 本地文件是否允许发送，取决于宿主侧的路径准入与 MIME / 类型白名单
- 在 `2026.5.18` 口径下，`MEDIA:` 是否成功，**不能直接等价**为 bncr 插件自身的 file-transfer 是否成功

### 方式 B：动作发送链（`message.action` / `send`）

适用场景：

- 需要显式指定目标会话 / 路由
- 需要验证 OpenClaw 动作发送接口到 bncr channel 的下行链路

示例：

```bash
openclaw gateway call message.action --params '{
  "channel": "bncr",
  "action": "send",
  "accountId": "Primary",
  "idempotencyKey": "bncr-media-demo-1",
  "params": {
    "to": "Bncr:tgBot:-1003776014601:6278285192",
    "caption": "图片发送测试",
    "path": "/root/.openclaw/workspace/tmp/demo.png"
  }
}'
```

说明：

- 这是 OpenClaw 标准动作发送接口，不是 bncr 私有命令
- 这条链与 `MEDIA:` 的宿主 reply-media 预处理链不同
- 联调时建议把两条链分开验证，避免把宿主准入问题误判成 bncr 文件传输问题

### 2026.5.18 验证说明

以下口径已在 OpenClaw `2026.5.18` 上完成验证，当前建议把媒体问题拆成两类看：

1. `MEDIA:<path>` 失败：优先检查宿主 reply-media / MIME 白名单 / 本地路径准入
2. `message.action` 失败：优先检查动作 envelope、目标 `to`、bncr 出站 push/ack 与 file-transfer 日志

后续如果在其他 OpenClaw 版本上完成验证，应继续在本节追加对应版本的验证过程与结论，不直接外推复用 `2026.5.18` 的验证口径。

---

## 8. 状态与诊断

常用检查：

```bash
openclaw gateway status
openclaw health --json
```

重点看：

- `linked`
- `pending`
- `deadLetter`
- diagnostics / probe / status 摘要
- diagnostics 里的 `runtimeFlags.outboundRequireAck`
- diagnostics 里的 `runtimeFlags.ackPolicySource`
- diagnostics 里的 `waiters.messageAck` / `waiters.fileAck`

---

## 9. 常见安装/加载问题

### 报错：`Cannot find module 'openclaw/plugin-sdk/core'`

这通常不是 bncr 没装上，而是：

- bncr 已经安装到 `~/.openclaw/extensions/bncr`
- 但插件目录当前解析不到宿主 `openclaw` 包
- 因而在加载 `openclaw/plugin-sdk/core` 时失败

bncr 0.1.1 会先尝试自动修复插件目录下的 `node_modules/openclaw` 解析链；如果仍失败，可手动执行：

```bash
mkdir -p ~/.openclaw/extensions/bncr/node_modules
ln -s "$(npm root -g)/openclaw" ~/.openclaw/extensions/bncr/node_modules/openclaw
openclaw gateway restart
openclaw plugins inspect bncr
```

如果 `npm root -g` 指向的不是实际宿主位置，请先检查：

```bash
which openclaw
npm root -g
```

然后把 `openclaw` 的真实安装目录软链接到 `~/.openclaw/extensions/bncr/node_modules/openclaw`。

## 10. 自检与测试

```bash
cd plugins/bncr
npm test
npm run selfcheck
npm pack
```

用途：

- `npm test`：跑回归测试
- `npm run selfcheck`：检查插件骨架是否完整
- `npm pack`：确认当前版本可正常打包
- `npm run check-register-drift -- --duration-sec 300 --interval-sec 15`：静置采样 `bncr.diagnostics`，观察 `registerCount / apiGeneration / postWarmupRegisterCount` 是否在 warmup 后继续增长

示例输出重点：

- `delta.registerCount`
- `delta.apiGeneration`
- `delta.postWarmupRegisterCount`
- `historicalWarmupExternalDrift`
- `newDriftDuringWindow`
- `last.postWarmupRegisterCount`
- `last.unexpectedRegisterAfterWarmup`
- `driftDetected`

---

## 11. 上线前检查

上线前建议至少确认：

- README 与当前实现一致
- **隐私清理**：测试/示例/日志中的 scope、ID、账号等做去标识化（必要时用占位值）
- 配置 schema 与实际字段一致
- 测试通过
- 自检通过
- 可以正常打包
- 本地版本号与 npm / 发布目标一致（版本号修改应优先在工作仓完成，再同步到发布仓）
- 运行态 `linked / pending / deadLetter` 正常

---

如果你接触过旧版本，请以当前 README 和当前代码为准。
