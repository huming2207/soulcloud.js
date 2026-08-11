# 数据库

> 中文翻译，与 docs/en/ 同名英文文档对应。


PostgreSQL 是唯一的持久化存储和事实来源。schema 定义在
`packages/core/prisma/schema.prisma`（Prisma 7，生成客户端在
`packages/core/generated/prisma`，已 gitignore）。迁移位于
`packages/core/prisma/migrations/`。

## 表

### 身份与租户

| 表 | 用途 |
| --- | --- |
| `users` | 人类用户：唯一 `username`/`email`、argon2id `password_hash` |
| `organisations` / `projects` | 原始多租户脚手架（至今未用） |
| `organisation_users` / `organisation_projects` | 原始 M2M 脚手架 |
| `user_projects` | **当前生效的租户模型**：直接 用户 → 项目 成员资格（G 组） |
| `refresh_tokens` | 服务端 JWT 刷新令牌：仅 SHA-256、过期、吊销、轮换链 |

### 设备与命令

| 表 | 用途 |
| --- | --- |
| `devices` | 设备注册表：全局唯一 `device_uid`（MQTT username/clientId）、项目作用域 `assigned_id`、argon2id `password_hash`、`auth_revoked` 标志、按设备单调递增的 `next_command_sequence` |
| `command_batches` | 每个 API 批次请求一行持久化记录 |
| `device_commands` | 持久化命令出站队列（outbox）：每设备一行，含 MessagePack payload、状态机、租约字段、投递截止时间、结果字段 |

### 日志（on9log）

| 表 | 用途 |
| --- | --- |
| `firmware_artifacts` | 每个项目上传的 ELF；`build_id` = ELF SHA-256（项目内唯一）；导入状态 |
| `firmware_log_strings` | 固件产物 + ELF 地址 → tag/format 字符串字典 |
| `raw_log_events` | 不可变的原始 on9log 包 + 信封元数据（事实来源） |
| `device_firmware_state` | 每台设备最近上报的固件哈希（来自 `stat.fw`） |

### OTA 滚动发布

| 表 | 用途 |
| --- | --- |
| `ota_rollouts` | 滚动发布容器：目标版本发布、可选 `from_release_id`（回滚基线）、按滚动发布存储的门控设置（`success_ratio`、`min_sample`、`phase_timeout_hours`、`stuck_hours`、`manual_approval`）、回滚 job 链接 |
| `ota_rollout_pool` | 设备快照（rollout_id + device_id + sort_idx）；auto 策略随机化 sort_idx，grouped 保持客户端顺序 |
| `ota_rollout_phases` | 每个阶段一行（1 起始索引、比例/分组、`target_count`）；激活时创建一个普通 `ota_job`（投递复用标准目标状态机） |

`ota_targets` 在既有状态机字段之外新增了 `installed_at`
（停滞判定依据，在 `installed` 确认时设置）。

**注意**: 池中设备在其 target 存在期间受 FK RESTRICT 保护——滚动发布进行中
设备不能被删除（数据一致性优先于"跳过已删除设备"的替代方案）。

## 关键设计决策

- **无符号 32 位线上值是 `BigInt` 列**（`deviceTimeMs`、`tagId`、`fmtId`、
  `FirmwareLogString.address`）：int4 是有符号的，设备运行约 24.8 天后溢出
  （审计修复 S4）。
- **`raw_log_events.id` 是自增 BigInt** 用于游标分页（cursor pagination）
  （`WHERE id < cursor`），而不是 UUID。
- **Prisma 无法表达的 CHECK 约束**追加在初始迁移里（状态合法性、租约/broker/结果
  一致性、非空白、计数器为正）。命令状态机在 SQL 层强制：
  ```sql
  CHECK (state IN ('queued','leased','broker_accepted','device_completed','delivery_failed'))
  CHECK (state='leased' AND lease_expires_at IS NOT NULL OR state<>'leased' AND lease_expires_at IS NULL)
  CHECK ((state IN ('broker_accepted','device_completed') AND broker_accepted_at IS NOT NULL) OR ...)
  CHECK ((state='device_completed' AND result_code IS NOT NULL AND result_packet IS NOT NULL AND device_completed_at IS NOT NULL) OR ...)
  ```
- **认领路径（claim path）的查询索引**：
  `device_commands_claim_idx (available_at, created_at, id) WHERE state IN ('queued','leased')`、
  `device_commands_device_pending_idx (device_id, created_at, id) WHERE state IN ('queued','leased','broker_accepted')`、
  `device_commands_batch_state_idx (batch_id, state)`。

## 迁移

| 迁移 | 内容 |
| --- | --- |
| `initial_domain_schema` | users/organisations/projects/devices/relations + CHECK |
| `log_ingestion` | firmware_artifacts、firmware_log_strings、raw_log_events、device_firmware_state |
| `int_to_bigint_log_columns` | 审计修复 S4 |
| `artifact_build_unique_per_project` | 审计修复 M3（构建身份按项目） |
| `command_delivery_timeout` | `delivery_expires_at` + `delivery_failed` 状态（M2） |
| `auth` | refresh_tokens、user_projects、devices.auth_revoked（G 组） |
| `firmware_releases` | OTA 版本发布 + 下载令牌（后被 `ota_mqtt_deploy` 移除） |
| `ota_mqtt_deploy` | ota_jobs/ota_targets（取代下载令牌）；ota_targets CHECK 约束 |
| `ota_result` | ota_targets 终态（completed/failed）、结果字段、中间状态 |
| `ota_result_constraint_fix` / `ota_result_constraint_fix2` | delivered_at CHECK 修正（终态行必须无条件通过） |
| `ota_rollout` | ota_rollouts / ota_rollout_pool / ota_rollout_phases |
| `rollout_support_columns` | ota_targets.installed_at、ota_rollout_phases.target_count |
| `rollout_phase_activated_fix` / `fix2` | activated_at CHECK 修正（与 ota_targets 修复同类） |

迁移管理：`bun run db:migrate`（开发）/ `db:deploy`（CI/生产）。
`prisma.config.ts` 从包目录或仓库根加载 `.env`。

## 完整性说明

- 删除项目会级联删除用户关联和固件产物；设备在有命令或日志事件时
  删除受 RESTRICT 限制。
- `build_id` 唯一索引按项目作用域（审计修复 M3）：同一个 ELF 可以存在于
  两个项目中，而不会跨租户泄漏引用。
