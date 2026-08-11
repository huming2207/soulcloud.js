# 命令投递截止时间 — 设计决策

> 本文档是 `docs/en/plan-command-deadline.md` 的中文翻译，与英文版一一对应。

**日期**：2026-08-11 · **状态**：方案（尚未实现） · **读者**：平台决策者 ·
**来源**：GPT/Codex 审查 WEB-01（后续项）

## 1. 问题

命令没有默认的应用结果截止时间。`enqueueBatch`
（`packages/core/src/queue/enqueue.ts:39-46`）在调用方未传
`deliveryTimeoutSeconds` 时存储 `deliveryExpiresAt = null`；Web 控制台
（`packages/web/src/components/CommandPanel.tsx:100,119-139`）默认留空超时
字段并省略 `delivery_timeout_seconds`。

一旦命令进入 `broker_accepted`，它不会再被租约
（`packages/core/src/queue/lease.ts:74-89`——按设备的 NOT EXISTS 守卫在旧行
仍处于 queued/leased/broker_accepted 时阻塞后续命令）。如果 broker 已接受
的发布在设备侧丢失（处理前重启、Wi-Fi 抖动、固件缺陷），该行与该设备的
所有后续命令会永久阻塞。WEB-01 的订阅就绪检查（SUBSCRIBE 注册后才发布）
移除了*主要*丢失窗口，但命令仍可能在设备 SUBACK 与实际处理之间被接受后
丢失。

## 2. 现状（文件级）

| 项 | 位置 | 行为 |
| --- | --- | --- |
| 截止时间存储 | `device_commands.delivery_expires_at`（可空） | NULL = 永不过期 |
| 截止时间过期 | `expireDelayedCommands`（`packages/core/src/queue/lease.ts:37-60`） | queued/leased/broker_accepted 且已过期限 → `delivery_failed`（终态，释放队列） |
| 入队默认 | `enqueueBatch` options（`enqueue.ts:39-46`） | undefined → NULL 期限 |
| API | `packages/api/src/api/app.ts:50` — `delivery_timeout_seconds` 可选 | 省略 → NULL |
| UI | `CommandPanel.tsx:100,119-139` | 空字段 → 省略 |
| 测试 | `packages/core/tests/queue/queue.test.ts:412,458` | 断言空时 `deliveryExpiresAt` 为 null、设置时非 null |
| 固件 | soulcloud_client_demo（独立仓库） | 执行命令；可能耗时任意长；无结果截止时间概念 |

## 3. 方案

### 方案 A — 默认有限截止时间（如 60 秒，可配置）

- **机制**：调用方省略时，`enqueueBatch` 默认 `deliveryTimeoutSeconds` 为
  配置值（环境变量 `COMMAND_DEFAULT_DELIVERY_TIMEOUT_SECONDS`，默认 60）。
  `CommandPanel` 预填 60。
- **改动点**：`enqueue.ts`（默认值）、`app.ts`（配置透传）、
  `CommandPanel.tsx`（预填）、`config`（新环境变量）、队列测试
  （`queue.test.ts:458` 的 null 断言翻转）、web 测试、API 测试、
  `docs/en|zh/rest-api.md`（字段语义）。
- **影响**：
  - 长任务命令（固件合法耗时数分钟）会被平台判定失败，而设备仍在执行——
    设备稍后上报的 `cmd/result` 会落在已 `delivery_failed` 的行上（结果
    记录按 batch+sequence 键控；落地前先核对 `recordDeviceResult` 行为）。
  - 入队到结果 P95 延迟被默认值界定——良好的运维属性。
  - 对现有部署是破坏性语义变更（"最终会完成"的命令现在会超时）。
- **回滚**：一行默认值翻转；已标 `delivery_failed` 的数据保持终态
  （不自动复活）。
- **结论**：简单，但没有结果截止时间的升级路径时，长命令误判失败是
  真实产品风险。

### 方案 B — 保持空（无截止时间）+ 有界重投递次数

- **机制**：保留 NULL 期限语义。在*发布*路径按 `attempt_count` 加投递
  策略：发布被推迟（离线 / 未订阅 / 发布失败）时 broker 计数；推迟 N 次
  （如 3 次）后该行进入 `delivery_failed`。`leaseNext` 已按租约递增
  `attempt_count`；`packages/broker/src/mqtt/publish.ts` 的推迟分支决定。
- **改动点**：`publish.ts`（推迟计数 + 终态迁移）、`lease.ts`/队列中新增
  状态迁移辅助函数、测试（推迟 × N → failed）、文档。
- **影响**：
  - 只约束了*传输*层；broker 已接受但设备从未确认的命令仍永久阻塞队列
    （与今天相同的洞，只是更窄）。
  - API/UI 语义不变；固件契约不变。
- **回滚**：移除计数检查；终态行保持终态。
- **结论**：修了轮询层循环，没修接受层漏洞。

### 方案 C — 结合：默认有限截止时间 + 迟到结果容忍

- **机制**：方案 A 的默认（60 秒）**加上** `recordDeviceResult` 接受
  `delivery_failed` 行的结果（匹配结果到达时 `delivery_failed` →
  `completed`，遵守 sequence 顺序），使超长命令迟到完成时正确落账而非
  误报失败。
- **改动点**：方案 A 清单 + `recordDeviceResult` 状态迁移处理 + 测试
  （过期后的迟到结果）、文档。
- **影响**：
  - 有界最坏情况（截止时间）+ 优雅迟到完成——队列永不永久阻塞，长命令
    仍能记录。
  - 改动面略大；迟到结果路径必须遵守按设备 sequence 守卫（过期命令的
    迟到结果不得重排更新命令的结果）。
- **回滚**：按方案单独回退；迟到结果接受是增量式。
- **结论**：运维属性最佳；推荐。

## 4. 推荐

**方案 C**，默认值保守（60 秒是良好起点；做成环境变量可配）。sequence
守卫细节：

- `recordDeviceResult` 已按（设备，sequence）键控——验证它对
  `delivery_failed` 行幂等，且迟到结果不能覆盖*更新*命令的结果（按设备
  sequence 单调性，检查 `sequence <= next_command_sequence - 1`）。
- 固件契约：无需变更（设备本就以 batch+sequence 上报结果；平台变得更
  宽容而非更严格）。

## 5. 后续（需产品决策）

1. 默认超时值（60 秒？5 分钟？）以及是否按命令类别区分。
2. `delivery_failed` 的迟到结果是否在 UI 呈现（"超时后完成"徽标）还是
   静默对账。
3. 同一截止策略是否适用于 OTA 目标（已有 `expires_at`；问题只在默认值）。
