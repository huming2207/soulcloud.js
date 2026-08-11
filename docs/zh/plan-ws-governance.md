# SoulcloudJS WS 扩展性设计（DESIGN WS-SCALING）
> 中文原版设计文档，与 docs/en/plan-ws-governance.md 内容一致。

**日期**: 2026-08-12 · **状态**: 设计（未实施）· **依据**: GPT/Codex 审查报告 REVIEW_RESULT.gpt.md 的 WEB-05/WEB-07 及命令截止时间建议（本轮实现已排除的项）
**仓库**: soulcloudjs（本设计只读仓库，不改代码）

## 0. 背景与现状事实

审查发现（已核实）：
- 5 个独立 WS hub（log/command/ota/status/notifications）各自持有独立连接计数，默认各 500（`app.ts:154-158` 传同一 `streamOptions.maxConnections`，但每个 hub 内部独立 `connectionCount`）→ 进程实际上限约 2500 而非 500
- 每个 socket 持有两个 interval：M2 token 过期检查（`expiryByWs`/`expiryTimers`）+ 成员复查（`scheduleMembershipCheck`，`ws-access.ts:32-75`，每项目一次串行 `findUnique`，无防重入）
- 命令/OTA 推送每次去抖更新都全量重读并序列化整个 batch/job（`command-stream.ts:187-221`、`ota-stream.ts:202-283`）——1000 目标 job = 每次推送 O(N) DB + JSON + 网络
- OTA poller 仍为单行租约（`ota-publish.ts:62-112` `otaPollOnce` 一次 lease 一个 target）；**命令侧已由本轮实现改为有界 drain**（`publish.ts` `DEFAULT_DRAIN_MAX_PER_CYCLE=100`）
- 命令默认无截止时间（`enqueue.ts:39-46` NULL = 永不超时）；`CommandPanel.tsx:100,119-139` 默认 blank

---

## 课题 A：全局 WS 连接预算

### 现状
每个 hub 独立 `connectionCount`，上限各自独立（默认 500）。`SOULCLOUD_WS_MAX_CONNECTIONS` 环境变量被 5 个 hub 各自读取，进程级实际上限 = 5 × 值。一个用户可在 5 个流各开 500 连接。

### 方案选项

**A1. 共享计数模块（推荐）**
新文件 `packages/api/src/api/ws-budget.ts`：

```ts
// ws-budget.ts —— 进程级原子预算（Bun 单线程，无锁）
export interface WsBudget {
  /** 尝试占用一个配额；超限返回 false（调用方 close 4401）。 */
  tryAcquire(): boolean;
  /** 释放配额（幂等）。 */
  release(): void;
  /** 当前占用数（度量用）。 */
  readonly current: number;
}

export function createWsBudget(limit: number): WsBudget {
  let current = 0;
  return {
    tryAcquire() {
      if (current >= limit) return false;
      current += 1;
      return true;
    },
    release() {
      current = Math.max(0, current - 1);
    },
    get current() {
      return current;
    },
  };
}
```

- `app.ts` 创建**一个** `createWsBudget(SOULCLOUD_WS_MAX_CONNECTIONS ?? 2000)`，通过各 hub 工厂 options 传入（新增 `budget?: WsBudget` 字段）
- 每个 hub 的 `subscribe` 里：`if (!budget.tryAcquire()) { ws.close(4401, "too many connections"); return; }`，`unsubscribe` 里 `budget.release()`；**hub 自身 `connectionCount` 删除**（或保留仅作 per-hub 度量）
- 兼容：`maxConnections` 选项保留但语义变为"该 hub 的**附加**上限"（先查全局预算再查 hub 上限）；不传则只受全局约束
- 测试：注入小预算（如 3），4 个连接跨 hub 分配 → 第 4 个被拒 4401；释放后可再连

**A2. 简单共享计数器（最小侵入）**
不引入模块，把 5 个 hub 的计数移到 app.ts 一个闭包变量传下去。缺点：无封装、hub 单例化（`getXxxStreamHub` 进程级单例）后测试间状态难重置。不如 A1。

**A3. 每用户/IP 限额（P2）**
在预算之上加 keyed map（userId/IP → 计数，TTL 清理）。本期不做——需要先有全局预算基础。

### 推荐：A1
- 工作量：S（新模块 ~40 行 + 5 个 hub 各改 3 行 + 测试 ~30 行）
- 风险：低。唯一注意点：hub 是进程级单例，预算必须在 app.ts 创建一次并注入，**不能在 hub 工厂内默认创建**（否则测试间不隔离）；测试用显式注入
- 度量：`budget.current` 暴露为 `/v1/health` 或日志字段

---

## 课题 B：集中过期定时器

### 现状
每个 socket 两个 interval：
1. M2 token 过期（`command-stream.ts:284-300` 等，各流重复实现）：`setInterval` 每 `expCheckIntervalMs`（默认 30s）查 `expiryByWs` 的 deadline
2. membership（`ws-access.ts`）：`scheduleMembershipCheck` 每 intervalMs 逐项目查库

1000 连接 × 2 = 2000 个 interval。Node/Bun 对数千 interval 无压力（定时器是二叉堆），但每个 interval 的**每次触发**都要做一次回调 + Map 查询；且每个流各有一份 expiry 实现（复制粘贴 4 份）。

### 方案选项

**B1. 集中调度器（推荐）**
新文件 `packages/api/src/api/ws-scheduler.ts`：

```ts
// ws-scheduler.ts —— 进程级单调度器：一个 interval 扫描所有到期项
export interface SchedulerHandle {
  /** 注册一个到期动作；返回取消函数。 */
  schedule(deadline: number, action: () => void): () => void;
}

export function createScheduler(tickMs = 5_000): {
  schedule: SchedulerHandle["schedule"];
  /** 当前注册数（度量用）。 */
  size: number;
  /** 关闭调度器（进程退出/测试）。 */
  close: () => void;
}
```

实现：内部 `Map<deadline, Set<action>>` 或最小堆；单 `setInterval(tickMs)` 扫描到期项执行并删除；`schedule` 幂等（同一 action 重新 schedule 先取消旧项）。定时器总量从 2N 降到 1。

- M2 过期：`expiryByWs` 改为每个 socket `schedule(expMs, () => ws.close(4401, "token expired"))`（close 后由 close handler 清理注册）
- membership：`scheduleMembershipCheck` 内部改为注册"到期=now+intervalMs 后执行一次检查，若 socket 仍 OPEN 则再次 schedule"（链式自续，天然防重叠——上一次执行完才排下一次）
- 各流的 expiry 复制粘贴代码收敛进调度器

**B2. 保持现状 + 文档**
2000 个 interval 在 Bun 下不会崩（二叉堆 O(log n)），但每 socket 每 30s 两个回调 + 每回调一次 Map 访问，1000 连接 = 每秒 ~66 次回调，量级可忽略。真正的成本是**代码重复**（4 份 expiry 实现）和**无法统一度量**。

### 推荐：B1（主要动机是收敛重复 + 防重入，不是 CPU）
- 工作量：M（调度器 ~80 行 + ws-access 改造 + 各流 expiry 替换 + 测试）
- 风险：中低。注意点：调度器单例生命周期（进程退出 close）；`scheduleMembershipCheck` 的链式自续要保证 socket close 后不再排（现有 `readyState !== 1` 守卫保留）
- 测试策略：注入短 tick（如 10ms）+ setSystemTime 推进，验证到期触发/取消/防重入

---

## 课题 C：membership 检查合并

### 现状
`ws-access.ts:58-75`：每个 interval 对 `projectIds` **逐项目串行** `findUnique`。一个连接若属于 3 个项目 = 每 30s 3 次查询。1000 连接 × 平均 2 项目 = 每 30s 约 2000 次查询（~67/s），可接受但无谓；且无防重入——interval 回调是 async，若一次查询慢（> interval），下一次 tick 会**重叠执行**（DB 池压力叠加）。

### 方案选项

**C1. 批量查询 + 防重入（推荐）**
- 查询形状：一次取用户所有项目成员资格，内存比对：

```ts
// 一次查询替代 N 次
const links = await prisma.userProject.findMany({
  where: { userId },
  select: { projectId: true },
});
const owned = new Set(links.map((l) => l.projectId));
for (const pid of projectIds) {
  if (!owned.has(pid)) { /* 4403 关闭 */ }
}
```

注意：`userProject` 上 userId 有索引吗？schema 有 `userId_projectId` 复合唯一（`where: { userId_projectId }`）——`findMany({ where: { userId } })` 需要 userId 前缀索引，复合唯一索引的**首列是 userId** 则可用。需查 schema 确认；若无单列索引，加迁移（P2）。项目数 = 用户可见项目数（小，通常 < 10），内存比对成本可忽略。

- 防重入：`scheduleMembershipCheck` 加 `inFlight` 标志：回调开始置位，结束复位；`inFlight` 时跳过本轮（或用 B1 链式自续天然防重入——推荐 B1 落地后此问题自动消失）

**C2. 保持现状**
67/s 查询在小型部署无压力，但重叠执行是真实缺陷（慢查询叠加）。

### 推荐：C1（与 B1 合并实施）
- 工作量：S（ws-access 改 ~20 行 + 测试）
- 风险：低。行为变化：查询从逐项目变批量，结果语义等价；DB 压力从 O(projects) 降为 O(1)
- 测试：用户有 2/3 个项目成员资格 → 关闭/存活断言；慢查询（mock prisma 挂起）→ 无重叠执行断言

---

## 课题 D：command/ota 流 delta 更新

### 现状
`pushJobUpdate`（ota-stream.ts:202-283）：每次去抖推送**全量重读** job + targets（含 device 嵌套 + firmwareState 子查询）+ 全量 JSON 序列化 + 发给每个订阅者。1000 目标：
- DB：1 次查询取 ~1000 行（含嵌套）——不算贵（索引主键查找）
- JSON：每目标 ~200 字节 → ~200KB/推送；去抖窗口内 250ms 合并一次，高频变更（如 1000 目标逐个确认）时每 250ms 推送一次 200KB × 订阅者数
- 网络：200KB × N 订阅者 × 每 250ms → 大 job 下带宽和序列化成本显著

命令流同理（`loadCommandBatchDetail` 全量 batch）。

### 方案选项

**D1. 增量推送（版本 + 变更事件）**
- 服务端：hub 维护 `jobId -> { version: number, lastSentSnapshot?: string }`；每次 push 前重读全量（DB 查询不变），但**与上次快照 diff**：只推 `{ type: "ota_delta", job_id, version, changed: [...targets 变更行], summary }`；无变化则跳过（去抖后仍无变化 = 不推）
- 简化版：**只推变更目标**——hub 记录上次推送时每 target 的 state/result 签名（`targetId -> state+resultCode+confirmedAt`），本轮只序列化签名变化的行。1000 目标中 1 个变化 → 推送 ~300 字节
- 客户端（OtaJobPage）：`setQueryData` 前把 delta merge 进缓存（`update` 函数里按 device_id 合并 changed 数组）。**兼容性**：现有消费代码用完整 detail 替换缓存；delta 需要 merge 逻辑——前端改一处（OtaJobPage/CommandPanel 的 onMessage 处理）
- 全量快照仍然需要：**首次连接**（或连接丢失重连）必须推全量——hub 在 subscribe 时推一次全量，之后只推 delta

**D2. 分页快照**
保持全量但客户端分页拉取：推送只带 summary + 版本号，客户端按需 REST 拉详情页。优点：服务端推送最小化；缺点：实时性依赖客户端轮询/按需拉取，与现有"推送即刷新"语义不同，前端改动更大。

**D3. 保持现状 + 文档**
200KB × 高频推送只在 >500 目标的大 job 才成问题。1000 目标每 250ms 一次全量 = 4 次/s × 200KB = 800KB/s/订阅者——单订阅者可接受，多订阅者（如 10 个运营终端）8MB/s 不可接受。

### 推荐：D1（diff 增量，先推变更目标 + summary；全量仅首连）
- 工作量：M（hub 侧签名 diff ~60 行 + 前端 merge ~30 行 + 测试）
- 风险：中。注意点：
  - **丢失/重连**：WS 断线重连后必须重新全量（subscribe 时推全量——现有语义保留）
  - **版本号**：`version` 单调递增（可用 job 的 updatedAt 或 hub 内计数器），客户端可检测乱序（可选）
  - **去抖与 diff 的交互**：diff 在 push 时计算（读到的快照 vs 上次发送的快照），天然正确
  - 前端 `setQueryData` 的 merge 要**幂等**（重复 delta 不重复计数）
- 测试：1000 目标仿真（种子数据）→ 单目标变更 → 推送负载断言（< 5KB）；重连全量断言
- **度量建议**：每次 push 的 payload 字节数、diff 命中率

---

## 课题 E：OTA drain + 命令 deadline

### E1. OTA poller 有界 drain

**现状**：`otaPollOnce`（ota-publish.ts:62-112）单行租约：expire → lease 1 target → publish/ defer → 结束。默认 500ms interval → 1000 目标约 500 秒（若全在线且全订阅就绪）；默认 OTA 投递窗口（OTA_TARGET_TTL_SECONDS=900s）边缘。

**参考**：命令侧已 drain 化（publish.ts `DEFAULT_DRAIN_MAX_PER_CYCLE=100`，本轮已实现）——OTA 照抄同一骨架。

**设计**：
```ts
// ota-publish.ts：otaPollOnce 改为循环
export async function otaPollOnce(aedes, prisma, options, log): Promise<void> {
  await expireOtaTargets(prisma);
  const stalled = await expireStalledOtaTargets(prisma, options.stallTimeoutMinutes);
  if (stalled > 0) log.info("ota targets failed by stall timeout", { count: stalled });

  const drainMax = options.drainMaxPerCycle ?? DEFAULT_OTA_DRAIN_MAX_PER_CYCLE; // 建议 50
  for (let i = 0; i < drainMax; i++) {
    const target = await leaseNextOtaTarget(prisma, options.leaseDurationMs);
    if (!target) break; // 队列空
    // 原单目标处理体（offline defer / 订阅就绪 defer / publish / 失败 release）
    // 每目标处理里出错不中断循环（try/catch 包住，坏目标 release 后继续）
  }
}
```
- 与命令侧差异点：
  - OTA 有 `expireOtaTargets`/`expireStalledOtaTargets` 前置步骤（每轮一次即可，放循环外）
  - OTA 的 defer 路径（offline/未订阅）带不同 retry 延迟（5000ms/1000ms）——defer 后**该目标在本轮不再重试**（release 后重新可租约，但下一轮才轮到）——drain 循环里不会死循环（lease 语义保证：release 后 availableAt 在未来，`leaseNextOtaTarget` 不会立刻再租到）
  - 每轮预算 50（比命令 100 保守——OTA 每目标含 token 签名 + publish，稍重）
- **文件历史约束**：ota-publish.ts 历史上由另一 agent 维护（git log 核实——本仓库近期提交全为本会话；但该文件涉及固件协议语义：OTA notice payload、token 签名），改动**只改轮询骨架**（poll 循环/预算常量），**不动** notice payload、token、超时语义。改动前 `git log --oneline -- packages/broker/src/mqtt/ota-publish.ts` 确认近期提交者
- 测试：批量建 1000 目标（种子）→ 短 interval + 预算 → 断言完成数/时间；单目标 defer 不阻塞其他目标（offline + online 混合 → online 的优先投递）

**E1 推荐**：做。工作量 M，风险中低（骨架改动，语义不变）。

### E2. 命令默认 deadline（产品决策）

**现状**：`enqueue.ts` `deliveryTimeoutSeconds` NULL = 永不超时；`CommandPanel` 默认 blank。命令投递丢失（已由订阅就绪检查缓解）后，无 deadline 的命令永久占用设备队列头（`lease.ts:74-89` 每设备按序阻塞）。

**方案选项**：

**E2-A. 保持 blank（现状）**
- 优点：命令语义简单（"发出去直到设备应答"）；长任务命令（固件执行数分钟）不受限
- 缺点：投递级故障（如订阅就绪检查有遗漏、broker 内部丢包）时设备队列永久阻塞；运维无感知

**E2-B. 有限默认 deadline（如 60s，可配置覆盖）**
- API 层：`enqueueBatch` 的 `deliveryTimeoutSeconds` 缺省时用 `DEFAULT_DELIVERY_TIMEOUT_SECONDS`（env 可配，默认 60）
- 前端：CommandPanel timeout 输入预填 60（用户可清空 → 用默认；或明确"不限"选项）
- 影响：固件执行 > 60s 的命令会 delivery_failed——**破坏长任务场景**。缓解：deadline 语义是"投递窗口"不是"执行时限"？当前实现：`availableAt + deliveryTimeoutSeconds` → 到期 `delivery_failed`（lease.ts:46）——是**总窗口**（含执行）。长任务命令必须显式传大值
- 契约变化：现有测试（不传 timeout 的）全部要过默认 60s——对测试无影响（快路径）；对现有用户行为有影响（隐含行为变化）

**E2-C. 投递失败自动重试上限（dead-letter）**
- 保持 blank 语义，但 `broker_accepted` 后若设备长时间无 result（如 > 10 分钟）→ 自动 requeue 重试（幂等：设备侧按 command_id 去重——**固件当前无 idempotency 契约**，重投递可能重复执行有副作用命令）
- 需要先与固件约定 command_id 幂等（soulcloud_client_demo 是另一仓库——契约变更需固件配合）
- 优点：不破坏长任务；缺点：依赖固件幂等，否则危险

**E2-D. 推荐组合**：
1. **短期（无固件改动）**：保持 blank 默认，但**增加可观测性**——队列头命令停留时间 > 阈值（如 5 分钟）时 broker 日志 warn + 可选 webhook；前端 CommandPanel 显示"该设备队列中最早命令已等待 X"（防静默阻塞）
2. **中期（需固件幂等契约）**：E2-C 的重投递上限 + command_id 幂等（协议文档更新，固件侧跟进）
3. **产品决策点（需用户拍板）**：是否给 blank 语义加"软上限"（如默认 24h 后 delivery_failed）——兼顾长任务与防永久阻塞

**E2 推荐**：不改变默认语义（E2-B 破坏长任务）；实施 E2-D 组合。**需要用户拍板的决策点**：
- D1：blank 是否加软上限（24h）？
- D2：是否启动固件幂等契约工作（跨仓库）？

---

## SLO 建议表（GPT 报告要求的度量基线）

| 指标 | 建议初始目标 | 依据/备注 |
| --- | --- | --- |
| 支持在线设备数 | 500 台（单 broker 进程） | aedes 单进程 + 当前轮询吞吐；突破需 E1 drain + 多实例（WEB-06） |
| 峰值 log/设备/秒 | 20 条/s（持续）/ 100 条/s（突发 10s） | 限流默认 20/s（UPLINK_RATE_PER_SECOND）；容器合并后每 publish 128 元素 |
| 命令 p95 入队→设备 | < 5s（在线设备，队列空） | 当前 drain 100/cycle + 500ms interval → 理想 ~1s；目标 5s 留预算 |
| OTA 目标/分钟 | 600（在线全订阅） | E1 后 50/cycle × 120 cycles/min（500ms）；当前单行 = 120/min |
| WS 连接/进程 | 2000 全局（5 流共享） | 课题 A 全局预算默认值；单流突发 500 |
| 初始 JS gzip | ≤ 220KB gzip（当前 263KB） | WEB-10 vendor 拆分后目标；LCP < 2.5s（中端手机 + 4G） |
| WS 推送带宽 | ≤ 1MB/s/进程（1000 目标 job 全量推送场景） | 课题 D 后单目标变更推送 < 5KB |

---

## 分阶段实施顺序

| 阶段 | 内容 | 依赖 | 风险 |
| --- | --- | --- | --- |
| Phase 1（低风险） | 课题 A 全局预算 + 课题 C 批量查询（防重入可先用 inFlight 标志） | 无 | 低 |
| Phase 2（中） | 课题 B 集中调度器（收敛 4 份 expiry + membership 链式自续） | Phase 1 的 budget 注入模式 | 中低 |
| Phase 3（中） | 课题 D delta 推送（服务端 diff + 前端 merge） | 无 | 中（前端兼容性） |
| Phase 4（中低） | 课题 E1 OTA drain（骨架照抄命令侧） | 无 | 中低（文件历史约束：先 git log 核实） |
| Phase 5（决策） | 课题 E2 命令 deadline 组合方案（可观测性先行） | 用户拍板 D1/D2 | 低 |

## 明确不做
- 每用户/IP 连接限额（A3）——等全局预算落地后二期
- 多 broker 实例会话归属（WEB-06）——架构级，独立立项
- 推送压缩（gzip over WS）——Bun WS 无内置，成本 > 收益（小 payload）
