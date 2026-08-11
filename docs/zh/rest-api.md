# REST API

> 本文档是 `docs/en/rest-api.md` 的中文翻译，结构与其一一对应；如有出入以英文版为准。

API（`packages/api/src/api/`）是一个 Elysia 服务器。请求体校验在 handler 内用 Zod 手工完成（Elysia 的 `onError` 钩子在 Bun 下不可靠，且其 ValidationError 响应形状与我们的 `{error, message}` 契约不符）。所有 handler 用 `handleApiError` 包装意外故障 → 统一的 `500 {error:"internal"}`——内部消息永不泄露。

## 端点（Endpoints）

### 健康检查（Health）

| 端点 | 行为 |
| --- | --- |
| `GET /health/live` | 始终 `200 {"status":"ok"}` |
| `GET /health/ready` | PostgreSQL ping → `200 ready` / `503 not_ready` |

### 认证（Auth，`packages/api/src/api/auth.ts`）

| 端点 | 行为 |
| --- | --- |
| `POST /v1/auth/register` | `{username, password, email}` → 创建用户 + 个人项目；`201` 并返回令牌对；用户名/邮箱被占用时 `409` |
| `POST /v1/auth/login` | `{username, password}` → 令牌对；`401 invalid_credentials` |
| `POST /v1/auth/refresh` | `{refresh_token}` → 轮换后的令牌对；未知/过期/复用返回 `401` |
| `POST /v1/auth/logout` | 吊销刷新令牌 |

### 命令（Commands，`packages/api/src/api/app.ts`）

| 端点 | 行为 |
| --- | --- |
| `POST /v1/command-batches` | `{device_ids, command, delivery_timeout_seconds?}` → `202 {batch_id, device_count}`；需要认证；每个目标设备所在项目都必须可访问（否则 403） |

错误映射（与 Rust 版兼容）：`400 invalid_targets`（空/重复/过多，上限 1000）、`404 target_devices_not_found`、`422 invalid_device_uid`、`400 invalid_request`、`500 command_queue_unavailable`（详情仅记日志）、`401 unauthorized`、`403 forbidden`。

### 当前用户（Current user，`packages/api/src/api/me.ts`）

| 端点 | 行为 |
| --- | --- |
| `GET /v1/me` | 当前用户 + 项目列表：`{user_id, username, projects: [{project_id, name, device_count}]}`（注册会创建个人项目）；无认证时 `401` |

### 设备（Devices，`packages/api/src/api/devices.ts`）

| 端点 | 行为 |
| --- | --- |
| `GET /v1/projects/:id/devices?limit=&offset=` | 基于 offset 分页（pagination）的设备列表，含每设备固件状态和 `total`（设备没有时间戳列，因此用 offset 分页而非 keyset）；`404 project_not_found`、非成员 `403` |
| `GET /v1/devices/:id` | 设备详情：uid、assigned_id、project、auth_revoked、next_command_sequence、固件状态；`404`/`403` |
| `POST /v1/devices` | `{project_id, assigned_id, device_uid}` → `201` 并返回一次性 `mqtt_password`（argon2id 存储，与凭据签发契约相同）；`422 invalid_device_uid`（对 MQTT 主题不安全）、`409 device_uid_taken` / `409 assigned_id_taken` |
| `GET /v1/devices/:id/commands?limit=&cursor=` | 每设备命令历史，最新在前，基于每设备 `sequence` 的 keyset；payload 解码为 `{cmd, args}`（bigint → 字符串，bytes → base64），终态结果解码为 `{code, payload}` |
| `GET /v1/command-batches/:id` | 批次详情：按状态的 `summary` + 每设备解码命令；一个批次可能跨越调用者的多个项目（任一目标项目不可访问则 403） |

### 固件产物与日志（Firmware artifacts & logs，`packages/api/src/api/logging.ts`）

| 端点 | 行为 |
| --- | --- |
| `POST /v1/firmware-artifacts` | multipart `file` + `project_id`（+ 可选 `version`）；SHA-256 构建 ID；同步字典导入；`201`（幂等重复上传 `200`）；超过 32 MB `413`（声明长度，或分块请求的流式上限）；`422 invalid_elf`；不使用 `409`（改为幂等） |
| `GET /v1/firmware-artifacts?project_id=&limit=` | 产物列表，含字典条目计数 |
| `GET /v1/devices/:id/logs?limit=&cursor=&include_raw=` | 基于 cursor 分页的原始事件，按需解码（`tag`、`message`、`decode_state`）；`include_raw=1` 附加 base64 原始包 |
| `GET /v1/devices/:id/firmware-state` | 当前固件哈希 / 产物 / 上报时间 |
| `POST /v1/devices/:id/firmware-state` | `{artifact_id}` 手动绑定（产物必须属于设备的项目，否则 403）；回填（backfill）`unknown_fw` 事件 |
| `POST /v1/devices/:id/credentials` | 签发设备凭据（密码只返回一次，argon2id 哈希存储，清除吊销状态） |
| `POST /v1/devices/:id/credentials/revoke` | 拒绝新连接并终止活动会话（NOTIFY） |

### 实时日志流（Realtime log stream，`packages/api/src/api/log-stream.ts`）

| 端点 | 认证 | 帧 |
| --- | --- | --- |
| `GET /v1/ws/logs?device_id=<uuid>` | `Sec-WebSocket-Protocol: ["soulcloud", "<access token>"]` | 打开时 `{type:"ready"}` · 每个事件 `{type:"log", device_id, event}` · 心跳回复 `{type:"pong"}` |

| `GET /v1/ws/commands?batch_id=<uuid>` | 同上 | 打开时 `{type:"ready"}` · 每次状态变化 `{type:"batch", batch_id, device_count, summary, commands}` · `{type:"pong"}` |
| `GET /v1/ws/ota?job_id=<uuid>` | 同上 | 打开时 `{type:"ready"}` · 每次目标迁移 `{type:"ota", job_id, release_id, created_at, state, targets, summary}` · `{type:"pong"}` |

命令流：`recordDeviceResult` 在记录事务内 `pg_notify` `soulcloud_command_results`（payload = 批次 ID，提交后投递；QoS1 重放和不匹配绝不通知）。推送的 `{type:"batch"}` 帧与 `GET /v1/command-batches/:id` 相同。

OTA 流：LISTEN `soulcloud_ota`（payload = 任务 ID），推送与 `GET /v1/ota-jobs/:id` 相同形状，外加派生的任务级 `state`（`running` / `completed` / `failed`）。

WebSocket 升级，为单台设备流式传输解码后的日志事件。由于浏览器无法在 WebSocket 上设置 header，访问令牌放在子协议列表中；令牌无效时升级以 `401` 拒绝，`device_id` 非 UUID 时 `400`，设备不存在或调用者不是项目成员时 `404`（通过把子协议令牌投影到 Authorization header 复用 `authenticateRequest`）。

数据路径：`ingestLogPacket` / `ingestLogBundle` `pg_notify` `soulcloud_log_events` 通道（payload 仅为设备 id；hub 重新查询自身每设备高水位之上的所有事件，事件 id 不随通知传输——按设计有损，消费者回退到 REST 分页）；API 进程运行进程级懒启动 LISTEN 中枢（hub，故障重连），在触碰数据库**之前**查找订阅者（无订阅者的通知绝不执行查询），并通过 `decodeEventsBatch` 在服务端解码（每个产物缓存字典，60 s TTL，有界淘汰），然后把每个事件扇出（fan-out）给该设备的每个订阅者。

流加固（与命令/OTA 流共享）：

- **去抖（Debounce）**：同一设备的突发通知合并为一次重新查询 + 一次推送（250 ms 窗口，外加最大等待上限，使持续突发不会饿死推送）。
- **令牌过期**：握手令牌的 `exp` 在活动连接上强制执行——一旦过期，服务端以 `4401 token expired` 关闭；前端 hook 用新令牌重连。
- **连接上限**：每进程限制（默认 500），多余 socket 以 `4401 too many connections` 拒绝。
- 订阅者键规范化（小写 UUID），因此混合大小写的 `device_id` 查询仍能收到推送。

`event` 与 `GET /v1/devices/:id/logs` 条目形状相同（`id`、`received_at`、`device_time_ms`、`sequence`、`packet_type`、`level`、`tag`、`message`、`decode_state`；无 `raw_packet_b64`）。客户端可发送 `"ping"` 或 `{"type":"ping"}` 作为心跳。

```json
{"type":"ready","device_id":"<uuid>"}
{"type":"log","device_id":"<uuid>","event":{"id":"42","received_at":"2026-08-07T11:00:00Z","device_time_ms":"1700000000123","sequence":7,"packet_type":1,"level":2,"tag":"app","message":"booted","decode_state":"decoded"}}
{"type":"pong"}
```

### 固件版本发布与 OTA 任务（Firmware releases & OTA jobs，`packages/api/src/api/firmware.ts`）

| 端点 | 行为 |
| --- | --- |
| `POST /v1/firmware-releases` | multipart `bin`（必填）+ `elf`（可选）+ `project_id`（+ 可选 `version`）；`201`/`200` 幂等；`413`/`422` |
| `GET /v1/firmware-releases?project_id=&limit=&cursor=` | 基于 cursor 分页的版本发布（release）列表（`<createdAt>|<releaseId>` 复合 keyset） |
| `GET /v1/firmware-releases/:id` | 详情，含关联产物构建 ID + 字典条目 |
| `POST /v1/firmware-releases/:id/deploy` | `{device_ids}` → `201 {job_id, targets}`；通过 MQTT 扇出每设备下载凭据 |
| `GET /v1/firmware-releases/:id/bin` | 二进制下载（人类用 Bearer，设备用每设备短期 JWT，保留旧版 `?token=`） |
| `GET /v1/ota-jobs/:id` | 任务详情，含每目标状态和当前固件 |
| `GET /v1/ota-jobs?project_id=&limit=&offset=` | 任务列表，含 `target_count` 和按状态的 `summary`（经 groupBy 聚合） |

### 滚动发布（Rollouts，`packages/api/src/api/rollout.ts`）

| 端点 | 行为 |
| --- | --- |
| `POST /v1/firmware-releases/:id/rollouts` | 创建分阶段部署（deploy）：`strategy: auto`（服务端随机化池 + 比例，默认 5/25/100%）或 `grouped`（客户端分组）；每滚动发布设置 `success_ratio`（0.9）、`min_sample`（10）、`phase_timeout_hours`（24）、`stuck_hours`（6）、`manual_approval`（手动审批）；可选 `from_release_id` 用于回滚 |
| `GET /v1/ota-rollouts/:id` | 详情：状态、设置、每阶段任务摘要、池大小 |
| `GET /v1/ota-rollouts?project_id=&limit=&offset=` | 滚动发布列表，含 `pool_size`、strategy/state 和按状态的跨阶段 `progress` |
| `POST /v1/ota-rollouts/:id/pause` | 停止推进（进行中的投递不受影响）；状态错误 `409` |
| `POST /v1/ota-rollouts/:id/resume` | 恢复已暂停的滚动发布或手动审批等待（激活下一阶段） |
| `POST /v1/ota-rollouts/:id/abort` | 停止推进；已交付设备保留其固件；待处理阶段取消 |
| `POST /v1/ota-rollouts/:id/rollback` | 中止并为其 `completed` 设备创建 `from_release_id` 的 ota_job（已安装者排除）；幂等；无基线或已确认设备时 `409 rollback_unavailable` |

推进循环：API 进程每 `ROLLOUT_POLL_INTERVAL_MS`（30 s）轮询；条件 UPDATE 使多个 API 实例安全。门控（gating）：`completed/actual ≥ success_ratio` 且 `completed ≥ min(min_sample, actual)`；阶段超时未达标 → 自动暂停（绝不自动回滚）；停滞（stall）判定：`installed` > stuck_hours 且设备存活（stat 在 1 h 内）且固件不匹配 → `failed (-6)`（已断电设备豁免）。

## 校验（Validation）

`packages/api/src/api/validate.ts` 集中管理：

- `UuidParam` — 路径/查询 UUID
- `CursorParam` — 正整数 cursor（日志分页）
- `LimitParam` — 整数 1..500 页大小
- `authenticateRequest()` — Bearer JWT → 用户（或 null）
- `userCanAccessProject()` — user_projects 成员资格（membership）
- `handleApiError()` — 统一 500 且不泄露内部信息

## 分页（Pagination）

日志查询使用基于 `raw_log_events.id`（自增）的 keyset 分页：`?cursor=<last_id>` 返回更早的事件；还有更多行时返回 `next_cursor`。页大小默认 100，上限 500。

## 备注（Notes）

- multipart 上传在缓冲前拒绝超大请求体（声明的 `Content-Length`，分块请求另有流式硬上限）。
- `include_raw` 为选填，保持默认响应小巧。
- 无法解码的日志事件返回 `message: null` 及其 `decode_state`；原始数据始终保留。
