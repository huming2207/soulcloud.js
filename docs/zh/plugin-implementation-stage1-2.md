# 插件系统实施记录（阶段 1 + 阶段 2）

> 本文档记录 `plugin-and-station-architecture.md` 中阶段 1（架构与 SDK 骨架）和
> 阶段 2（容器化插件隔离原型）的落地实现。设计动机和完整背景见该提案文档。

**日期**：2026-08-21 · **基线**：698 个后端非 E2E 测试全绿（新增插件测试）、
`tsc --noEmit` 干净、`docker compose config` 校验通过。

## 概览

新增两个可部署角色、一个共享 SDK、一个插件 workspace 包：

```
packages/
  plugin-sdk/          # 共享契约：类型 + 纯校验器 + HTTP JSON-RPC 消息（无 DB、无 secret）
  plugin-host/         # 不可信侧容器：每容器一个插件，HTTP JSON-RPC 服务端
  plugin-dispatcher/   # 可信进程：租约事件、HTTP client、公平调度、权威校验
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
  → 容器网络 HTTP JSON-RPC → plugin-host → 插件 worker
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

## Plugin SDK（`packages/plugin-sdk`）

| 文件 | 职责 |
| --- | --- |
| `types.ts` | manifest / profile / `EntityDescriptor` / `EntityUpdate` / action wire encoder / `PluginContext` / worker 接口 |
| `validation.ts` | 纯校验器：manifest zod schema（注册期 fail-fast）、entity 值类型/枚举/base64/大小上限、`validateEventUpdates`（updates 数量、未声明 entity、重复 key、ISO 时间戳、序列化字节上限） |
| `rpc.ts` | 标准 HTTP JSON-RPC 请求/响应消息类型；握手、`plugin.handleEvent` 和有界日志结果 |
| `define.ts` | `definePlugin()`：manifest 在模块加载时校验；manifest 与 worker 刻意分离定义 |

关键设计：校验器在**两侧**运行——host 用它快速拒绝自己的错误输出，dispatcher
用它做提交前的权威复检。SDK 不导入 Prisma/DB/API 任何东西，插件进程只有这个
包也没有凭据可滥用。

分层上限（§15）：每值 64KB JSON / binary 64KB / 每事件 100 条 update /
事件 payload 256KB / HTTP JSON-RPC body 1MB（可配）。

## 插件（`plugins/`，workspace 包）

注册表导出**两个 map**，导入规则由注释和 tsconfig 约束：

- `pluginManifests` —— 纯元数据，仅 dispatcher/API 等可信进程导入；
- `pluginWorkers` —— 运行时实现，**只有** plugin-host 进程允许导入。

`generic-device`：内置 profile 的标记性插件，worker 为 no-op；无绑定设备在
读取侧（`resolveDeviceBinding`）映射到这里，既有协议行为零变化。

`chaos-test`：按 event kind 选择故障模式——`ok`（正常）、`updates`（回显任意
updates，用于校验失败测试）、`fail`（抛错，可重试）、`crash`/`hang`/`oom`（仅手动
混沌场景，不在容器化 CI 进程内执行）、`huge`（超 descriptor 值上限）、`bulky`（合法但
巨大的响应，触发 HTTP 响应上限路径）、`slow`（可中断的慢响应）。

## Core 服务层（`packages/core/src/plugins/`）

| 文件 | 职责 |
| --- | --- |
| `errors.ts` | `PluginSystemError`（带 `kind` 判别器，同 CommandQueueError 惯例） |
| `installation.ts` | `createInstallation`（版本精确匹配）、`bindDeviceToInstallation`（项目归属校验）、`resolveDeviceBinding`（无绑定 → 内置 generic） |
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

- HTTP JSON-RPC 服务端，每容器一个插件；`GET /health` 供容器编排器探活，`POST /rpc`
  承载标准 JSON 请求/响应。
- `host.handshake`：返回 rpcVersion/pluginId/pluginVersion/apiVersion，供
  dispatcher 校验路由正确性。
- `plugin.handleEvent`：deadline 派生 `AbortSignal` 传给 worker；handler 并发
  上限，超出拒绝 `overloaded`（可重试瞬时错误）。
- 输出预检：updates 未通过 `validateEventUpdates` 或 HTTP 响应超过大小上限 →
  `invalid_params` / `response_too_large`（永久错误），不跨线传输。
- 插件日志以每次响应中的有界 `logs` 数组回传（带 pluginId/installationId/projectId/
  operationId 标签，§6.4），同时镜像到 stdout 供容器日志系统采集。
- 进程内没有数据库连接、用户 JWT 或全局 secret；`PluginContext` 的 scoped
  服务（devices/commands/entities/jobs）声明于 SDK 但调用会显式报
  not-implemented——它们依赖阶段 3+ 的反向 RPC 通道。

## Plugin Dispatcher（`packages/plugin-dispatcher`）

入口进程 + 可嵌入核心（`startDispatcher`，测试直接构造）。

**监督**（`supervisor.ts`）：按需创建 HTTP client、连接并握手；请求失败记录到
快速失败熔断器，超时只使本地 client 失效。Dispatcher 不 spawn、SIGKILL 或重启远端
进程；容器编排器通过 `healthcheck`、内存限制和 `restart` 策略负责 Host 生命周期。

**调度**（`dispatcher.ts`）：

- 每 tick 取有活干的 installation 列表，round-robin 轮转起点，per-installation
  并发上限 + 全局 in-flight 上限（§6.4 公平性：一个工厂的洪峰不饿死另一个）。
- 路由校验：event kind 必须由该插件 manifest 针对该 profile 声明；
  version 漂移的 installation 直接跳过（等 sweep 标 error）。
- RPC 错误分类：`deadline_exceeded` → 失效本地 client + 可重试；
  `invalid_params`/`response_too_large` → 永久 dead-letter；`overloaded`/
  `handler_error`/连接丢失 → 可重试。退避 = 指数 + 25% jitter，attempt 上限
  后 dead-letter 并保留 `last_error`。
- 提交：`completePluginEvent` 在**同一事务**内更新事件状态并应用全部 entity
  更新（副作用持久化是完成的一部分）。
- 每安装熔断器（连续失败阈值 + 冷却），租约恢复和版本漂移由周期 sweep
  负责；`LISTEN/NOTIFY` 仅作唤醒。

配置全部环境变量化（`PLUGIN_*`，见 `.env.example`），含一个启动期断言：
`PLUGIN_EVENT_TIMEOUT_MS` 必须小于租约时长（租约必须活得比一次尝试久）。

## 部署

- `Dockerfile.backend` 新增 `plugin-dispatcher` 和 `plugin-host` targets（与 api/broker 共享 base）。
- `compose.yaml` 新增独立的 `plugin-dispatcher` 与 `plugin-host-generic` 服务；Dispatcher
  通过 `PLUGIN_HOST_URLS` 访问容器网络 URL，Host 通过 `mem_limit`、`healthcheck` 和
  `restart` 由 Compose 管理，不需要共享 socket volume。
- `bun run dev:dispatcher` 加入根 dev 脚本。

## 测试

| 套件 | 文件 | 覆盖 |
| --- | --- | --- |
| SDK 单元 | `plugin-sdk/tests/validation.test.ts` | manifest 规则、entity 值校验、JSON-RPC 消息可序列化 |
| Entity 集成 | `core/tests/plugins/entity.test.ts` | revision 幂等/演进、四种 history 策略、keyset 分页、非法值拒绝 |
| 事件队列集成 | `core/tests/plugins/events-queue.test.ts` | 绑定解析、幂等 key、租约 FIFO、退避/dead-letter、租约恢复、版本漂移 sweep |
| Host 单元 | `plugin-host/tests/server.test.ts` | HTTP health/握手、认证、错误分类、输出预检、响应上限 |
| Dispatcher 集成 | `plugin-dispatcher/tests/dispatcher.test.ts` | HTTP Host：健康事件、handler 错误重试、请求 deadline、超大输出永久 dead、未声明事件路由拒绝、**跨 installation 公平性**、**慢请求时命令队列照常工作** |

`crash`/死循环/`oom` 需要在独立容器环境做手动混沌测试；常规 CI 使用 HTTP Host
测试服务验证超大响应、超时和错误隔离，避免测试进程被故意退出或死循环拖住。

## 刻意未做（后续阶段）

- Broker `/event` 上行 envelope 接入（阶段 5；事件队列与路由已就绪，只差
  dispatch 挂钩）。
- Action → 现有 command queue 的 encoder 路径与 REST API（阶段 3）。
- Station 协议、Artifact Service、provisioning identity（阶段 4+）。
- 插件 UI / iframe 隔离（阶段 3）。
- 跨节点 RPC 传输（v2；协议已与传输解耦）。
