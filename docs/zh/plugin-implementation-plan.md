# Soulcloud 插件架构分阶段实施计划

**状态**：待实施；本文件只规划代码工作，不表示已经完成
**日期**：2026-08-23
**依据**：`plugin-architecture.md`、`plugin-rpc-protocol.md`

## 1. 目标状态

最终只有以下部署角色：

```text
Human API
Device Broker
Plugin Manager
plugin instances
PostgreSQL
Web / reverse proxy
Soulcloud Devices running Soulcloud Client
```

禁止重新引入 Station、Agent、Fixture Plugin、workflow engine、本地 plugin runtime 或第二套
设备协议。Plugin Manager 和 plugin 的进程生命周期由 Docker Compose/systemd/Kubernetes
管理，应用代码不 spawn/kill/restart 容器。

## 2. 可复用的现有基础

现有实现中下列能力符合新架构，应迁移和改名而不是重写：

- oRPC v2 单 WebSocket 双向 RPC、Bun WebSocket bridge；
- operation token、reverse-call scope、seal/cleanup 和 staged effects；
- frame/Blob/value budget、并发、deadline、heartbeat、backpressure；
- `plugin_events` durable queue、lease recovery、retry/dead-letter、fairness 和 retention；
- installation/device binding/profile reconcile；
- Entity descriptor revision/current state/history；
- Action input validation、plugin encoder output validation 和 DeviceCommand queue；
- plugin 独立部署、无 DB/JWT、容器资源限制；
- Human API 的 project membership、审计和声明式 Entity/Action UI。

下列现有设计直接删除：

- `StationWorkflow*`、Station capability/job/step/snapshot 类型、validator 和测试；
- `stationJobs` scoped service；
- 编译期 manifest + worker 双 registry；
- `plugin-dispatcher`、`plugin-host` 对外名称、package/entrypoint/env alias；
- 任何 Station/Agent/Fixture/本地 runner 文档或计划；
- iframe/plugin client JavaScript 的近期计划。

## 3. 实施原则

- 每个阶段合并后仓库必须 typecheck、测试和构建通过；
- 不保留旧接口兼容层，不同时运行新旧服务；
- schema 变更仍使用正常 forward migration，不能假装已部署数据库不存在；
- 每类工作独立 commit，便于定位 regression；
- 先完成服务边界和 manifest 真相，再接 Device `/event`，最后做 SSR；
- Broker 热路径永不等待 Plugin Manager/plugin；
- Human API 始终是用户权限权威；
- plugin code 只在 plugin 自己的进程中执行。

## 阶段 0：契约冻结与删除清单

### 工作

- 以两份目标文档为唯一架构依据；
- 固定术语：Soulcloud Device、Soulcloud Client、Human API、Device Broker、Plugin Manager、
  plugin/plugin instance；
- 定义 `/event` MessagePack envelope 的精确字段、整数、binary、duplicate、unknown field 和
  trailing-byte 规则；
- 定义 manifest canonical serialization/hash；
- 定义 Human API → Manager internal auth 和 UI session signing/key rotation；
- 建立旧符号、路由、env、package、Compose service 和测试的删除清单。

### 尚需单独确认但不阻塞文档

- `/event.id` 的固定字节长度和 `seq` 掉电持久化要求；
- Human API → Manager 使用 oRPC/HTTP 还是普通内部 HTTP JSON；
- SSR HTML sanitizer/CSP 的具体库和允许标签；
- plugin 公网 egress 在 Compose、systemd 和 Kubernetes 下的具体网络实施。

### 退出条件

- wire/schema decision 均有测试向量；
- 删除清单通过 `rg` 和 package graph 复核；
- 不开始数据库或 runtime 双轨兼容设计。

## 阶段 1：清除旧 Station 契约和统一角色名

### 工作

- 删除 SDK 中所有 Station/workflow/job/step/capability/snapshot 类型及 validator；
- 删除 `PluginContext.stationJobs` 和相关 not-implemented adapter；
- 将 `plugin-dispatcher` package/service/entrypoint 直接改为 `plugin-manager`；
- 将旧 `plugin-host` runtime 改为中性的 plugin runtime package/entrypoint；对外只称 plugin；
- 更新 workspace scripts、imports、Dockerfile targets、Compose service、healthcheck、日志标签、
  metrics、`.env.example` 和 CI；
- 删除 `PLUGIN_HOST_*`/`PLUGIN_DISPATCHER_*` alias，统一 `PLUGIN_ENDPOINTS` 和
  `PLUGIN_MANAGER_*`；
- RPC prefix 从旧角色名一次性改为 manager/plugin prefix。

### 测试

- 全仓 typecheck/unit/integration/build；
- Compose config 和 healthcheck；
- `rg` 确认 runtime/API/docs 不再出现废弃 Station 和旧服务名称；
- plugin crash/hang 测试确认 Manager 及其他 plugin 不受影响。

### 退出条件

- 只有 Plugin Manager 和 plugin runtime 两个插件侧部署角色；
- 没有兼容 endpoint/env/package alias；
- 行为暂时与现有 event/action/entity 路径等价。

## 阶段 2：Manifest handshake 单一真相

### 数据库

新增或调整不可变 snapshot：

```text
plugin_manifest_snapshots
  plugin_id
  plugin_version
  manifest_hash
  canonical_manifest
  api_version
  first_seen_at

plugin_endpoints / deployment status（如确有持久化需要）
```

installation 固定 `plugin_id + plugin_version + manifest_hash`。已存在 deployment 数据用一次性
migration 转为 snapshot，不保留编译期 registry fallback。

### Manager/plugin

- handshake 返回 manifest；Manager 自行 canonicalize/hash；
- 首次合法 manifest 写 snapshot；同 ID/version hash 漂移拒绝；
- 多 instance 相同版本一致性检查；
- Manager catalog、routing、Entity/Action/profile lookup 全部使用 snapshot；
- 删除 API/Manager 对编译期 `pluginManifests` 的 import；
- plugin runtime 只加载本 plugin implementation，并在 handshake 暴露 manifest。

### Human API

- catalog、installation create/migrate、device bind/reconcile 改为读取 snapshot/Manager status；
- plugin 离线不删除 snapshot，但新 enable/migrate 是否允许按明确状态返回；
- manifest hash/version mismatch 有独立错误和审计。

### 测试与退出条件

- malformed/oversized manifest、hash collision/mismatch、multiple instance drift；
- Manager restart 后从 DB 恢复 catalog；
- plugin offline 时已有 metadata 可读；
- 仓库不存在第二份可被 Human API 使用的 manifest registry。

## 阶段 3：Plugin Manager internal API 与资源隔离

### 工作

- Plugin Manager 成为独立 Bun API server；
- Human API 通过内部 service credential 调用 catalog、installation、Action encode/status；
- internal endpoint 使用独立 bind/network、body limit、deadline 和 structured error；
- Browser 不能访问 internal endpoint；
- background event、internal API 和 SSR 分别设置 concurrency/DB pool budget；
- graceful shutdown：停止 lease、等待/归还 operation、关闭 socket；
- readiness 只反映 Manager 自身依赖，不因单个 plugin offline 失败。

### 测试

- service auth 缺失/错误/轮换；
- Human API timeout/Manager unavailable 映射 502/503；
- 慢 plugin/event flood 不阻塞 catalog/internal health；
- 两个 Manager replica 不重复完成 event；
- 一个 plugin breaker 不影响其他 plugin。

### 退出条件

- Human API 不直接连接 plugin；
- Manager 是所有 plugin RPC 和 metadata operation 的唯一入口；
- Broker 和 Human API 在 Manager 失效时仍能独立提供非插件能力。

## 阶段 4：Device `/event` 端到端路径

### Shared protocol

- 在 core/shared package 定义 topic 构造、解析和 MessagePack codec；
- 严格拒绝 unknown/duplicate/missing/null/wrong type/trailing bytes；
- 限制 event、batch、string、binary 和 nesting；
- 提供 Soulcloud Client 可复用的协议文档和测试向量。

### Device Broker

- 订阅 `soulcloud/v1/devices/+/event`，QoS 1；
- 认证 topic UID 与 session device 一致；
- 校验 envelope、大小和速率；
- 从 device binding 创建 immutable plugin routing snapshot；
- `(device_id,event_id)` 幂等插入 durable `plugin_events`；
- DB commit 后才完成对应 MQTT 处理；
- 不 import plugin code、不调用 Manager、不解析 payload。

### Plugin Manager

- lease event 并按 snapshot 的 plugin/version/profile 路由；
- `receivedAt` 固定为 Broker 入库时间，retry 不重新生成；
- permanent device/plugin data error 直接 dead；
- transient transport/plugin error retry；
- event completion 与 Entity/command effects 原子提交。

### Soulcloud Client

- 增加 `/event` publish API；
- 有界编码，QoS 1，持久 seq/idempotency；
- 失败重试不重新执行业务副作用；
- 不发送 plugin/project/installation routing 字段。

### 退出条件

- 真实 Client event → Broker → DB → Manager → plugin → Entity 的纵切通过；
- duplicate/reconnect/Manager outage 不重复提交副作用；
- plugin hang 不影响 MQTT `/stat`、`/log`、command result。

## 阶段 5：Action、Entity 与安装生命周期切换

### 工作

- Human API Action 请求经 Manager → plugin `action.encode`；
- Manager 权威验证 encoded DeviceCommand 并写现有 command queue；
- 用户 schema 错误为 400，plugin encoder 错误为 502；
- Entity 删除 write/read_write，所有控制统一 Action；
- bind/migrate/reconcile 使用 manifest snapshot 并维持锁顺序；
- installation upgrade 固定新 version/hash，pending event 保持旧 snapshot；
- stale quality 在服务端按数据库时钟统一推导，不只在浏览器计算；
- 更新声明式 Entity/Action Web UI 读取路径。

### 测试

- bind/migrate/disable/concurrent bind；
- deprecated/reintroduced Entity；
- invalid action input/output；
- version/hash drift 与 pending event；
- Entity history revision、stale、retention 和分页。

### 退出条件

- Human API、Manager 和 plugin 对 manifest/version/entity/action 只有一套解释；
- plugin 不能越过当前 operation 对其他 Device 入队 command；
- 所有旧进程内 encoder 路径删除。

## 阶段 6：Plugin SSR MVP

### Session 与路由

- Human API 签发短期 `/plugins/*` UI session；
- session 绑定 user/project/installation/plugin/version/hash/route/permission/locale/expiry；
- reverse proxy 把 `/plugins/*` 路由到 Manager；
- Manager 验签并创建最小 `PluginUiContext`，不接收长期 JWT。

### Plugin SSR

- manifest 声明 SSR routes 和 input/query schema；
- plugin 内执行 React SSR，Manager 不 import component/module；
- 实现 `ui.render` HTML fragment/stream 和 `ui.handleAction`；
- Manager 添加统一 document shell、CSP、header allowlist、deadline、byte/backpressure limit；
- 普通 form/link 提供交互；第一版不 hydration/RSC/client bundle；
- 为未来 SSR stream pass-through 保留 capability negotiation，但不暴露 plugin endpoint。

### 测试

- project/installation/route 越权和 session 重放/过期；
- plugin upgrade/disable 后 session 失效；
- render timeout、crash、stream 中断、超大 HTML、坏 status/header；
- SSR plugin 使用 scoped data，无法获得长期 JWT/其他项目数据；
- 一个 SSR 页面挂死不影响 Manager internal API、event consumer 或其他 plugin UI。

### 退出条件

- 至少一个真实 plugin 页面完全由 plugin 内 SSR；
- Web frontend 只依赖稳定 `/plugins/*`，不依赖 plugin endpoint/bundle；
- Plugin Manager 进程未加载任何 plugin React code。

## 阶段 7：公网 egress 与跨 plugin 调用

### Public API

- plugin 可以使用自己的 credential 访问 weather/map/geocoding/vendor API；
- 为外部请求设置 timeout、response bytes、connection pool 和 DNS policy；
- 屏蔽 Broker、DB、Device subnet、internal Human API 和 cloud metadata；
- 外部依赖错误只影响 caller plugin/operation。

### Plugin-to-plugin

- 无租户纯计算接口可以按部署配置直连；
- 涉及 Soulcloud scope 的调用实现 `context.plugins.callScoped`；
- capability 只能收窄，限制 depth/fan-out/concurrency/deadline；
- target plugin 不接受 caller 自报 project/device/user；
- 审计 caller/target/operation，但不记录敏感 payload。

### 退出条件

- 网络测试证明允许公网而拒绝 Soulcloud internal/device network；
- scoped cross-plugin 调用不能越 project/device；
- 循环调用、fan-out 和超大响应被有界拒绝。

## 阶段 8：生产硬化与收尾

- 删除所有迁移期间的临时代码和 feature flag；
- retention、索引、DB pool、event batch、SSR stream 和外部 API 做压测；
- plugin crash/hang/OOM、Manager restart、DB failover、网络中断做混沌测试；
- 检查 Compose/systemd/Kubernetes 的资源和 restart policy；
- 验证 plugin 能访问允许的公网/peer，却不能访问 Broker/DB/Device/internal API；
- 多 Manager、多 plugin instance 做 soak test；
- 更新运维手册、环境变量、监控告警和故障处理；
- 根据实测再决定是否需要对象存储、telemetry topic、RSC/hydration 或更多基础设施。

## 明确不在本计划内

- Station 或工位专用身份/协议；
- workflow/orchestration；
- Device 上的 plugin/RPC/container；
- 用户运行时安装 plugin；
- Plugin Manager 自动管理容器；
- plugin 直连 Broker、Device 或硬件；
- 第一版 client-side plugin JavaScript/RSC；
- 尚无实测需求的对象存储、多 broker 和高频 telemetry 独立管线。
