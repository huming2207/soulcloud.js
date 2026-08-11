# OTA 轮询器有界排空（Bounded Drain）— 设计

> 本文档是 `docs/en/plan-ota-drain.md` 的中文翻译，与英文版一一对应。

**日期**：2026-08-11 · **状态**：方案（尚未实现） · **来源**：
GPT/Codex 审查 WEB-05（OTA 侧）

## 1. 问题

OTA 轮询器每个轮询周期只投递**一个目标**
（`packages/broker/src/mqtt/ota-publish.ts` — `otaPollOnce` 经
`leaseNextOtaTarget` 租约单个目标）。默认 500 ms 间隔
（`OTA_POLL_INTERVAL_MS`，`packages/broker/src/config.ts:23`）下，1000
目标的 job 在理想全在线场景约需 500 秒——正好处于默认投递窗口边缘
（`DEFAULT_ROLLOUT_TARGET_TTL_SECONDS = 15 * 60`，
`packages/core/src/ota/rollout.ts:40`）。离线推迟、数据库延迟或竞争 job
会把靠后目标推过 `expires_at`，它们以 `expired` 状态死亡而从未被发布。

命令轮询器已获得该修复（有界排空，`packages/broker/src/mqtt/publish.ts` —
`DEFAULT_DRAIN_MAX_PER_CYCLE = 100`，`pollOnce` 内循环）；OTA 侧尚未实施。

## 2. 现状与命令轮询器对比

| 方面 | 命令轮询器（已完成） | OTA 轮询器（本方案） |
| --- | --- | --- |
| 每周期租约 | 1 → 排空至 100 | 1 |
| 订阅就绪检查 | 已检查（推迟 1 秒） | 已检查（推迟 1 秒，`4a81b1b`） |
| 离线推迟 | `available_at` 退避 | `releaseOtaTarget(…, offlineRetryMs)` |
| 过期扫描 | 每周期 `expireDelayedCommands` | 每周期 `expireOtaTargets` + `expireStalledOtaTargets` |
| 唤醒 | 有损 `wake()` → 一个周期 | 相同 |
| 保留发布 | 可配置 | 从不（刻意） |

排空循环必须保留的 OTA 特有语义：

- **每目标窗口**：`ota_targets.expires_at` 界定每个目标；租约不延长窗口。
  排空循环不得在单周期内饿死后续目标（有界预算 + 租约查询已按
  `created_at` 排序——无碍）。
- **停滞语义**：`expireStalledOtaTargets` 在 `stallTimeoutMinutes` 后失败
  *已投递*目标；排空速度与之无交互。
- **无忙循环的推迟**：离线/未订阅推迟会把 `available_at` 设到未来，因此
  排空循环在剩余目标全部被推迟时自然停止。
- **租约时长与排空时长**：长排空周期（100 目标 × DB+发布延迟）会让行在
  周期内保持租约；租约时长必须舒适地超过最坏周期（默认 30 秒租约 vs
  毫秒级发布——在测试中确认）。

## 3. 设计

完全镜像命令轮询器（相同骨架，不同租约调用）：

```
otaPollOnce:
  expireOtaTargets
  expireStalledOtaTargets
  budget = OTA_DRAIN_MAX_PER_CYCLE（默认 100，可配置）
  for i in 0..budget:
    target = leaseNextOtaTarget          // null -> 返回
    if !online: 推迟（退避）; continue
    if !subscribed: 推迟（1 秒）; continue
    发布 notice; markOtaTargetDelivered
```

- **新配置**：`OTA_DRAIN_MAX_PER_CYCLE`（默认 100），与
  `OTA_POLL_INTERVAL_MS` 并列于 `packages/broker/src/config.ts`。
- **改动点**：
  - `packages/broker/src/mqtt/ota-publish.ts`：把单目标主体包进带预算的
    循环（单目标主体抽成 `handleLeasedOtaTarget(aedes, prisma, options,
    log, target)`——即当前 `otaPollOnce` 租约后的主体）。
  - `packages/broker/src/config.ts`：新环境变量 + 默认值。
  - `packages/broker/src/index.ts`：透传 `drainMaxPerCycle`。
  - 测试（见下）。
- **非目标**：v1 不做并发（并行发布）——循环与命令轮询器一样串行；如
  剖析证明串行是瓶颈，再考虑并行旋钮（`OTA_DRAIN_CONCURRENCY`）。

## 4. 测试计划

- 单元（mock prisma）：一个周期发布至多 `budget` 个目标；`leaseNextOtaTarget`
  返回 null 时停止；推迟（离线/未订阅）消耗预算槽位但不报错。
- 集成（真实 broker + DB，现有 `ota-publish` 测试基建）：创建 N 目标 job
  （如 150 > 预算 100），全部设备在线+已订阅 → 一次唤醒周期内全部投递
  （断言下一个轮询 tick 前 `delivered_at` 已设置）。
- 窗口测试：N=1000 仿真，短 `expires_at`（如 10 秒）+ 
  `OTA_DRAIN_MAX_PER_CYCLE=1000` → 窗口内全部投递；旧单目标循环下同测试
  会失败（投递率 2/s）。
- 回归：单目标仍正常投递；停滞过期仍失败 delivered 未确认目标；离线推迟
  退避不变。

## 5. 风险与协调

- **近期作者**：`ota-publish.ts` 最近一次由其他作者修改于 `4a81b1b`
  （2026-08-08，订阅就绪修复）。排空改动围绕该逻辑做增量——不要重写
  就绪检查，原样抽入单目标处理器。若该作者有未合并工作需协调（开工前
  检查 `git status`/分支）。
- **死代码**：`otaPollOnce` 当前计算 `topic` 两次（重复 try/catch 块）。
  重构顺带消除重复——在提交信息中注明。
- **租约时长上限**：100 目标预算 + 最坏每目标延迟下，单周期可能超过默认
  租约时长。在集成测试中度量；必要时提高默认租约或让预算自适应
  （`now() - cycleStart > leaseMs/2` 时停止）。

## 6. 推荐

**按上述方案实施有界排空**（串行、预算 100、可配置）。预期效果：
1000 目标 job 约 5-10 秒投递完毕（原约 500 秒），远在 900 秒窗口内；
`wake()` 使新 job 立即开始排空。并发与自适应预算仅在负载测试证明串行
循环是瓶颈后跟进。
