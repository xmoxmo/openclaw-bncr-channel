# BNCR 入站文件传输安全复核

## 范围

本次复核对应 ClawScan 对 `@xmoxmo/bncr@0.9.2` 报告的两项问题：

- MCP05 High CWE-400：分片文件传输可耗尽内存。
- MCP07 Medium CWE-862：省略 lease 可绕过 transfer 所有权检查。

复核目标是保持 `mediaMaxMb` 的单文件总大小语义，同时把共享 Gateway 的内存和生命周期风险收敛为固定上限。

## 设计口径

- 文件总大小仍由账户 `mediaMaxMb` 决定。插件内的分片大小、分片数、活动传输数、操作队列和超时是资源边界，不是第二套媒体大小配置。
- 分片写入 OpenClaw 媒体目录下的私有 `.bncr-inbound-staging`，文件权限 `0600`、目录权限 `0700`，文件名使用服务端 UUID。
- 内存只保存分片序号、摘要和状态，不保存分片 Buffer，也不构造整文件 Buffer。
- 内部键为 accountId + transferId；跨账户同 ID 独立。
- chunk、complete、abort 在暴露终态、完成路径或修改状态前，都必须通过 account + owner 授权。
- lease 只表达连接新鲜度。缺失、当前或 stale 都不能替代 owner 校验；旧 owner 在原连接上可继续既有传输，新连接不隐式接管。
- 成功、失败、abort、空闲、硬 TTL、插件停止和启动遗留清理都会释放暂存文件。终态立即释放分片序号和摘要集合。
- 有 pending operation 时不得回收 transfer。操作结束后由下一次事件触发空闲或硬 TTL 清理；启动时清理崩溃遗留的 `.part`。

## 定向回归

- MCP05：`Map<number, Buffer>` 与整文件 `Buffer.concat` 已移除；1 MiB 分片、32,768 分片上界、每账户 4 个和全局 8 个活动传输、有界 init/操作队列均有测试。
- MCP07：无 lease、伪造 lease、当前 lease 的跨 owner，以及跨 owner complete/abort 均被拒绝且不暴露路径；跨账户同 transferId 可独立存在。
- 竞态：过期后迟到请求不复活，同 ID 重建后的旧排队请求不能修改新对象；活动操作期间空闲和硬 TTL 均不回收。
- 正常链路：256 KiB 分片仍可经流式暂存和宿主 `saveMediaStream` 完成保存。

## 复核账本

- 第 1 轮：七项维度与七个覆盖面全过；全量 1444/1444，MCP05/MCP07 定向回归通过。
- 第 2 轮：init/chunk/complete/terminal 的幂等、终态、跨账户与 ABA 行为全过。
- 第 3 轮：宿主 `saveMediaStream` 契约、README、自检、打包清单与 dist 对齐。
- 第 4 轮：错误返回、日志内容、隐私扫描与凭据边界通过。
- 第 5 轮：`mediaMaxMb` 单一总量语义及全部固定资源上限一致。
- 第 6 轮：启动/停止/空闲清理、暂存残留与活动操作 TTL 协调通过。
- 第 7 轮：出站投递未回归，dist 可加载并导出默认入口。
- 第 8 轮：operation queue、对象身份、GC 与同 ID 重建竞态通过。
- 第 9 轮：20 秒 register drift 采样零增长；运行态 active、启动 routes=49、无 ERROR/FATAL。
- 第 10 轮：全量 1444/1444、构建、包清单 228 项、隐私扫描、暂存残留、指纹与 diff-check 全过。

专项复核中发现并修复了“硬 TTL 在活动操作未结束时就回收”的竞态。修复后先跑了两轮；随后为宿主流式适配器补上直接契约测试，范围指纹变化使计数归零，最终记录的 10 轮是从新范围基线连续跑出的零漏点结果。

## 公开导出兼容补正（0.9.3）

发布仓复检发现复核索引测试假定了内部 `memory/` 一定存在，而公开导出会排除这些内部元数据，导致公开仓 `fullcheck` 因 `memory/review-index.json` 缺失而失败。修复后，内部索引存在时继续完整校验状态文件、范围与唯一性；公开导出缺失索引时明确跳过该内部元数据测试，不改变业务代码、公开包内容或同步边界。

这次测试修正改变了两项复核范围指纹。两个目标都清零重新完成连续 10 轮零漏点复核：每轮全量 1444/1444、类型与 Biome、自检、包清单与格式门禁通过；构建与 dist 校验通过；隐私扫描干净；Gateway 每轮重启后均为 `routes=49`，`ERROR/FATAL=0`。

本记录停在本地修复与复核完成，不包含 tag、push 或发布。
