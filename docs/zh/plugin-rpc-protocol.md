# Plugin Dispatcher ↔ Plugin Host 双向 RPC 协议与实施计划

**状态**：设计已确认；oRPC/WebSocket、共享契约、operation scope 和基础治理已实施，仍保留 HTTP MessagePack 兼容路径

**日期**：2026-08-22

**目标运行时**：Bun 1.4

**目标 RPC 框架**：oRPC v2（实施时锁定精确版本）

本文规定 SoulcloudJS 中可信的 Plugin Dispatcher 与隔离的 Plugin Host 之间的下一代
RPC 协议、信任边界、资源限制、失败语义和迁移步骤。它取代的是当前容器网络上的
HTTP MessagePack-RPC；在迁移完成以前，现有实现仍是运行基线。

本文中的“插件可信”只表示插件由己方团队编写，不表示插件不会崩溃、死循环、泄漏资源、
错误处理输入或被外部数据触发 DoS。所有限制均为协议要求，不能因为代码来自内部团队而省略。

## 1. 决策摘要

目标方案为：

- Dispatcher 与每个 Plugin Host 之间建立一条长期 WebSocket。
- 同一条 WebSocket 上运行两套方向相反的 oRPC v2 peer。
- 两个方向使用不同 message prefix，避免 request/response 串线。
- RPC 使用 oRPC 默认 JSON serializer；BigInt、Blob 等按 oRPC 支持的类型传输。
- 插件 SDK 中的 `Uint8Array` 在 RPC 边界显式转换为有界 Blob，接收侧再恢复并权威校验。
- 反向调用使用短生命周期 operation capability，绑定当前 installation/project/device/event。
- command/job 等副作用先暂存在 operation 中，只有正向调用成功后才与 event completion
  在同一数据库事务提交。
- 本地和容器内默认使用 `ws://`；配置与代码同时允许将来使用 `wss://`。
- oRPC 只负责 transport、procedure routing、类型契约、取消和流式能力；认证、资源治理、
  operation scope、业务校验、事务和熔断仍由 Soulcloud 实现。

明确不在本次迁移范围内：

- 设备 MQTT payload、DeviceCommand、DeviceCommandResult 继续使用 MessagePack。
- 设备 REST/MQTT API 不因 Plugin RPC 改变 wire format。
- 数据库中已经保存的 MessagePack payload 不迁移。
- on9log 和设备日志打包协议不改变。
- firmware、ELF、日志包等 artifact 正文不通过 Plugin RPC 传输。
- 不引入运行时插件安装，也不改变每插件独立容器的隔离模型。

## 2. 为什么选择 oRPC v2 + WebSocket

一旦 RPC 需要真正双向调用，自研协议必须正确处理：并发 request、response routing、取消、
断线清理、流式传输、类型契约和错误传播。oRPC 已覆盖这些通用问题，Soulcloud 只保留与自身
业务和信任边界有关的部分。

默认 JSON 的 wire size 通常大于 MessagePack，但 Plugin RPC 主要运行在本机或内部容器网络，
典型消息只有数百字节到数 KB。Bun/JavaScriptCore 对 JSON parse/stringify 有成熟优化；实际
延迟通常由插件执行、PostgreSQL 和业务校验主导。迁移验收仍必须用 Soulcloud 的真实 payload
测量吞吐、p50/p99、CPU 和 RSS，不能用裸 JSON benchmark 代替 oRPC 端到端结果。

采用 oRPC 不等于信任它的默认值。Bun WebSocket 的原始帧限制、发送背压、Blob 限制、
handshake、业务输出复检和 circuit breaker 分类都必须显式实现。

## 3. 进程和连接拓扑

Dispatcher 主动连接 Host；Host 不需要反向拨号到 Dispatcher：

```text
Plugin Dispatcher                         Plugin Host
┌────────────────────┐                   ┌────────────────────┐
│ d2h RPCLink        │── prefix d2h ───>│ d2h RPCHandler     │
│ h2d RPCHandler     │<─ prefix h2d ────│ h2d RPCLink        │
│ OperationRegistry  │                   │ PluginContext      │
│ PostgreSQL/Core    │                   │ Plugin worker      │
└────────────────────┘                   └────────────────────┘
                 一条物理 WebSocket
```

建议固定逻辑 prefix：

```text
soulcloud:d2h:v1:    Dispatcher → Host
soulcloud:h2d:v1:    Host → Dispatcher
```

prefix 是 framing namespace，不是业务 API version。业务兼容性由 handshake 中的
`rpcProtocolVersion`、plugin API version 和 capability 集合决定。

每个 Dispatcher replica 对每个配置的 Host endpoint 维护自己的连接。Host 可以同时接受多个
Dispatcher 连接；反向调用必须沿收到父调用的同一条 WebSocket 返回，因此不会发往错误的
Dispatcher replica。

## 4. Transport 与端点

Host 保留普通 HTTP health endpoint，并新增 WebSocket upgrade endpoint：

```text
GET /health       容器 liveness/readiness
GET /rpc/ws       WebSocket upgrade
```

开发和单机容器默认地址示例：

```text
ws://plugin-host-generic:8090/rpc/ws
```

跨主机环境可以配置：

```text
wss://plugin-host-generic.internal/rpc/ws
```

TLS 不是应用协议的一部分；本地/internal network 可以不启用，跨不可信网络时由 ingress、
service mesh 或 Host 本身终止 TLS。实现不得假设 URL 一定是 `ws://`。

### 4.1 Upgrade 认证

Dispatcher 使用 Bun WebSocket client 的自定义 header 发送：

```http
Authorization: Bearer <PLUGIN_HOST_AUTH_TOKEN>
X-Soulcloud-RPC-Protocol: 1
```

Host 在 `server.upgrade()` 前完成：

1. path 和 method 检查；
2. bearer token 检查；
3. protocol header 检查；
4. 当前连接数和按来源连接数限制；
5. 将“尚未完成业务 handshake”的 connection state 放入 `ws.data`；
6. 最后才执行 upgrade。

token、upgrade headers 和完整 URL 不得进入日志。生产 token 必须来自 secret store 或环境变量。

### 4.2 Bun WebSocket 硬限制

Host 的 `Bun.serve()` 至少配置：

```ts
websocket: {
  maxPayloadLength: configuredMaxFrameBytes,
  backpressureLimit: configuredBackpressureBytes,
  closeOnBackpressureLimit: true,
  idleTimeout: configuredIdleTimeoutSeconds,
}
```

原始 frame 必须在进入 oRPC decoder 前受到 `maxPayloadLength` 限制。应用层的 schema/Blob
限制不能代替这一层，因为解析前内存已经分配。

WebSocket compression 第一版默认关闭。控制消息通常很小，压缩会增加 CPU、内存和复杂性；
只有真实 benchmark 证明有收益时才允许由配置开启。

## 5. 双向 oRPC 组合

共享契约包当前实现为 `packages/plugin-rpc-contract/src/index.ts`；后续可按职责拆分为：

```text
packages/plugin-rpc-contract/
  src/host-contract.ts
  src/scoped-service-contract.ts
  src/schemas.ts
  src/errors.ts
  src/binary.ts
```

依赖方向必须保持：

```text
plugin-rpc-contract ← plugin-dispatcher
plugin-rpc-contract ← plugin-host
```

Plugin Host 不得 import Dispatcher router implementation；Dispatcher 也不得 import Host worker
implementation。契约包不得 import Prisma、数据库连接、API authentication 或部署 secret。

### 5.1 Dispatcher → Host contract

第一版 procedure：

```text
system.handshake
system.ping
plugin.handleEvent
action.encode
```

`system.handshake` 必须在连接上的任何业务 procedure 之前完成。建议返回：

```ts
interface HostHandshakeResult {
  rpcProtocolVersion: 1;
  pluginId: string;
  pluginVersion: string;
  pluginApiVersion: number;
  capabilities: {
    reverseRpcVersion: 1;
    scopedServices: string[];
    blob: boolean;
  };
}
```

Dispatcher 必须与编译期 manifest 和配置的 Host endpoint 逐项比对。任何 plugin ID/version、
plugin API version 或 RPC protocol 不匹配都关闭连接，不进入业务调度。

### 5.2 Host → Dispatcher contract

第一版 procedure：

```text
context.entities.get
context.commands.enqueue
```

本地可以完成的方法不得产生 RPC：

- `devices.getDeviceUid()` 直接读取当前 event 中的 device snapshot；
- installation config 已随 `PluginContext` 提供；
- logger 继续使用有界 per-operation buffer；
- `AbortSignal` 来自父调用 deadline。

`jobs.createJob()` 在通用 plugin job model、station routing 和幂等语义确定前保持显式
not-implemented，不用 `Record<string, unknown>` 草率落库。

## 6. Bun ServerWebSocket bridge

Dispatcher 使用普通 Bun `WebSocket`，可以直接交给 oRPC v2 `RPCLink`。Host 收到的是 Bun
`ServerWebSocket`，而 oRPC client transport 需要 EventTarget 风格接口。因此实现一个最薄的
bridge：

```text
packages/plugin-host/src/rpc/bun-server-websocket-bridge.ts
```

bridge 只负责：

- `send()`；
- `readyState`；
- 注册/移除 open、message、close listener；
- 把 Bun `message/close/drain` callback 转发给 listener；
- 对发送字节和 backpressure 做硬限制。

bridge 不得复制或重写 oRPC 的 request ID、response queue、serializer、cancel protocol 或
reconnect state machine。代码只能依赖 oRPC 的公开 API，不直接 import
`@standardserver/peer`。

同一个 Bun `message` callback 将 frame 交给两个逻辑方向；各自的 prefix decoder 只处理
匹配的 frame。未匹配两个 prefix 的 frame 计为 protocol violation，达到阈值后关闭连接。

## 7. Operation capability 与作用域

oRPC 只提供 transport identity，不知道 installation/project/device scope。每次
`plugin.handleEvent` 前，Dispatcher 创建不可猜测、短生命周期的 operation token：

```ts
interface ActivePluginOperation {
  token: string; // 256-bit random, base64url
  connectionId: string;
  pluginId: string;
  pluginVersion: string;
  installationId: string;
  projectId: string;
  deviceId: string;
  eventId: string;
  deadlineMonotonicMs: number;
  state: "active" | "sealed" | "closed";
  activeReverseCalls: number;
  totalReverseCalls: number;
  stagedCommands: StagedCommand[];
}
```

token 随正向输入发送给 Host，但不得暴露给 plugin worker。Host 创建 `PluginContext` 时，将它
封装在 scoped client closure 中。插件调用：

```ts
await ctx.entities.get("temperature");
```

Host 的 h2d RPCLink interceptor 自动附加：

```http
X-Soulcloud-Operation: <opaque-token>
```

Dispatcher reverse middleware 按以下顺序检查：

1. 当前 WebSocket 已完成 handshake；
2. token 存在；
3. token 的 `connectionId` 与当前连接一致；
4. token 的 `pluginId/version` 与连接身份一致；
5. operation 仍为 `active`；
6. operation 未超过 monotonic deadline；
7. method 在该 operation 允许的 scoped service 集合中；
8. 并发、调用次数和 effect 数量未超过上限。

reverse procedure 不接受 `projectId`、`installationId` 或 `deviceId`。这些字段只能从
`ActivePluginOperation` 取得，从协议结构上消除跨 project/device 寻址能力。

OperationRegistry 必须有严格容量上限；正常上限不应超过 Dispatcher 的全局 in-flight event
上限。operation 在 success、error、timeout、socket close 和 shutdown 的所有路径都必须从
registry 删除。

## 8. Scoped service 语义

### 8.1 `context.entities.get`

输入仅包含：

```ts
{ entityKey: string }
```

Dispatcher 权威检查：

- device 仍属于 operation 中的 installation/project；
- entity 属于该 plugin/profile revision；
- entity 未 deprecated；
- entity key、返回 value、quality、alarm 和 timestamp 均通过 schema；
- 返回值和其中的 binary 数据不超过限制。

读取语义为“当前事件提交前的数据库 snapshot”。本次 `handleEvent` 返回但尚未提交的 updates
不可见，不提供 read-your-own-write。

### 8.2 `context.commands.enqueue`

输入只包含 command name 和 arguments，不包含 target device。target 固定为 operation 的
`deviceId`。

返回成功的语义是：

> Dispatcher 已验证并把 command intent 暂存到当前 operation；只有父调用成功且最终数据库
> 事务提交后，command 才真正进入 durable command queue。

它不表示 command 已持久化，也不表示设备已经收到 command。

Dispatcher 必须使用核心 `DeviceCommandSchema` 做权威验证，并限制 command 数量、argument
数量、字符串长度、嵌套深度、Blob 数量和总字节。Host 可以预检，但不能代替 Dispatcher。

## 9. Staged effects 与事务

反向 RPC 不得立即提交 command/job 等副作用。否则插件在 enqueue 后抛错、Host response 丢失
或 event 重试时会留下幽灵或重复副作用。

正确时序：

```text
lease event
  → create operation
  → call plugin.handleEvent
  → zero or more reverse calls
  → receive final PluginEventResult
  → seal operation（拒绝新 reverse call）
  → verify activeReverseCalls == 0
  → BEGIN
       re-check event lease/state
       apply entity updates
       enqueue staged commands
       create staged jobs（未来）
       mark event completed
    COMMIT
  → close operation
```

现有 `enqueueBatchInTransaction()` 应被复用，而不是创建独立 command transaction。

如果 Host 已返回但仍有未 await 的 reverse call：

1. operation 立即进入 `sealed`；
2. 新调用返回 `operation_closed`；
3. 在父 deadline 内给已进入的调用一个很短的 drain 窗口；
4. 仍未结束则 abort，整个 event attempt 失败；
5. 不提交任何 staged effect。

这会把 `void ctx.commands.enqueueCommand(...)` 一类插件 bug 转化为可见失败，而不是不确定副作用。

## 10. Binary、Blob 与 artifact

当前 plugin SDK 的 `CommandArgument` 和 binary entity value 使用 `Uint8Array`，而 oRPC 默认
原生支持 Blob/File，不保证把任意嵌套 `Uint8Array` 恢复成原类型。RPC 边界必须显式转换：

```text
plugin-facing Uint8Array
  → Host wire adapter: Blob
  → oRPC WebSocket framing
  → Dispatcher wire adapter: bounded Uint8Array
  → authoritative core schema validation
```

禁止把 `Uint8Array` 直接交给 JSON serializer，避免它退化为带数字 key 的普通 object。

每条消息至少限制：

- Blob 数量；
- 单 Blob 字节数；
- 所有 Blob 总字节数；
- object 最大深度和节点数；
- array/map 最大元素数；
- string 总字节数；
- 恢复 Uint8Array 后的业务 payload 大小。

Blob walker 必须能检测循环引用并在固定节点数后停止。File 的 name/type 只视为非可信 metadata，
不得用作路径或权限判断。

第一版禁止在 oRPC `AsyncIteratorObject` 中携带 Blob/File。artifact 继续只传 ID、hash、受限 URL
或其他引用；RPC 不提供固件/ELF 大文件上传、断点续传或对象存储替代品。

## 11. Deadline、取消和断线

每个父调用具有 Dispatcher 决定的绝对 operation deadline。一次 reverse call 的实际预算为：

```text
min(
  operation 剩余时间,
  procedure 默认 timeout,
  deployment 配置上限
)
```

Host 不能通过自报 timeout 延长父 operation。Dispatcher 使用 monotonic clock 管理本进程内
deadline；数据库时间仍用于 durable lease。

取消传播：

- Dispatcher 取消正向调用时，Host 的 procedure `AbortSignal` 必须触发；
- Host context signal 触发后，所有新的 scoped call 立即失败；
- reverse call 自身取消通过 oRPC 传播给 Dispatcher handler；
- socket close 时双方所有 pending calls 立即 reject/abort。

断线不恢复旧 request，也不自动重放：

```text
socket close
  → reject all pending RPC
  → abort active Host handlers
  → close all operations bound to that connection
  → discard staged effects
  → current leased events enter existing retry/backoff path
  → Supervisor reconnects and performs a fresh handshake
```

PostgreSQL event lease 是正确性来源；WebSocket reconnect 只恢复可用性。

## 12. Heartbeat 与 liveness

保留 `/health` 给 Docker/Kubernetes liveness probe。WebSocket 另有应用层 heartbeat：

- Dispatcher 定期调用 `system.ping`；
- ping 使用短 deadline；
- 只有 handshake 完成的连接才视为 ready；
- 连续失败达到阈值后主动关闭 socket；
- reconnect 使用指数退避、jitter 和最大 backoff；
- heartbeat 不在有正常业务流量时制造高频额外消息。

heartbeat 只判断连接/Host event loop 是否可用，不负责重启或 kill Host。Docker/Kubernetes
继续拥有容器生命周期；Dispatcher 只关闭连接、停止派发并让 durable event retry。

## 13. Backpressure 与资源治理

必须同时限制接收和发送方向。

### 13.1 接收方向

- Bun `maxPayloadLength` 在 decode 前限制原始 frame；
- upgrade 前限制连接数；
- handshake 前只允许 handshake/ping；
- global、per-plugin、per-installation、per-operation 分层并发限制；
- 每 operation 总 reverse call 次数限制；
- 每 operation staged effect 数量/字节限制；
- schema validation 前后都不允许无界数组或对象。

### 13.2 发送方向

Host `ServerWebSocket.send()` 的返回值和 `drain` callback 必须接入 bridge。Dispatcher client
使用 `bufferedAmount` 观察发送积压。必须配置：

- 最大 queued frames；
- 最大 queued bytes；
- 最大 pending RPC；
- Bun `backpressureLimit`；
- `closeOnBackpressureLimit: true`。

不得在 Bun 已经排队的 frame 之外再建立一个无界用户态 queue。超过上限时关闭连接，让 durable
event retry；不能继续 lease 新事件并把数据堆在 heap。

如果一个大 frame 会明显阻塞同连接上的控制请求，应通过业务 frame/Blob 上限拒绝它，而不是在
RPC 层实现任意大对象分片。

## 14. 并发与公平性

已有 Dispatcher 限制继续生效：

- global event in-flight；
- per-installation event concurrency；
- installation round-robin/fair scheduling；
- per-installation circuit breaker。

新增 reverse 限制：

```text
global reverse in-flight
per-plugin reverse in-flight
per-installation reverse in-flight
per-operation reverse in-flight
max calls per operation
max staged effects per operation
```

所有限制必须在分配大型临时结构或读取 Blob 内容前检查。超过并发容量返回可分类的
`RESOURCE_EXHAUSTED`/`callback_overloaded`，不能无限排队等待父 deadline。

## 15. Output validation

oRPC contract 的 TypeScript 类型只提供编译期帮助，Zod output schema 只是第一层运行时检查。
两侧按以下顺序处理：

```text
plugin output
  → Host schema/preflight validation
  → oRPC serialization
  → Dispatcher oRPC output schema
  → Soulcloud authoritative business validation
  → transactional commit
```

Dispatcher 必须继续验证：manifest/profile 声明、entity registry revision、value type、update
数量/字节、command schema、installation/version binding 和所有数据库约束。

Host validator 失败和 Dispatcher 权威复检失败要使用不同错误来源标签，便于定位是插件输出、
wire corruption、版本不匹配还是数据库状态漂移。

## 16. 错误和 circuit breaker 分类

建议将错误分为四类：

| 类别 | 示例 | event 处理 | 计入 Host breaker |
| --- | --- | --- | --- |
| transport/Host fault | connect/handshake 失败、socket close、Host timeout、畸形响应 | retry | 是 |
| transient core fault | DB 暂不可用、reverse overload、临时内部错误 | retry | 否 |
| permanent plugin/data fault | schema 错、未知 entity/action、非法 command、越 scope | dead-letter | 否 |
| operation lifecycle | operation expired/closed、父调用已取消 | 当前 attempt 失败；按根因分类 | 通常否 |

连续几个坏事件不能暂停整个 installation；只有代表 Host/transport 不健康的错误才进入 Host 或
installation circuit breaker。永久输入/插件错误必须保留精确 error code，不得统一包装成
`handler_error`。

建议领域错误码至少包括：

```text
operation_not_found
operation_expired
operation_closed
scope_violation
invalid_entity_key
invalid_command
invalid_action_input
invalid_action_output
effect_limit_exceeded
callback_overloaded
callback_timeout
plugin_unavailable
protocol_violation
```

## 17. 配置建议

名称可在实现时按现有 config 风格调整，但必须全部由 env/sysadmin 决定：

```dotenv
# Transport
PLUGIN_RPC_TRANSPORT=orpc-ws
PLUGIN_HOST_ENDPOINTS=soulcloud.generic=ws://plugin-host-generic:8090/rpc/ws
PLUGIN_RPC_MAX_FRAME_BYTES=1048576
PLUGIN_RPC_BACKPRESSURE_BYTES=4194304
PLUGIN_RPC_MAX_PENDING_REQUESTS=128
PLUGIN_RPC_IDLE_TIMEOUT_SECONDS=60

# Heartbeat/reconnect
PLUGIN_RPC_HEARTBEAT_INTERVAL_MS=15000
PLUGIN_RPC_HEARTBEAT_TIMEOUT_MS=3000
PLUGIN_RPC_RECONNECT_BASE_MS=500
PLUGIN_RPC_RECONNECT_MAX_MS=30000

# Reverse calls and staged effects
PLUGIN_RPC_MAX_OPERATIONS=64
PLUGIN_RPC_MAX_REVERSE_IN_FLIGHT=64
PLUGIN_RPC_PER_PLUGIN_REVERSE_IN_FLIGHT=16
PLUGIN_RPC_PER_INSTALLATION_REVERSE_IN_FLIGHT=8
PLUGIN_RPC_PER_OPERATION_REVERSE_IN_FLIGHT=4
PLUGIN_RPC_MAX_REVERSE_CALLS_PER_OPERATION=64
PLUGIN_RPC_MAX_STAGED_COMMANDS_PER_OPERATION=16

# Binary
PLUGIN_RPC_MAX_BLOBS=16
PLUGIN_RPC_MAX_BLOB_BYTES=65536
PLUGIN_RPC_MAX_TOTAL_BLOB_BYTES=262144
```

默认值必须通过测试和 benchmark 校准，不应直接把上例当作最终生产参数。启动时验证配置关系，
例如 operation 上限不得低于 event in-flight、单 Blob 上限不得大于 frame 上限、heartbeat timeout
必须小于 interval/Host liveness window。

## 18. Observability

至少暴露以下 metric，并带有限基数的 plugin/installation 标签：

```text
plugin_rpc_connections
plugin_rpc_connect_total{result}
plugin_rpc_handshake_total{result}
plugin_rpc_reconnect_total
plugin_rpc_calls_total{direction,procedure,result}
plugin_rpc_call_duration_seconds{direction,procedure}
plugin_rpc_pending_calls{direction}
plugin_rpc_receive_bytes_total{direction}
plugin_rpc_send_bytes_total{direction}
plugin_rpc_backpressure_total{side}
plugin_rpc_protocol_violation_total{reason}
plugin_rpc_active_operations
plugin_rpc_reverse_rejected_total{reason}
plugin_rpc_staged_effects{kind}
```

日志必须包含 connection ID、plugin ID/version、installation ID、operation ID 和 procedure，
但不得记录 bearer token、operation token、完整 binary、用户 secret 或未裁剪的插件 payload。

## 19. 实施步骤

每一步独立 commit，并将对应测试与实现放在同一 commit；迁移期间不删除当前 HTTP
MessagePack-RPC 回退路径。

### 步骤 0：隔离 PoC 和决策门

1. 精确锁定当时最新的 oRPC v2 beta，不使用 caret/range。
2. 在 Bun 1.4 上建立 client WebSocket ↔ Bun ServerWebSocket。
3. 同一 socket 挂载 d2h/h2d 两组 prefix。
4. 在 Host procedure 内反向调用 Dispatcher，再返回正向 result。
5. 验证并发、AbortSignal、socket close、Blob、BigInt 和 prefix isolation。
6. 用真实 event/entity/action/command payload 对比当前 HTTP MessagePack-RPC。
7. 若必须依赖 `@standardserver/peer` 私有 API，PoC 判失败；不得据此进入生产实现。

决策门必须输出：吞吐、p50/p99、CPU、RSS、wire bytes、断线清理结果和已知 beta 风险。

### 步骤 1：共享 contract

1. 新建 `@soulcloud/plugin-rpc-contract`。
2. 定义 Host router、scoped service router、Zod input/output 和错误类型。
3. 定义 RPC binary/Blob adapter，覆盖 Uint8Array round trip。
4. 将 handshake capability/version 明文化。
5. 加 type-level 和 runtime schema 测试。

### 步骤 2：单 socket 双 peer transport

1. Host 新增 `/rpc/ws` upgrade 和认证。
2. 实现 Bun ServerWebSocket bridge。
3. 挂载 d2h RPCHandler 和 h2d RPCLink，使用固定 prefix。
4. Dispatcher 实现连接、handshake、连接缓存和 fresh reconnect。
5. socket close 时统一清理双方 pending calls。
6. 加 prefix 串线、未知 frame、重复连接和多 Dispatcher 连接测试。

### 步骤 3：迁移正向 RPC，先做到功能等价

1. `host.handshake` → `system.handshake`。
2. `plugin.handleEvent` 改走 oRPC/WebSocket。
3. `action.encode` 改走同一连接。
4. 保留现有 Host output preflight 和 Dispatcher authoritative validation。
5. 保留现有 deadline、retry、lease、fairness 和 breaker 语义。
6. 新旧 transport 进行结果一致性测试。

此阶段不实现 scoped reverse service，先证明新 transport 不改变既有业务行为。

### 步骤 4：OperationRegistry 和只读反向调用

1. 实现有界 OperationRegistry。
2. 在每次 `handleEvent` 前创建 token，所有退出路径 finally 回收。
3. Host 创建 scoped reverse client，并从 plugin worker 隐藏 token。
4. `devices.getDeviceUid()` 改成本地 snapshot，不产生 RPC。
5. 实现 `context.entities.get`。
6. 加跨 connection/project/device、过期、seal 和并发隔离测试。

### 步骤 5：Staged command effects

1. 实现 `context.commands.enqueue` 的 Host adapter 和 Dispatcher handler。
2. 权威校验 command 和 binary limits。
3. 将 command intent 暂存在 operation，不立即写数据库。
4. 扩展 event completion transaction，复用 `enqueueBatchInTransaction()`。
5. 处理未 await reverse call、Host error、response 丢失和 commit 失败。
6. 证明重试不会产生重复/幽灵 command。

### 步骤 6：Hardening

1. Bun raw frame、连接数和 backpressure 限制。
2. global/per-plugin/per-installation/per-operation 限流。
3. Blob 数量、单体/总字节、深度和节点数限制。
4. heartbeat、idle、reconnect backoff 和 liveness 联动。
5. protocol violation 预算和安全日志。
6. 完整错误分类，确认永久数据错误不打开 breaker。
7. 混沌测试 Host crash/hang/OOM、Dispatcher restart 和网络中断。

### 步骤 7：兼容部署

1. Host 同时暴露旧 `/rpc` HTTP 和新 `/rpc/ws`。
2. Dispatcher 按配置选择 transport，默认使用 oRPC/WebSocket；设置
   `PLUGIN_RPC_TRANSPORT=http-msgpack` 才回退旧路径。
3. CI 和测试环境覆盖 oRPC/WebSocket，并保留回退 job。
4. 单个 canary plugin 使用新 transport。
5. 观察 reconnect、RSS、backpressure、timeout、dead-letter 和 breaker metric。
6. 全部 Host 切换后继续保留显式 HTTP 回退开关。
7. 经一个明确的稳定观察窗口后，单独 commit 删除旧 HTTP Plugin RPC。

删除旧 Plugin RPC 时，不得删除设备协议和数据库使用的 `@msgpack/msgpack`。

### 步骤 8：文档和 CI 收尾

1. 更新架构图、配置、部署、security 和 testing 文档。
2. CI 固定 Bun 1.4 和精确 oRPC v2 版本。
3. 增加依赖升级检查，但禁止 beta 自动升级。
4. 将双向/断线/backpressure/Blob/事务测试纳入常规非 E2E 后端 job。
5. 容器化 crash/hang 测试由 GitHub CI 执行，本地常规测试不运行完整 E2E。

## 20. 测试矩阵

| 层次 | 必测内容 |
| --- | --- |
| contract | input/output/error 类型，Zod validation，Uint8Array↔Blob，BigInt |
| transport | 双 prefix、并发 request、取消、close、reconnect、未知 frame |
| authentication | 无 token、错 token、handshake mismatch、业务调用早于 handshake |
| operation | scope 隔离、过期、seal、容量、connection binding、shutdown cleanup |
| resource | raw frame、Blob、节点/深度、pending、backpressure、调用/effect 上限 |
| entity | 当前 device 正常读取，跨 device/project、deprecated、版本漂移拒绝 |
| command | staged success、插件失败丢弃、response 丢失、commit 失败、retry 无重复 |
| breaker | transport fault 计数，永久数据错误不计数，core transient 分类正确 |
| chaos | Host crash/hang/OOM，Dispatcher restart，socket 中断，半开连接 |
| benchmark | 真实 0.5/4/64/256 KiB payload，双向 nested call，p50/p99/CPU/RSS/wire bytes |

## 21. 验收条件

完成迁移至少满足：

- 一条 WebSocket 上两个方向可以并发调用且不会串 response。
- Plugin Host 不能指定或访问 operation 之外的 project/installation/device。
- 任意 frame、Blob、pending request、operation 和 staged effect 都有硬上限。
- output 在 Host 和 Dispatcher 两侧验证，Dispatcher 保持最终权威。
- socket close 会终止全部 pending call、清理 operation 并丢弃 staged effects。
- command、entity updates 和 event completion 原子提交。
- Host crash/hang/OOM 不阻塞 API、broker、其他 Host 或 Dispatcher 调度循环。
- 永久插件/数据错误不触发 installation/Host circuit breaker。
- backpressure 不产生无界 heap queue。
- heartbeat/reconnect 不重放旧 request，恢复依赖 durable event lease。
- 设备协议、DeviceCommand MessagePack、日志打包和数据库 payload 完全不变。
- oRPC 依赖锁定精确版本，升级有 conformance tests 和人工审查。

## 22. 参考

- [oRPC WebSocket adapter](https://orpc.dev/docs/adapters/websocket)
- [oRPC RPC Handler 与支持的数据类型](https://orpc.dev/docs/rpc-handler)
- [oRPC File/Blob 限制](https://orpc.dev/docs/file-upload-download)
- [Bun WebSocket：headers、backpressure、timeout 与 maxPayloadLength](https://bun.sh/docs/runtime/http/websockets)
