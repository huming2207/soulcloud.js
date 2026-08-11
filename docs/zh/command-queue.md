# 命令队列（Command Queue）

> 本文档是 `docs/en/command-queue.md` 的中文翻译，结构与其一一对应；如有出入以英文版为准。

持久化的、按设备隔离的命令队列是平台的核心：API 入队（enqueue），broker 通过 MQTT QoS 1 投递，结果被幂等地记录。实现位于 `packages/core/src/queue/`。

## 状态机

```
queued ──lease──▶ leased ──aedes.publish()──▶ broker_accepted ──cmd/result──▶ device_completed
   ▲                 │                              │
   │                 └──(publish failed)────────────┘  (releaseLease)
   │                                                    │
   └──────────────(lease expired)───────────────────────┘
   │
   └──(delivery deadline passed)──▶ delivery_failed   (terminal)
```

- `queued` — 由 API 插入，可被租用（lease）
- `leased` — 已被某个 broker 认领（租约过期支持崩溃恢复）
- `broker_accepted` — broker 已接受 QoS 1 publish（并非设备确认）
- `device_completed` — 已存储一条校验通过且匹配的 `cmd/result`
- `delivery_failed` — 终态；释放该设备的队列而不等待设备结果（每条命令超时，审计修复 M2）

**每设备有序性**：一台设备只有最旧的未完成命令可以被租用；`broker_accepted` 仍会阻塞后续命令，直到 `device_completed`（契约如此）。排序比较的是 `sequence`（每设备单调递增），而非 `created_at`——并发入队按事务提交顺序落库，可能与发起顺序不同（审计修复 M8）。

## 文件（Files）

| 文件 | 职责 |
| --- | --- |
| `enqueue.ts` | `enqueueBatch()`：校验目标（非空、唯一、≤ 1000、topic 安全 UID），在事务中递增 `next_command_sequence`，编码每设备 MessagePack 执行包，插入批次 + 行，`pg_notify` 唤醒通道。可选 `deliveryTimeoutSeconds` 设置 `delivery_expires_at`。 |
| `lease.ts` | `leaseNext()`：`FOR UPDATE SKIP LOCKED` 认领最旧的可认领行；`expireDelayedCommands()`：把超过期限的行移动到 `delivery_failed`。 |
| `acknowledge.ts` | `markBrokerAccepted()`（幂等）、`releaseLease()`（publish 失败 → 回到 queued）。 |
| `result.ts` | `recordDeviceResult()`：事务——锁行、校验 id/seq/设备 UID、幂等重放相同结果、拒绝冲突结果、完成该行。 |
| `notify.ts` | LISTEN/NOTIFY 的通道常量。 |
| `errors.ts` | 带 `kind` 判别器的类型化 `CommandQueueError`。 |

## 投递语义（Delivery semantics）

- **QoS 1 + 租约恢复允许重新投递**；服务端幂等地接受重复的相同结果（`already_recorded`），拒绝不匹配或冲突的结果。
- **恰好一次（exactly-once）副作用是设备的事**：固件必须持久记住已处理的序列并重放已存结果（参见设备侧配置存储需求文档）。服务端只保证至少一次（at-least-once）投递。
- **每条命令的投递期限**（API 中的 `delivery_timeout_seconds`）：NULL = 永不过期（一直重试直到设备完成）；有值时，期限一过命令就进入 `delivery_failed`，释放该设备的队列。
- **离线设备**：轮询器不向离线设备发布（QoS 1 clean-session 消息会被 broker 丢弃，使命令滞留）；命令保持 queued 状态，重连时投递。

## 唤醒（Wake-up）

API 在入队事务内 `pg_notify` `soulcloud_commands`（PostgreSQL 在提交后才投递，因此只有成功入队才会唤醒 broker）。broker 的通知器触发立即轮询；500 ms 间隔仍是正确性兜底。

## 结果幂等细节（Result idempotency details）

`recordDeviceResult` 在语义层面比较解码后的存储结果（二进制 ID 逐字节比较、数字/bigint 归一化、NaN 等于自身）；在本地 PUBACK 处理完成之前到达的结果会直接从 `queued`/`leased` 完成该行（结果本身即证明 broker 已接受）。

## 测试（Tests）

`packages/core/tests/queue/queue.test.ts`（20 个测试）：原子入队、序列分配、空/重复/缺失/不安全目标、租约认领、过期恢复、每设备有序性（broker_accepted 阻塞）、markBrokerAccepted/releaseLease 冲突、结果幂等/冲突/不匹配、投递期限、并发入队排序。
