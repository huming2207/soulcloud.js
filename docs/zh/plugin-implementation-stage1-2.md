# 插件系统实施记录（阶段 1 + 阶段 2）

> 本文档记录 `plugin-and-station-architecture.md` 中阶段 1（架构与 SDK 骨架）和
> 阶段 2（容器化插件隔离原型）的落地实现。设计动机和完整背景见该提案文档。

**日期**：2026-08-22 · **基线**：733 个后端非 E2E 测试全绿（Bun 1.4，含插件测试与
评审修复回归）、`tsc --noEmit` 干净、`docker compose config` 校验通过。
评审修复（H1/H2）见文末「评审修复记录」。

## 概览

新增两个可部署角色、一个共享 SDK、一个插件 workspace 包：

```
packages/
  plugin-sdk/          # 共享契约：类型 + 纯校验器（无 DB、无 secret）
  plugin-host/         # 不可信侧容器：每容器一个插件，oRPC/WebSocket 服务端
  plugin-dispatcher/   # 可信进程：租约事件、WebSocket client、公平调度、权威校验
  core/src/plugins/    # 共享服务层：installation / entity / 事件队列

plugins/
  registry.ts          # 编译期注册表（manifest map + worker map）
  generic-device/      # soulcloud.generic 内置 profile（既有设备的默认映射）
  chaos-test/          # soulcloud.test.chaos 故意作恶的测试插件
```

信任边界一览：

| 进程 | 加载插件代码 | 持有数据库 | 持有 JWT/secret |
| --- | --- | --- | --- |
| `@soulcloud/api` / `@soulcloud/broker` | 否（不在热路径） | 是 | 是 |
| `@soulcloud/plugin-dispatcher` | 否（只读 manifest 元数据） | 是 | 是 |
| `@soulcloud/plugin-host` | 是（一个插件/进程） | **否** | **否** |

数据流（下行，§6.3）：

```
设备 /event envelope（阶段 5 接入 broker）
  → plugin_events（durable 行）
  → dispatcher 租约 + 路由（由 device → installation 绑定推导，不信任设备声明）
  → 容器网络 oRPC/WebSocket → plugin-host → 插件 worker
  → 响应（updates）回到 dispatcher
  → 权威校验 → 与事件完成同一事务内写入 entity_current_state / entity_history
```

## 数据库（迁移 `20260821031915_plugin_sdk_entity_and_events`）

| 表 | 职责 |
| --- | --- |
| `plugin_installations` | 项目级插件启用；`configured_plugin_version` 与部署 registry 精确匹配，漂移进入 `error`（`sweepInstallationVersions` 定期扫描），绝不自动升降级 |
| `entity_descriptor_revisions` | descriptor 不可变快照；`canonicalDescriptor` 变化创建新 revision，改名=新 entity（§4.1） |
| `entity_registry` | `(device_id, plugin_id, entity_key)` 唯一；指向当前 revision |
| `entity_current_state` | 每实体的最新值/质量/告警（热读不扫历史） |
| `entity_history` | 追加式历史；每行记录 `descriptor_revision_id`，旧数据永不用新语义重解释 |
| `plugin_events` | durable 事件队列：`pending → leased → failed(retry)/completed/dead` |
| `devices`（新列） | `plugin_installation_id / plugin_id / profile_id / profile_version / profile_configuration`，三者要么全 NULL（内置 generic）要么全设 |

CHECK 约束按仓库惯例以原始 SQL 附在迁移内（state 枚举、attempt 非负、profile 列一致性等）。
`devices.plugin_id` 与 installation 的跨表一致性在服务层校验。

**顺带修复的 schema 漂移**：迁移 `20260813020000` 创建的日志导出 keyset 索引
`raw_log_events_device_time_id_idx` 此前没有回写到 schema.prisma，任何后续
`migrate dev` 都会把它静默删掉。已补回 schema 并在测试数据库上恢复。

**第二个迁移 `20260821050000_plugin_event_binding_snapshots`**：

- `plugin_events` 新增路由快照列（`project_id / device_uid / plugin_id /
  plugin_version / profile_id / profile_version / installation_config`），入队时
  冻结——pending 事件不因后续改绑或配置变更而改变执行语义；
- 幂等唯一从全局 `(idempotency_key)` 收紧为按设备的部分唯一索引
  `(device_id, idempotency_key) WHERE idempotency_key IS NOT NULL`：不同设备使用
  相同的序列号类 key 不再互相冲突；
- `entity_descriptor_revisions` 身份加入 `profile_version`；
- 删除 `plugin_installations(project_id, plugin_id)` 唯一约束——§3 允许同一项目
  配置多个 installation，installation id 才是身份。

## Plugin SDK（`packages/plugin-sdk`）

| 文件 | 职责 |
| --- | --- |
| `types.ts` | manifest / profile / `EntityDescriptor` / `EntityUpdate` / action wire encoder / `PluginContext` / versioned Station workflow/job/step/capability/snapshot 接口 / worker 接口 |
| `validation.ts` | 纯校验器：manifest zod schema（注册期 fail-fast）、entity 值类型/枚举/base64/大小上限、`validateEventUpdates`（updates 数量、未声明 entity、重复 key、ISO 时间戳、序列化字节上限）、Station workflow/capability/job/progress/completion 边界校验 |
| `../plugin-rpc-contract/` | oRPC/WebSocket 双向契约、握手、作用域和有界值规则 |
| `define.ts` | `definePlugin()`：manifest 在模块加载时校验；manifest 与 worker 刻意分离定义 |

关键设计：校验器在**两侧**运行——host 用它快速拒绝自己的错误输出，dispatcher
用它做提交前的权威复检。SDK 不导入 Prisma/DB/API 任何东西，插件进程只有这个
包也没有凭据可滥用。

分层上限（§15）：每值 64KB JSON / binary 64KB / 每事件 100 条 update /
事件 payload 256KB / WebSocket frame 1MB（可配）。

## 插件（`plugins/`，workspace 包）

注册表导出**两个 map**，导入规则由注释和 tsconfig 约束：

- `pluginManifests` —— 纯元数据，仅 dispatcher/API 等可信进程导入；
- `pluginWorkers` —— 运行时实现，**只有** plugin-host 进程允许导入。

`generic-device`：内置 profile 的标记性插件，worker 为 no-op；无绑定设备在
读取侧（`resolveDeviceBinding`）映射到这里，既有协议行为零变化。

`chaos-test`：按 event kind 选择故障模式——`ok`（正常）、`updates`（回显任意
updates，用于校验失败测试）、`fail`（抛错，可重试）、`crash`/`hang`/`oom`（仅手动
混沌场景，不在容器化 CI 进程内执行）、`huge`（超 descriptor 值上限）、`bulky`（合法但
巨大的响应，触发 WebSocket frame 上限路径）、`slow`（可中断的慢响应）。

## Core 服务层（`packages/core/src/plugins/`）

| 文件 | 职责 |
| --- | --- |
| `errors.ts` | `PluginSystemError`（带 `kind` 判别器，同 CommandQueueError 惯例） |
| `installation.ts` | `createInstallation`（版本精确匹配）、`bindDeviceToInstallation`（**必须传入部署 manifest**：校验 plugin 归属与 profile 声明，绑定 UPDATE 与实体注册同事务）、`reconcileInstallationDevices`（升级 reconcile：canonical 变化建新 revision、移除 key 标 deprecated、版本不匹配拒绝）、`resolveDeviceBinding`（无绑定 → 内置 generic） |
| `entity.ts` | `ensureEntityDescriptors`（幂等、canonical 比较）、`registerDeviceEntities`、`applyEntityUpdate`（防御性复检 + upsert 当前状态 + 按 history 策略追加历史）、`getDeviceEntityStates` / `getDeviceEntityHistory`（keyset 分页） |
| `events-queue.ts` | `enqueuePluginEvent`（路由由绑定推导；幂等 key；payload 上限；非 enabled 拒绝）、`leaseNextPluginEvent`（单 installation FIFO + `FOR UPDATE SKIP LOCKED`）、`completePluginEvent`（完成与副作用同事务）、`failPluginEvent`（瞬时退避/永久 dead）、`recoverExpiredPluginEventLeases`（租约恢复并消耗 attempt）、`listInstallationsWithWork`、`sweepInstallationVersions` |

History 策略：`none` 不记历史；`changes` 值/质量/告警指纹任一变化才记；
`sampled` 变化立即记、否则按 `sampleIntervalSeconds` 限频；`all` 全记。

通知通道：`soulcloud_plugin_events`（入队事务内 `pg_notify`，有损唤醒；
轮询兜底正确性——与命令队列同一契约）。

## Plugin Host（`packages/plugin-host`）

入口：`bun packages/plugin-host/src/index.ts --plugin <id> --port <n>`；生产环境通常
通过 `PLUGIN_ID`、`PLUGIN_HOST_PORT`、`PLUGIN_HOST_BIND` 和可选的
`PLUGIN_HOST_AUTH_TOKEN` 环境变量配置。

- oRPC/WebSocket 服务端，每容器一个插件；`GET /health` 供容器编排器探活，`GET /rpc/ws`
  承载双向、双 prefix 的 RPC 请求/响应。
- `host.handshake`：返回 rpcVersion/pluginId/pluginVersion/apiVersion，供
  dispatcher 校验路由正确性。
- `plugin.handleEvent`：deadline 派生 `AbortSignal` 传给 worker；handler 并发
  上限，超出拒绝 `overloaded`（可重试瞬时错误）。
- 输出预检：updates 未通过 `validateEventUpdates` 或 WebSocket 响应超过大小上限 →
  `invalid_params` / `response_too_large`（永久错误），不跨线传输。
- 插件日志以每次响应中的有界 `logs` 数组回传（带 pluginId/installationId/projectId/
  operationId 标签，§6.4），同时镜像到 stdout 供容器日志系统采集。
- 进程内没有数据库连接、用户 JWT 或全局 secret；`PluginContext` 的 scoped
  服务（devices/commands/entities/stationJobs）声明于 SDK 但调用会显式报
  not-implemented——它们依赖阶段 3+ 的反向 RPC 通道。

## Plugin Dispatcher（`packages/plugin-dispatcher`）

入口进程 + 可嵌入核心（`startDispatcher`，测试直接构造）。

**监督**（`supervisor.ts`）：按需创建 WebSocket client、连接并握手；请求失败记录到
快速失败熔断器，超时只使本地 client 失效。Dispatcher 不 spawn、SIGKILL 或重启远端
进程；容器编排器通过资源限制和 restart 策略负责容器生命周期。plain Compose 只会把
失败的 healthcheck 标为 unhealthy，因此 Host entrypoint 另有一个不持有 Docker 权限的
liveness supervisor，在 event loop 同步卡死时终止并重启 Host 子进程；Kubernetes 等
编排器仍应配置真正的 liveness restart policy。

**调度**（`dispatcher.ts`）：

- 每 tick 取有活干的 installation 列表，round-robin 轮转起点，per-installation
  并发上限 + 全局 in-flight 上限（§6.4 公平性：一个工厂的洪峰不饿死另一个）。
- 路由校验：event kind 必须由该插件 manifest 针对该 profile 声明；
  version 漂移的 installation 直接跳过（等 sweep 标 error）。
- RPC 错误分类：`deadline_exceeded` → 失效本地 client + 可重试；
  `invalid_params`/`response_too_large` → 永久 dead-letter；`overloaded`/
  `handler_error`/连接丢失 → 可重试。提交阶段 entity registry 拒绝输出
  （`unknown_entity` / `invalid_entity_update`）同样永久 dead-letter 并保留精确
  原因——这类失败对同一事件是确定性的，重试只会烧 attempt。退避 = 指数 +
  25% jitter，attempt 上限后 dead-letter 并保留 `last_error`。
- 提交：`completePluginEvent` 在**同一事务**内更新事件状态并应用全部 entity
  更新（副作用持久化是完成的一部分）。
- 每安装熔断器为**时间戳式**：`open` 是纯判断（冷却期内 true），求值无副作用，
  冷却结束即恢复放行；仍坏的 host 会在 `threshold` 次连续失败后再次开闸，探测
  窗口因此有界。租约恢复和版本漂移由周期 sweep 负责；`LISTEN/NOTIFY` 仅作唤醒。

配置全部环境变量化（`PLUGIN_*`，见 `.env.example`），含一个启动期断言：
`PLUGIN_EVENT_TIMEOUT_MS` 必须小于租约时长（租约必须活得比一次尝试久）。

## 部署

- `Dockerfile.backend` 新增 `plugin-dispatcher` 和 `plugin-host` targets（与 api/broker 共享 base）。
- `compose.yaml` 新增独立的 `plugin-dispatcher` 与 `plugin-host-generic` 服务；Dispatcher
  通过 `PLUGIN_HOST_ENDPOINTS` 访问容器网络 WebSocket URL。每个 Host 只加入自己的 internal 网络，
  不加入 API/DB 网络；Host 使用非 root 用户、只读根文件系统、独立的 memory/CPU/PID
  上限和 `no-new-privileges`，并由 liveness supervisor 处理 plain Compose 下的同步挂死。
  全程不需要共享 socket volume 或 Docker socket。
- `bun run dev:dispatcher` 加入根 dev 脚本。

## 测试

| 套件 | 文件 | 覆盖 |
| --- | --- | --- |
| SDK 单元 | `plugin-sdk/tests/validation.test.ts` | manifest、workflow、station capability/job、entity 值校验 |
| Entity 集成 | `core/tests/plugins/entity.test.ts` | revision 幂等/演进、四种 history 策略、keyset 分页、非法值拒绝 |
| 事件队列集成 | `core/tests/plugins/events-queue.test.ts` | 绑定解析、幂等 key、租约 FIFO、退避/dead-letter、租约恢复、版本漂移 sweep、绑定校验（错误插件/未声明 profile 拒绝、同事务实体注册）、reconcile（漂移热修建新 revision + 弃用移除 key + 旧 revision 存活、版本不匹配拒绝、缺失 profile 只上报） |
| 熔断器单元 | `plugin-dispatcher/tests/breaker.test.ts` | 阈值开闸、冷却期阻断、**冷却后无 dispatch 的重复求值仍放行（H1 回归，假时钟确定性）**、冷却后继续失败再开闸、success 复位 |
| Host 单元 | `plugin-host/tests/server.test.ts` | WebSocket health、认证、连接上限；业务契约由 oRPC 集成测试覆盖 |
| Dispatcher 集成 | `plugin-dispatcher/tests/dispatcher.test.ts` | WebSocket Host：健康事件、handler 错误重试、请求 deadline、超大输出永久 dead、未声明事件路由拒绝、**跨 installation 公平性**、**慢请求时命令队列照常工作**、registry 漂移 1 次尝试死信（H2 回归）、熔断器空转冷却后恢复放行（H1 集成回归） |

`crash`/死循环/`oom` 需要在独立容器环境做手动混沌测试；常规 CI 使用 WebSocket Host
测试服务验证超大响应、超时和错误隔离，避免测试进程被故意退出或死循环拖住。

## 评审修复记录（2026-08-21）

阶段 1/2 评审发现并已修复的两个问题：

**H1 熔断器 half-open 卡死（liveness）**：原实现 `open` getter 带副作用——冷却结束
后的第一次求值就消耗唯一的试探名额；若此刻队列恰好为空（例如全部事件在退避期），
名额无人复位，该 installation 的队列永久停摆直到进程重启。修复为时间戳式熔断器：
`open` 是纯判断，冷却到期即放行，仍坏的 host 由 `threshold` 次连续失败再次开闸。
单元测试用注入时钟做确定性回归；集成测试复现"开闸 → 队列空转越过冷却 → 新事件
完成"的完整时序。

**H2 manifest 与 DB descriptor 双源真相 + 无 reconcile 路径**：原实现中
`bindDeviceToInstallation` 不校验 profile 是否存在于 manifest、也不注册实体，
`registerDeviceEntities` 只有测试调用——一旦漂移，dispatcher 按 manifest 放行、
DB 侧抛 `unknown_entity`，被归为可重试后烧完 attempt 才 dead-letter。修复分三层：

1. 绑定必须传入部署 manifest：校验 plugin 归属与 profile 声明，绑定 UPDATE 与
   实体注册在同一事务内完成；
2. 新增 `reconcileInstallationDevices` 作为升级迁移的服务原语（版本钉死、新
   revision、弃用移除 key、缺失 profile 上报），阶段 3 的 installation 迁移 API
   应调用它；
3. dispatcher 把提交阶段的 `unknown_entity` / `invalid_entity_update` 归类为永久
   dead-letter 并保留精确原因。

## 刻意未做（后续阶段）

- Broker `/event` 上行 envelope 接入（阶段 5；事件队列与路由已就绪，只差
  dispatch 挂钩）。
- Station Agent 运行时、Station API、Artifact Service、provisioning identity（阶段 4+）。
- Station workflow/job/step/capability/version-snapshot 的 SDK 契约已定义并校验；
  `stationJobs.create()` 在阶段 4 服务落地前保持显式 not-implemented。
- 插件 UI / iframe 隔离（阶段 3）。
- 跨节点 RPC 传输（v2；协议已与传输解耦）。

### 已知待办（评审发现，本阶段不处理）

- worker 导入隔离仅靠注释/tsconfig 约定：`@soulcloud/plugins` 单入口同时导出
  manifests 与 worker loaders，建议拆 package exports 子路径或加 lint 规则；
- `applyEntityUpdate` 每 update 最多 5 条 SQL（100 updates/事件单事务可达 ~500
  查询），sampled 策略用应用侧 `Date.now()` 对比 DB `ingested_at`，存在 N+1 与
  时钟混用；
- 终态数据无清理 job：`plugin_events` completed/dead 行与 `entity_history` 无限
  累积（§4 retention job 未实现）；
- `staleAfterSeconds` 已声明但读取侧不做 stale 推导；descriptor revision 的
  `deprecated` 标志读取侧未消费（registry 行的弃用已由 reconcile 写入）；
- `getDeviceEntityHistory` 仅支持升序 keyset，无法高效取最新一页；
- host 在执行 worker 之后才查找 profile，且 profile 缺失返回 `internal_error`
  （被 dispatcher 归为可重试）。
