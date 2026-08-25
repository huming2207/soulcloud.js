# Soulcloud 插件架构分阶段实施计划

**状态**：阶段 0–3 与服务端阶段 4–5 基础纵切已实现；设备侧、完整 Plugin UI、阶段 7–8 待实施
**日期**：2026-08-25
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

## 2. 当前项目基线

历史插件相关代码已删除；当前插件实现是按本计划从零写出的新代码，不是旧 Dispatcher/Host
的改名或兼容层。现有基础纵切包括：

- `packages/plugin-sdk`：manifest、profile、Entity、Action、事件和 UI 契约与校验；
- `packages/plugin-rpc-contract`：oRPC/WebSocket 双 prefix、handshake、Blob/JSON 预算和
  canonical manifest hash；
- `packages/plugin-runtime`：只加载显式 entrypoint 的通用 plugin 进程，不负责容器生命周期；
- `packages/plugin-manager`：独立 Bun 服务、主动连接、事件 lease、Action、Entity reverse RPC
  和 `/plugins/*` SSR 路由；
- core 的 immutable manifest snapshot、durable `/event` queue、Entity revision/state/history、
  installation/binding 生命周期和 retention migration；
- Human API 的权限检查与内部 service-auth 路由，以及 Compose/Dockerfile 的独立部署边界。

这些代码不恢复历史 endpoint、环境变量、package 名或旧 RPC envelope；Device 侧仍只使用现有
Device Broker MQTT/HTTPS 协议。

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

**状态：已完成。** 旧插件目录、旧 Dispatcher/Host 命名、旧 endpoint/env 和双 registry 已
从工作树删除；新 `/event` envelope、manifest hash、UI session 和 RPC contract 已冻结并有
CI 类型/单元测试覆盖。

### 工作

- 以两份目标文档为唯一架构依据；
- 固定术语：Soulcloud Device、Soulcloud Client、Human API、Device Broker、Plugin Manager、
  plugin/plugin instance；
- 定义 `/event` MessagePack envelope 的精确字段、整数、binary、duplicate、unknown field 和
  trailing-byte 规则；
- 定义 manifest canonical serialization/hash；
- 定义 Human API → Manager internal auth 和 UI session signing/key rotation；
- 建立新 package、路由、env、数据库 migration、Compose service 和测试清单。

### 尚需单独确认但不改变已冻结 wire

- `seq` 在不同等级 Soulcloud Client 上的掉电持久化策略（`id` 已固定为 16-byte bin）；
- Human API → Manager 使用 oRPC/HTTP 还是普通内部 HTTP JSON；
- SSR HTML sanitizer/CSP 的具体库和允许标签；
- plugin 公网 egress 在 Compose、systemd 和 Kubernetes 下的具体网络实施。

### 退出条件

- wire/schema decision 均有测试向量；
- 删除清单通过 `rg` 和 package graph 复核；
- 不开始数据库或 runtime 双轨兼容设计。

## 阶段 1：建立插件 package 与部署边界

**状态：已完成基础纵切。** 新 SDK、RPC contract、Plugin Manager、plugin runtime、Compose
target、healthcheck 和连接认证已落地；容器生命周期仍由部署系统负责。

### 工作

- 新建 plugin SDK、RPC contract、独立 `plugin-manager` Bun service 和通用 plugin runtime；
- Plugin Manager 主动连接 `.env` 中配置的 plugin oRPC/WebSocket endpoint；
- plugin runtime 只加载自己的显式 entrypoint，Manager 不加载 plugin code；
- 更新 workspace scripts、imports、Dockerfile targets、Compose service、healthcheck、日志标签、
  metrics、`.env.example` 和 CI；
- 从第一版只使用 `PLUGIN_ENDPOINTS`、`PLUGIN_MANAGER_*` 和 manager/plugin RPC prefix；
- Docker Compose/systemd/Kubernetes 管理进程生命周期，应用代码不 spawn/kill/restart。

### 测试

- 全仓 typecheck/unit/integration/build；
- Compose config 和 healthcheck；
- `rg` 确认 runtime/API/docs 没有引入 Station、Agent、Dispatcher 或 Host 角色名；
- plugin crash/hang 测试确认 Manager 及其他 plugin 不受影响。

### 退出条件

- 只有 Plugin Manager 和 plugin runtime 两个插件侧部署角色；
- 没有兼容 endpoint/env/package alias；
- handshake、连接认证、heartbeat、断线清理和基础资源限制形成最小纵切。

## 阶段 2：Manifest handshake 单一真相

**状态：已完成基础纵切。** handshake canonical hash、不可变 snapshot、漂移拒绝和 Manager
重启后的 DB catalog 恢复已落地。

### 数据库

新增不可变 snapshot：

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

installation 固定 `plugin_id + plugin_version + manifest_hash`。首版直接使用 snapshot，不
建立编译期 registry fallback。

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

**状态：基础纵切已完成；资源预算仍部分完成。** Human API 通过 service-auth 内部 HTTP 调用
Manager，且同步 Action 的 operation deadline 短于 Human API internal HTTP deadline；RPC
value/Blob、active operation、reverse call 和 staged command 数量/累计字节均已有部署可调硬上限。
事件消费已按 installation 有界并发，Action/SSR 的独立预算、DB pool reservation 和完整观测
仍属于阶段 8。

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

**状态：服务端基础纵切已完成，Soulcloud Device 侧未在本仓库验证。** Broker 只校验通用
envelope、持久化完整 uint64 sequence，且不解释 plugin payload；相同
`(device_id, event_id)` 的相同内容幂等成功，不同内容会被 ACK 后记录为冲突，避免设备永久重投。
Manager 异步 lease；QoS 1 幂等、固定入队时间、retry/dead-letter、retention、lease 续期和
Entity completion 已落地。真实设备 publish/掉电 sequence 仍是退出条件。

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

### Soulcloud Device

- 在设备软件中增加 `/event` publish API；
- 有界编码，QoS 1，持久 seq/idempotency；
- 失败重试不重新执行业务副作用；
- 不发送 plugin/project/installation routing 字段。

### 退出条件

- 真实 Device event → Broker → DB → Manager → plugin → Entity 的纵切通过；
- duplicate/reconnect/Manager outage 不重复提交副作用；
- plugin hang 不影响 MQTT `/stat`、`/log`、command result。

## 阶段 5：Action、Entity 与安装生命周期切换

**状态：已完成基础纵切。** Action 输入/encoder 输出分类、profile descriptor revision、
多 profile binding、deprecated 收敛、stale DB 时钟、完整 uint64 sequence、批量 Entity upsert
和升级后不兼容 current state 清理已落地；历史查询 API 和更完整的 UI catalog 仍待后续阶段补齐。

### 工作

- Human API Action 请求经 Manager → plugin `action.encode`；
- debugger target-config revision 元数据经受限 `debugger.listTargetConfigs` RPC 暴露；Manager 不读取 plugin 私有 YAML；
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

## 阶段 6：Plugin UI MVP

**状态：SSR 与 client asset 传输基础纵切已完成，产品 MVP 未完成。** Human API 能签发短期
path-scoped HttpOnly session cookie，Manager 能验签并转发有界 HTML fragment；manifest/contract/
runtime 已有 `ui.asset`，并通过 Manager 同源代理一个最小 client bundle。当前 bundle 尚未做
content hash，独立 plugin-origin bootstrap、`context.ui.getData` 和实时 UI channel 仍未完成。
RSC 与 Manager 进程内执行 plugin code 仍不在范围内。

### Session 与路由

- Human API 签发一次性、短期、绑定
  user/project/installation/plugin/version/hash/route/permission/locale/expiry 的 bootstrap grant；
- Browser 通过非 URL 泄露方式将 grant 交给独立 plugin UI origin 的 Manager，换取该 origin
  path-scoped HttpOnly session；
- plugin UI origin 的 reverse proxy 把 `/plugins/*` 路由到 Manager；
- Manager 验签并创建最小 `PluginUiContext`，不接收长期 JWT。

### Plugin SSR

- manifest 声明 SSR routes 和 input/query schema；
- plugin 内执行 React SSR，Manager 不 import component/module；
- 实现 `ui.render` HTML fragment 和 `ui.handleAction`；
- Manager 添加统一 document shell、CSP、header allowlist、deadline、byte/backpressure limit；
- 普通 form/link 继续作为无 JavaScript fallback；
- manifest 声明 immutable client JS/CSS asset 的路径、MIME、大小和 content hash；
- Manager 从 plugin 获取、复核并缓存 asset，从 `/plugins/{installation}/assets/{hash}/...`
  同源返回，不暴露 plugin endpoint；
- plugin UI 使用独立于 Human Web/API 的 origin；Human API 签发一次性、短期、绑定
  installation/route 的 bootstrap grant，由 Plugin Manager 换成 plugin-origin HttpOnly cookie，
  不能让 bundle 读取主站 `localStorage` refresh token 或借主站 origin 调用 `/api/*`；
- Browser live channel 终止在 Manager；每条连接重新校验 UI session、installation/version/hash、
  route 和 permission，再通过有界 oRPC stream/call 连接对应 plugin；
- Manager 不 import、hydrate 或执行 plugin bundle，不实现 RSC。

### 测试

- project/installation/route 越权和 session 重放/过期；
- plugin upgrade/disable 后 session 失效；
- render timeout、crash、stream 中断、超大 HTML、坏 status/header；
- asset traversal、错误 MIME/hash、超大 bundle、cache key/version 隔离；
- live channel 越权、重连、慢消费者、backpressure、消息上限和 permission/session 失效；
- SSR plugin 使用 scoped data，无法获得长期 JWT/其他项目数据；
- 一个 SSR 页面挂死不影响 Manager internal API、event consumer 或其他 plugin UI。

### 退出条件

- 至少一个真实 plugin 页面由 plugin 内 SSR，并通过 content-hashed client bundle 完成交互；
- Web frontend 只依赖稳定 `/plugins/*`，不依赖 plugin endpoint，也不 import plugin bundle；
- Plugin Manager 进程未加载任何 plugin React code。

## 阶段 7：公网 egress 与跨 plugin 调用

**状态：已完成受限 plugin-to-plugin 基础；公网 egress policy 和 UI/data capability 仍待实施。**
`context.plugins.callScoped` 只能调用 target plugin 显式注册的 procedure，Manager 继承并收窄
当前 scope，同时限制调用深度、operation、并发、deadline 和 payload budget。

### Public API

- plugin 可以使用自己的 credential 访问 weather/map/geocoding/vendor API；
- 为外部请求设置 timeout、response bytes、connection pool 和 DNS policy；
- 屏蔽 Broker、Soulcloud PostgreSQL、Device subnet、internal Human API 和 cloud metadata；
- 允许 plugin 使用部署系统为它单独提供的私有数据库；私有数据库 schema、migration、backup、
  retention 和 recovery 由 plugin/部署系统负责，Manager 不读取其业务表；
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

**状态：待实施。** 需要根据部署规模补充网络策略、压测、混沌/多副本 soak、观测和运维手册。

- 删除所有迁移期间的临时代码和 feature flag；
- retention、索引、DB pool、event batch、SSR stream 和外部 API 做压测；
- plugin crash/hang/OOM、Manager restart、DB failover、网络中断做混沌测试；
- 检查 Compose/systemd/Kubernetes 的资源和 restart policy；
- 验证 plugin 能访问自己的私有数据库和允许的公网/peer，却不能访问 Broker、Soulcloud
  PostgreSQL、Device/internal API；
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
- React Server Components、Manager 进程内 hydration 或执行 plugin client bundle；
- 尚无实测需求的对象存储、多 broker 和高频 telemetry 独立管线。

## 产品扩展计划

通用插件阶段完成后，远程 debugger 所需的 durable execution capability、设备控制 lease、
artifact transfer、client bundle 和实时 UI 按
`soulinjector-remote-debugger-plugin-plan.md` 的 D0–D9 实施。它们不改变本计划对 Station、
设备侧 plugin runtime 和通用 workflow/orchestration 的禁止，也不把 SoulInjector 产品 case、
LLM state 或报告写入 Soulcloud PostgreSQL。

## 进入下一阶段前必须确认的语义

以下事项会改变 schema 或部署路由，不能由实现者自行假设：

1. 一个 Soulcloud Device 是否允许同时绑定多个 plugin installation。当前数据库主键使每个
   device 只能绑定一个 installation；若业务上需要多个插件同时消费同一设备事件，必须先确定
   fan-out、profile 和 Action 归属语义。
2. 同一 plugin ID 是否需要同时在线多个 version，以及同 version 是否需要多个 endpoint。
   当前 `PLUGIN_ENDPOINTS` 是 `pluginId=url`，一次只能连接一个 endpoint；这意味着升级到新
   endpoint 后，旧 snapshot event 会暂停等待旧版本重新可用。
3. Entity `history: "sampled"` 的采样周期由谁声明。当前还没有 interval 字段，因此实现暂时按
   `all` 写 history；不能在未确认周期、对齐方式和 DB clock 语义前假装已经采样。
4. installation config 是否需要 manifest schema。当前 config 是有界 JSON snapshot，但不做
   plugin-specific schema 校验；若 UI/API 要支持通用配置表单，应先定义 schema 契约。
