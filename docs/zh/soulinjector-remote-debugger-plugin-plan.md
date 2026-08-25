# SoulInjector 远程 Debugger Plugin 实施计划

**状态**：计划 + 第一轮代码已开始实现（D1、D4、D6 的基础能力已落地；D3 已落地 durable execution、lease、事件侧 execution capability 传递、受限 execution reverse RPC 和已绑定 session 终态关闭平台 execution 的同步；私有 case/session/observation/report 数据层已落地；Human API start/session/bootstrap 已有基础版本；设备固件、LLM、pause/cancel/take-over、重启恢复和完整设备 command 闭环尚未实现）
**日期**：2026-08-25
**依据**：`plugin-architecture.md`、`plugin-rpc-protocol.md`、`plugin-implementation-plan.md`

## 1. 产品目标

将 SoulInjector 做成一台可联网、可远程控制、可由人类工程师或 LLM 调试 agent 使用的
Soulcloud Device，并用一个独立云端 plugin 提供两类产品能力：

1. 研发调试：用户上传 ELF 或固件（source archive/VCS 留到后续阶段），远程诊断通过 SWD/UART 连接的目标 MCU，
   收集证据并生成修改建议；
2. 跨境维修：海外非技术人员只负责按说明接线，设备自动开始初检；国内支持/研发人员和
   LLM 在同一维修案例中继续分析、接管设备并生成报告。

本文只规划远程 debugger。听力检测产品不属于当前范围。

## 2. 术语和不可违反的边界

- **SoulInjector 是 Soulcloud Device**。通过 SWD/UART 接在它上面的待测 MCU/产品只是本地
  target，不因被调试而成为 Soulcloud Device。
- **Soulcloud Client** 只表示运行在 Soulcloud Device 上的 Soulcloud 通信软件/固件组件；
  描述硬件执行主体时必须写“设备”或“SoulInjector 设备”，不能用 Client 代指设备。
- SWD/UART 的低层协议、时序、target 状态、重试、轮询和批量读写由 SoulInjector 设备本地的
  设备软件/固件执行。该设备软件/固件可以包含 Soulcloud Client 通信组件，但低层能力的归属
  是设备，不是一个叫 Client、Station 或 Agent 的独立系统角色；云端只下发高层、有界、可取消
  的 debugger command。
- 低层 SWD/UART 始终归属于 SoulInjector 设备的本地设备软件/固件；Soulcloud Client 仅是
  其中负责 Soulcloud 通信的组件名称，不是设备身份，也不是硬件驱动的执行主体名称。
- plugin 只在云端自己的容器中运行；它不能连接 Device Broker、SoulInjector 设备、
  Soulcloud PostgreSQL 或任何 SWD/UART/JTAG/USB 硬件。
- plugin 通过 Plugin Manager 获取所有 Soulcloud 范围内的 device、command、artifact、用户
  和权限能力；设备仍只通过现有 Device Broker MQTT/WSS 和 Soulcloud HTTPS 入口通信。
- Docker Compose、systemd 或 Kubernetes 管理 Plugin Manager、plugin 和 plugin 私有数据库
  的生命周期。应用代码不 spawn、kill 或 restart 容器。
- 本计划不引入 Station、Agent 服务、设备侧 plugin runtime、第二套设备 RPC 或通用
  workflow/orchestration。本文中的 agent 只表示 plugin 内的 **LLM 调试 agent**。

### 2.1 当前实现进度（2026-08-25）

已提交的基础实现包括：

- `packages/soulinjector-plugin` 独立 plugin package/image、manifest、profile、SSR 配置页和
  最小 client bundle；
- SSR debugger 页面现在提供 ELF/firmware 文件选择和上传入口。浏览器只把文件流发送到
  Plugin Manager 的 plugin-origin session 路由；Manager 使用短期 HttpOnly UI session、UUID
  幂等键和受限 metadata 将流分块转发到 plugin 私有 PostgreSQL，不让浏览器接触长期 service
  token，也不把 artifact 正文放进 SSR/RPC JSON；上传操作绑定 UI session 中的 installation、
  project、user、plugin version 和 manifest hash 快照，安装迁移/禁用后不会把旧会话的流改投到
  新版本 plugin；上传时可选择 installation 下的 debugger case
  作为归属；Manager 在最终 chunk 后再次复核该 snapshot，迁移/禁用竞态不会把旧 plugin 的结果报告为当前 UI 会话成功；网络异常时浏览器最多用同一幂等键重试一次，上传完成后页面只重新读取 metadata 摘要。
  非 UI 的 Human API artifact 上传也在最终 chunk 前后复核 installation 的 project、plugin/version、manifest
  hash 和 enabled 状态，迁移或禁用时拒绝接受旧 plugin 的 artifact 结果。
- target architecture/chip、transport 和 required debugger primitives 的受限 YAML schema，
  可通过 Human API/Plugin Manager 配置并在 plugin 私有 PostgreSQL 保存 revision；首批目标不
  在代码中写死；
- ELF/firmware 的大小、文件名、ELF magic、SHA-256 校验，以及 ELF32/ELF64、字节序、machine、
  entry/header table 等固定头元数据解析；元数据与正文一起在私有 PostgreSQL `bytea`/JSONB 中保存，
  通过 artifact list RPC 暴露；64 KiB 分块上传不使用 S3/object storage；
- `debugger.configureTarget`、`debugger.listTargetConfigs`、`debugger.listArtifacts`、分块 artifact RPC、UI asset RPC；Plugin Manager 只做鉴权、
  路由和转发，不读取 plugin 私有业务表；SSR 配置页展示受限的 target-config revision 和 ELF/firmware artifact 元数据摘要，但不回显 YAML 或 artifact 正文；UI asset 已绑定 manifest SHA-256 并使用内容哈希路径；
  configure/list/read 返回前会复核 installation 的 project、plugin/version、manifest hash 和 enabled 状态，迁移或禁用竞态不会把旧 plugin 的只读结果当作当前安装数据返回；
- Plugin Manager ↔ plugin 另有受限的 `debugger.readArtifactChunk` RPC：每次最多读取 64 KiB，plugin 私库使用
  PostgreSQL `substring(bytea)` 按块返回，不把完整 artifact 读入 Manager；这是后续 device transfer gateway 的
  基础能力；Manager 另提供仅限 service token 的内部二进制读取端点并返回 offset/total/hash/final 元数据，
  当前仍不开放设备端 HTTP，也不预先决定 push staging 或 controlled pull proxy。
- artifact 上传要求 Human API 的 `Idempotency-Key`（UUID）贯穿 API → Plugin Manager → plugin 私库；响应丢失后用同一 key 重试会返回原 artifact，而不会重复创建；上传流还有可配置的绝对 wall-clock deadline，避免卡住的 body 或大量分块长期占用资源；
- 每个 plugin artifact chunk 响应都必须回显本次请求的 `uploadId`；Plugin Manager 在推进进度或接受完成结果前核对该身份，插件误把其他上传的响应返回时以 `invalid_plugin_output` 拒绝，不得串写上传状态；
- SSR target 配置表单支持 textarea 和受限的 YAML 文件载入，对非法 YAML 给出受限错误状态；Human API
  同一路由接受 JSON `{yaml}` 或原始 YAML 文本，详细 schema 校验仍由 plugin 私有 parser 执行，路径返回 400，
  不把用户提交的原文拼进 redirect 或页面错误信息；
- 高层 SoulInjector command/event schema 和 `requiresHumanApproval` action 元数据；动作编码
  会读取指定 installation/project 下的不可变 target-config revision，并把目标快照传给设备。
  `debugger.configureTarget` 在 plugin RPC 返回后也会重新校验 installation 的
  project、plugin version、manifest hash 和 enabled 状态；如果配置期间发生迁移、升级或禁用，
  Manager 丢弃旧结果并返回冲突，而不把旧 plugin 的配置报告为当前安装的成功结果。
  Manager 在 plugin encoder 返回后再次将 args 还原为 action input 并校验 manifest schema；
  encoder 即使返回了结构正确但越界/未知字段的参数，也会以 `invalid_action_output`（502）拒绝，
  不会把 plugin bug 伪装成用户输入错误。
  manifest 为 architecture/chip/transport/requiredPrimitives 声明可选的快照字段；用户输入的
  同名值不会成为权威，encoder 总是从选定 revision 重新读取并覆盖它们。
  当前
  Human API 的人工 action 请求显式传递 approval；真正可审计的长期 approval/execution record
  仍属于后续阶段。
- Plugin Manager 提供绑定短期 plugin-origin UI session 的
  `/plugins/{installation}/actions/{actionId}` 人工 action route；SoulInjector SSR 页面只在选中的
  active session 上提供 bounded identify/read-registers/read_memory/halt/resume/reset/start
  按钮，paused/终态或没有 execution lease 的 session 不渲染可执行按钮，其中 read_memory 的地址
  和长度在浏览器端先做有界校验，服务端仍会再次按 manifest/schema 与设备能力校验。
  每次点击都携带当前 session 的 `executionRef`；Manager 在 installation → device → execution
  的同一事务中用数据库时钟锁定并检查 execution 仍属于该 installation/device、处于 active 且
  device lease 和 TTL 均未过期，同时用共享锁复核 initiating user 仍是 project member，之后才允许
  入队；查询还必须确认 execution 明确授予 `device.enqueue_command` capability，并把 execution ID
  写入 command provenance。
  当前尚未实现 take-over，因此 UI session 的用户还必须是 execution 的 initiating user；未来人工接管
  需要在同一权威事务中原子更新 controller/授权后再放行新的用户。
  lease 失效或 session 被迁移/禁用后，旧页面的请求会得到冲突而不会继续控制设备。destructive
  action 仍只能由该次人工点击批准，plugin/LLM 没有同一入口；不带 executionRef 的通用 Human
  API action 兼容路径不因此自动获得 debugger execution 控制权。
- Plugin-origin debugger 页面还可以通过
  `/plugins/{installation}/debugger/sessions` 创建 session；该 POST 只接受当前短期 UI session
  的 user/project/installation scope，严格校验 case、Soulcloud Device、target-config 三元组和
  artifact 引用，Manager 负责 execution capability、设备 lease、并发冲突和 plugin bootstrap。
  页面不会接触主站 JWT，也不会让 plugin 直接获得 execution token。
- 当前 execution 发起人可以在同一个 plugin-origin debugger 页面显式释放自己的 device lease；该
  路由只使用 Manager 进程内尚未过期的原始 capability，不能由其他 project member 或 plugin
  reverse RPC 代替 take-over。Manager 重启后不会从数据库恢复原始 token，因此旧页面只能得到
  冲突并重新启动一个人工 session。
- 页面在 execution 仍为 active 时会以低频 heartbeat 续租 device lease；续租请求同样绑定
  installation、plugin manifest、project membership 和 execution 发起人，session cookie 或
  Manager capability 失效后不会继续续租。
- Plugin Manager 在每次 SSR、asset、UI action 和 plugin-origin session 创建前同时复核
  `plugin_installation` 快照与 `user_projects` membership；用户被移出 project 后，尚未过期的旧
  UI cookie 也会立即失效。
- SSR debugger 页面已暴露 plugin 私有 report 草稿：可按 project-scoped case 创建报告、追加有界
  revision，并将 draft 定稿；报告正文和 revision 只写入 plugin 私有 PostgreSQL，Manager 只负责
  当前 UI session 的鉴权与转发。
- 选中的失败或仍有最新设备错误的 debugger session 会在 SSR 页面显示有界、HTML-escaped 的错误告警；
  错误只从已校验的 `debug.status.error` 或 `debug.log` error observation 提取，缺少诊断信息时显示
  固定 fallback，不把任意数据库字段直接拼进页面。
- 选中带 execution 的 debugger session 时，页面会通过受 UI session 和 installation/plugin 快照
  保护的 command-status endpoint 低频轮询 command timeline；只返回 batch、状态、结果码和时间等
  元数据，不返回设备 command payload，也不把这条临时轮询当作最终 live WebSocket 协议。
- 同一 debugger UI session 现在可以对属于当前 execution 的单条 queued/leased/broker-accepted
  command 请求取消；Manager 会重新校验 UI session、installation/project、execution 发起人和
  进程内 capability，再调用 core 的 `device.cancel_command`。queued command 会进入
  `delivery_failed` 并释放队列；已经被 broker 接受的 command 只记录取消请求，不能伪装成设备已停止。
- `DebugExecution` 已保存平台侧长时 capability：不可变 plugin/version/manifest snapshot、
  initiating user、allowed capability names、token hash、active/paused/cancelling/terminal 状态、
  device lease 和 expiry；同一设备只有一个 active/cancelling execution，lease/expiry 使用数据库
  时钟。execution 私有 token 不写入数据库。
- Human API 已有基础 `POST .../debugger/sessions` 入口；Manager 通过专用
  `debugger.startSession` RPC 将一次性 execution token 交给同一 plugin，并只向 Human API 返回
  execution/session 摘要。bootstrap RPC 返回后，Manager 会按 installation → device → binding
  的统一锁顺序重新验证启用状态、manifest/device scope、数据库时钟 lease 和 execution state，
  并用数据库共享锁确认 initiating user 仍是 project member；不把并发禁用、迁移、重绑定或
  撤权期间已经失效的 active execution 返回给 Human API。plugin 私有
  session 保存 execution 引用但不保存原始 token；如果 bootstrap 已在 plugin 私库创建 session
  但后续 scope revalidation 失败、插件返回了格式错误的 execution echo，或 bootstrap 响应在插件
  已提交后丢失，Manager 会通过有界、仅 Manager 可调用的 `debugger.abortSession` 按 session ID
  或唯一 execution scope 将该私有 session 标为 failed；该清理不发送设备 command，也不替代人工
  批准。相同设备已有 active execution 时，Human API 得到明确的 409 conflict，而不是内部错误。
  Human API 也提供只读的 `GET .../debugger/executions/:executionId` 状态查询；它先执行项目权限
  检查，再由 Manager 重新校验 installation/project scope 和当前 user membership，只返回 execution
  摘要，不返回 token。
  整个 execution 的 pause/cancel、take-over 和 plugin 重启后的 capability 恢复仍未完成；这里的
  单条 command cancellation 不是整个 execution 的取消，也不等价于硬件已经停止。
- oRPC reverse contract 已提供 `context.executions.get`、`renewLease`、`release`、`complete`，以及
  受 execution capability 约束的 `context.devices.enqueueCommand`、`getCommand`、`cancelCommand`；
  Manager 会绑定父 operation、plugin/version、installation、device、token hash 和 capability
  白名单。`release` 只释放设备控制权并把 execution 置为 `paused`，不删除历史记录；数据库维护任务
  会释放过期 lease 并把达到 TTL 的 execution 标记为 `expired`。
- execution reverse command 在入队前还必须把单键 args 重建为 action input，并通过当前 manifest
  的 action schema、范围、枚举和必填字段校验；不能因为 command 名称已声明就让 plugin 绕过
  `read_memory` 等参数边界。校验失败的 event 输入会作为永久 `INVALID_EVENT_INPUT` 处理，不应
  无限重试或反复触发 installation circuit breaker。
- 同一 Manager 进程内，设备事件分发会按 installation/device 找到当前 active 且仍持有 lease 的
  execution，并只从进程内 token cache 取出原始 capability 传给插件；Manager 每次事件都会再用
  数据库中的 token hash、lease、installation、device、plugin/version/hash 和 initiating user 的
  project membership 复核。原始 token 不写入
  Soulcloud 或 plugin 数据库，Manager 重启后不会伪造恢复能力；跨重启 re-issue/resume 仍待实现。
- plugin 私有 `debug_sessions.execution_ref` 已建立非空唯一约束；同一个 execution 的重试会
  返回原 session，若 case、设备、plugin manifest 或发起人等快照不一致则明确拒绝，避免重试
  在私有库中产生两条互相竞争的 debugger session。
- 带有效 `sessionId` 的设备 `debug.status` 事件会在验证 project/device 后更新私有 session；
  completed/failed/cancelled 等终态不会被乱序的后续设备事件回退，原始事件仍按 event id 幂等
  写入 observation。对于 completed/failed 终态，插件还会在私有 session 更新成功后，通过
  当前事件携带的 execution capability 关闭平台侧 `DebugExecution`；关闭前会核对私有
  session 的 `executionRef` 与 capability 的 execution ID。按 installation/device 路由的迟到旧
  session 事件因此只会记录 observation，不会误关闭同一设备后来启动的新 execution。
- session 创建时会校验并保存同一 installation/project 下的 target-config revision、target ID
  和可选 ELF/firmware artifact 引用；后续配置或上传新 artifact 不会改变已有 session 的输入快照。
- 私有 session、设备状态更新和 observation 查询均带 `installation_id` scope；SSR 页面可按查询参数选择
  session，并显示最近 16 条、按时间正序排列的有界 observation timeline（每条结构化数据最多 2,048 字符），不会把
  同一 project 下其他 installation 的会话混入页面；部署默认的 Plugin RPC 字符串预算为 512 KiB，仍低于
  默认 1 MiB frame 上限，并由 Manager/runtime 两端共同校验。
- 已知 session 已删除、installation 不匹配或设备不匹配的陈旧设备事件会记录 warning 并正常 ACK，避免
  durable event queue 因不可恢复的 scope miss 无限重试；其他私有数据库错误仍按可恢复故障抛出重试。
- `DeviceCommand` 已保存平台侧 provenance：`origin_type`、发起用户、plugin installation、
  plugin version/manifest hash、execution/correlation/idempotency 字段和取消请求时间；这些
  字段不进入设备下发的 MessagePack payload。Human API 显式批准的 action 记录为 `human` 来源；
  plugin/LLM 来源在入队前必须带 installation、版本和 manifest hash，避免出现无法归属的高权限命令。
- installation 被禁用、迁移或设备/profile 重新绑定时，同一事务会把旧的非终态 debug execution
  置为 `failed` 并释放 lease；broker lease 查询也会跳过已失效 execution 的排队 command，避免
  旧控制权继续触碰设备或阻塞该设备后续队列。
- execution command 的取消请求不会新增 MQTT 控制 topic：尚未投递的 queued command 直接进入
  `delivery_failed` 终态并释放队列；已经被 broker 接受的 command 只记录取消请求，最终能否在硬件阶段
  停止仍取决于设备固件的取消点，不能伪装成云端已经撤回。
- `device.cancel_command` 的 reverse RPC 与 enqueue 使用相同的 installation → device → execution
  锁顺序，并在 mutation 事务内重新检查 execution token、cancel capability、有效 lease 和发起人
  project membership；撤权或生命周期变更后不会继续标记 command。
- 专用 SoulInjector runtime 读取并校验 operation、WebSocket backpressure、idle timeout、
  value/blob budget 等环境上限；Compose 会把这些上限传入 plugin，不把 Manager 的限制误当成
  plugin 进程自身的隔离。
- Compose 将 core network、plugin-rpc network 和 SoulInjector plugin-private database network
  分开；plugin 不加入 core network，不能按服务名直连 Soulcloud PostgreSQL、Human API 或
  Device Broker。公网/peer-plugin egress 仍需生产 NetworkPolicy 复核。
- 未完成的分块上传由 plugin 私有 runtime 按批次、带索引地清理；这只清理临时 upload/chunk
  行，不替产品决定完整 artifact 的 retention/deletion 策略。

尚未实现：SoulInjector 设备固件 command handler、HTTPS 设备文件 gateway、Human API 的
pause/cancel/take-over 与 plugin 重启后的 capability 恢复、LLM harness，以及独立 plugin-origin
live channel。execution 绑定的 device enqueue/get/cancel 已有受限 reverse RPC 基础；设备终态事件
关闭平台 execution 的插件侧同步已接入，但设备固件 command/result producer 和完整设备结果闭环
仍未完成。不要
把上述未完成项误认为已经可以进行生产远程诊断。

## 3. 已确认的架构决定

### 3.1 Plugin 私有持久化

维修案例、调试会话、LLM 状态和报告属于 SoulInjector plugin 的产品业务数据，写入该
plugin 自己的私有数据库，不写入 Soulcloud PostgreSQL。

私有数据库要求：

- 使用独立数据库/cluster、credential、schema 和 network policy；
- credential 只注入 SoulInjector plugin，不注入 Plugin Manager、Human API 或其他 plugin；
- schema migration、backup、retention、restore 和容量由 plugin/部署系统负责；
- 可以保存 Manager 提供的 project、installation、device 和 user ID 作为外键式引用，但不能
  保存或伪造 Soulcloud credential；
- plugin 私有数据库中的记录不能授予 Soulcloud 权限。每次设备操作和用户入口仍由 Human API
  与 Plugin Manager 权威复核当前 scope；
- 私有数据库不可用只影响该 plugin，不应使 Human API、Device Broker 或其他 plugin 失败。

Soulcloud PostgreSQL 继续保存平台通用状态，例如 device identity/auth、project membership、
plugin installation/binding、DeviceCommand、短期执行授权及必要审计索引。已有 OTA/日志 ELF
表仍服务于原有平台功能，不把维修案例模型塞入其中。

### 3.2 Client-side Plugin UI

远程 terminal、寄存器视图、LLM 输出和多人观察需要 client-side JavaScript，因此目标 UI
同时支持：

- plugin 内 React SSR，负责首屏和无 JavaScript fallback；
- plugin 提供 immutable、content-hashed JavaScript/CSS bundle；
- Plugin Manager 校验并代理 asset；Human Web frontend 不 import plugin bundle；
- Browser 的实时 channel 终止在 Plugin Manager，Browser 不直连 plugin endpoint；
- Plugin Manager 不 import、hydrate 或执行 plugin React/client code。

plugin bundle 必须运行在与 Human Web/API 不同的 origin。当前 Web 将 refresh token 保存在
主站 `localStorage`；如果把 plugin JavaScript 放在同一 origin，路径隔离无法阻止它读取该
token。目标入口仍使用 `/plugins/{installation}/...`，但位于独立 plugin UI origin。

Human API 权威校验用户后签发一次性、短期、绑定 user/project/installation/route/version/hash
的 bootstrap grant；Browser 以 POST 或等价的不泄露 URL 方式交给 Plugin Manager，换取只在
plugin UI origin 有效、path-scoped、HttpOnly 的 session cookie。当前已实现最小 POST
\`/bootstrap\` grant 消费和基于 PostgreSQL 的原子 nonce replay 防护（可跨 Manager 重启和多实例），API 通过
\`PLUGIN_UI_ORIGIN\` 返回 bootstrap URL，
Traefik 需要把该独立 host（示例 \`plugins.example.com\`）路由到 Plugin Manager。Web 已有
\`/plugin-ui/:installationId/:routeId\` launch route，会以隐藏表单 POST grant 并跳转；生产环境
仍必须先配置真实 origin/DNS/证书，不能把示例域名直接投入使用。

## 4. 职责划分

### 4.1 SoulInjector 设备负责

- target cable/power/voltage/连接检测和本地屏幕提示；
- SWD、UART bootloader、reset/boot pin 和可选功耗测量；
- target identify、halt/resume/reset、register/memory/flash 操作；
- breakpoint/watchpoint 等实际硬件资源管理；
- 有界批量 debugger transaction；
- 本地 timeout、取消、安全清理和 transport release；
- 弱网期间保存当前 command 的必要进度，并对 QoS 1 重投递保持幂等；
- 小型结构化进度通过 `/event` 上报，大型 dump/trace 通过 HTTPS 上传；
- 不执行云端 plugin code、LLM、JavaScript 或动态下载的任意宿主程序。

### 4.2 SoulInjector plugin 负责

- repair/debug case、target unit 和业务状态；
- ELF/source/symbol 解析与 target-specific 知识；
- 人工 debugger UI、LLM harness 和诊断策略；
- 将高层意图转换成设备已实现的 debugger command；
- 关联 observation、artifact、hypothesis、tool call 和报告；
- 海外支持人员与国内工程师的 case assignment、comment 和 handoff；
- 自己的外部 LLM/provider credential、私有数据库和产品数据 retention；
- agent 预算、停止条件、模型/提示/tool 版本与失败恢复。

### 4.3 Plugin Manager 负责

- plugin 身份、version/hash、installation/device/user scope；
- 为长时间调试签发和验证有界 execution capability；
- 设备控制权 lease、command 权威校验、入队、取消和 provenance；
- scoped artifact transfer capability；
- `/plugins/*` session、asset 代理、实时 channel、限制和路由；
- 操作级 deadline、concurrency、bytes、rate、backpressure 和审计；
- plugin 不可用时返回明确错误，但不管理或重启其容器。

### 4.4 Human API 负责

- 人类用户登录、project membership、角色和权限权威；
- 签发 plugin UI bootstrap grant；
- 需要 Human API 权威确认的危险操作审批；
- 面向普通 API client 的稳定入口；
- 不解析 ELF、不运行 LLM、不加载 plugin UI code。

### 4.5 Device Broker 负责

- 继续处理现有 MQTT ACL、连接、command 和 `/event` 持久化；
- 不理解 debugger payload、case、ELF、LLM 或维修状态；
- 不同步调用 Plugin Manager/plugin；
- 不增加 debugger-specific MQTT topic。

## 5. 产品数据模型

以下是 SoulInjector plugin 私有数据库的建议最小概念，不是 Soulcloud Prisma schema：

```text
debug_cases
  id, project_ref, target_unit_ref, state, title, created_by_ref, assigned_to_ref

debug_sessions
  id, case_id, installation_id, soulcloud_device_ref, execution_ref, state
  plugin_version, manifest_hash, device_firmware_version
  target_config_id, target_config_revision, target_id, artifact_id
  started_by_ref, controller_ref, started_at, ended_at

debug_artifacts
  id, case_id, kind, sha256, size, content bytea, metadata

debug_observations
  id, session_id, source, kind, structured_data, artifact_ref, created_at

agent_runs
  id, session_id, model_provider, model_id, harness_version
  prompt_version, tool_schema_version, budget, state

agent_tool_calls
  id, run_id, tool, input_digest, command_ref, output_digest
  requested_at, approved_by_ref, completed_at

case_comments / case_assignments / case_reports / report_revisions
```

要求：

- artifact、observation 和已签署报告使用 hash/version，不静默覆盖；
- product state 可以更新，但关键操作采用 append-only audit event；
- 不保存 Human API JWT、plugin UI cookie、device password 或 Manager service token；
- 删除/retention 必须同时处理 DB metadata、blob 和备份策略；
- plugin upgrade 必须迁移自己的 schema，但历史 session 保留创建时 plugin/harness/model snapshot。

## 6. Device command 与 event 设计

### 6.1 不增加 MQTT topic

继续使用：

```text
平台 → 设备  soulcloud/v1/devices/{uid}/cmd/exec
设备 → 平台  soulcloud/v1/devices/{uid}/cmd/result
设备 → 平台  soulcloud/v1/devices/{uid}/event
设备 → 平台  soulcloud/v1/devices/{uid}/log
文件传输     HTTPS
```

`/event` 的 `data` 内可以带 `debugSessionId`、`commandId` 或 plugin case reference，但设备不在
envelope 顶层发送 plugin/installation/project ID。

### 6.2 第一轮高层 command 候选

精确名称、schema 和目标 MCU 支持矩阵必须在设备实现前冻结。当前 plugin 代码已经声明并编码
以下第一批高层命令；设备固件尚未实现，不能仅凭 manifest 认为设备支持：

```text
debug.identify
debug.halt
debug.resume
debug.reset
debug.read_registers
debug.read_memory
debug.start
```

当前 plugin manifest 不开放 `debug.flash_write`：artifact 虽可上传并保存在 plugin 私有库，
但 Soulcloud HTTPS device transfer gateway 和设备侧文件消费协议尚未完成，不能让一个没有传输
闭环的 action 伪装成可用能力。烧写功能继续复用或演进现有 erase/program/verify 能力，不因为
debugger plugin 建第二套下行协议。所有 command 都必须：

- 带幂等 command ID 和 execution/session correlation；manifest action 的 `wire.schemaVersion`
  目前由 Manager 在 encoder/reverse command 边界校验，但现有通用 `DeviceCommand` MessagePack
  envelope 没有独立的 schema-version 字段。设备 handler 开始前必须在 D0 冻结“沿用版本化 command
  名称”还是扩展通用 wire 字段，不能把当前 manifest 字段误认为已经传到了设备；
- 指定本地 timeout 和有界输入/输出；
- 支持取消点；无法立即取消的硬件阶段明确报告 `cancelling`；
- 失败后释放/恢复 SWDIO、reset、UART 和 target 运行状态到已定义状态；
- 不接收任意脚本、动态库、native code 或无限循环 procedure；
- 对 address、length、breakpoint count、poll count 和累计执行时间设硬上限。

### 6.3 本地批量操作

云端不能逐 SWD transaction 往返。`collect_snapshot` 等 command 允许一个有界、版本化的
debug request 描述需要收集的 register/memory region；设备本地完成实际低层操作并一次返回
summary 或 artifact reference。

这只是产品固件中的 debugger primitive，不是通用 workflow engine：

- 没有任意步骤图；
- 没有动态执行代码；
- 只有设备固件预先实现并校验的操作；
- 总操作数、地址范围、字节、轮询和 deadline 均有上限。

### 6.4 Event 与大量数据

候选 event kind：

```text
soulinjector.target_connected
soulinjector.target_disconnected
soulinjector.debug_progress
soulinjector.snapshot_ready
soulinjector.uart_batch
soulinjector.command_warning
soulinjector.session_finished
```

- progress/state/小型 register summary 使用 `/event`；
- 高频 UART 先在设备聚合为有界 batch；已有 `/log` 适合的日志继续走 `/log`；
- memory dump、core dump、长 trace 和大段 UART capture 走 HTTPS；
- MQTT event 只携带 artifact reference、sha256、size 和摘要；
- Manager/plugin unavailable 不影响 Broker ACK，event 仍通过 durable queue 异步消费。

## 7. 长时间 Execution Capability

当前短期 event/action/UI operation 继续保留，不延长成数小时。新增独立、持久但收窄的
debug execution record：

```text
id
installation_id
device_id
plugin_id / plugin_version / manifest_hash
initiating_user_id
state: active | paused | cancelling | completed | failed | expired
allowed_capabilities
device_lease_expires_at
expires_at
created_at / finished_at
```

它不是诊断步骤数据库，也不保存 LLM conversation。作用只有：

1. 证明某 plugin 当前可为某 device 执行哪些平台动作；
2. 维持单设备控制权；
3. 关联 DeviceCommand、用户、plugin snapshot 和审计；
4. 支持 pause/cancel/expiry 和 plugin crash 后的安全恢复。

建议 RPC 能力按阶段冻结为类似：

```text
context.executions.get
context.executions.renewLease
context.executions.release
context.executions.complete

context.devices.enqueueCommand
context.devices.cancelCommand
context.devices.getCommand

context.artifacts.getMetadata
context.artifacts.issueTransfer
```

当前 lifecycle RPC 使用的 capability 名称是 `execution.get`、`execution.renew_lease`、
`execution.release` 和 `execution.complete`。这些名称只控制平台 capability 生命周期，不等同于
`debug.read_memory` 或 `debug.reset` 等设备动作；后者仍须逐次经过 manifest 风险声明和 Human API
人工审批。

plugin 可在父 event/UI RPC 返回后凭 execution capability 继续调用，但 Manager 必须保存 token
hash，并检查 connection/plugin/version/installation/device/expiry/allowed capability/rate。不能退化为
一个 plugin 级永久万能 token。当前设备 command RPC 使用 `device.enqueue_command`、
`device.get_command` 和 `device.cancel_command`，只允许 manifest 声明的非破坏性命令；标记为
`requiresHumanApproval` 的命令会被拒绝，直到人工审批闭环和取消语义明确后再开放。

## 8. Artifact 与 HTTPS 传输

### 8.1 数据归属

- ELF、source archive、map、symbol、observation、LLM trace 和报告 metadata 默认属于 plugin
  私有存储；
- Soulcloud 原有 FirmwareArtifact/FirmwareRelease 只继续服务日志解码和 OTA，不自动成为
  plugin 业务数据库；
- 设备确实需要下载或上传的内容通过 Soulcloud scoped transfer gateway 暂存/代理；Soulcloud
  只保存传输所需的最小 metadata、hash、scope、expiry 和审计，不保存维修 case 语义。

### 8.2 传输要求

- 文件正文不经 MQTT，也不塞进普通 oRPC value；
- Human 上传先经过 Human API 权限检查，再交给 plugin 私有存储；
- plugin 请求 device transfer 时，Manager 验证 execution/device/artifact scope；
- Device 使用短期 HTTPS capability，绑定 device、execution、artifact、direction、size/hash；
- 支持流式处理、Content-Length 上限、SHA-256 和失败清理；
- 分块上传使用客户端提供的 `uploadId`（Human API 对应 `Idempotency-Key`）做幂等键；最终提交后在短期过期窗口内保留完成结果，
  响应丢失时重试同一 `uploadId` 必须返回同一个 artifact，而不能重新创建或破坏上传；
- 弱网需要时支持 Range/resume，但在有真实大文件纵切后再实现；
- MVP 的 plugin 私有 blob 固定使用独立 PostgreSQL `bytea`，不使用 local spool、S3 或其他对象存储；
  接口仍不能要求一次把大文件读入 Bun 或 ESP32 heap。

plugin 私有 blob 到 Soulcloud transfer gateway 是“push staging”还是“受控 pull proxy”，会影响部署
和失败语义，必须在设备文件传输阶段开始前确认；当前不改变已确认的 PostgreSQL `bytea` 存储决定。

## 9. Command provenance、控制权和审批

平台 DeviceCommand 已补充以下通用 provenance；长时间 execution record 已实现基础版：

```text
origin_type: human | plugin | llm_agent
origin_user_id?
plugin_installation_id?
plugin_version / manifest_hash?
execution_id?
correlation_id
idempotency_key
cancel_requested_at?
```

入队校验要求非 human 来源同时提供 plugin installation、plugin version 和 manifest hash；
provenance 只作为 Soulcloud 平台审计元数据保存，不改变现有设备 command wire contract。

每台设备同一时刻最多一个 debug execution 持有控制 lease。其他用户可以观察，但不能同时
改变 target 状态。人工接管必须原子转移 controller，并通知 plugin UI 与 LLM harness。

危险操作至少包括 erase、flash、write memory/register、改变保护位和 target configuration。
哪些动作允许全自动、哪些需要人工批准是产品策略，不能由 Plugin Manager 擅自决定。Manager
只提供：

- manifest 声明风险等级；
- Human API 权限与 approval proof；
- execution policy snapshot；
- command 前最终复核和不可变审计。

## 10. Plugin UI 与实时协作

### 10.1 页面

最小页面：

- case 列表、状态、assignment 和搜索；
- case detail：target/firmware/artifact、timeline、comment、报告；
- live debugger：连接状态、register/memory、breakpoint、UART、command history；
- LLM panel：当前 hypothesis、tool call、证据、预算、暂停/继续；
- overseas guided view：只显示接线、target detected、进行中、等待工程师和完成；
- approval dialog：危险操作、影响、发起者和目标 device。

### 10.2 实时 channel

```text
Browser
  ↕ plugin UI origin /plugins/{installation}/live
Plugin Manager
  ↕ scoped oRPC stream/call
SoulInjector plugin
```

要求：

- channel 绑定 UI session、user、project、installation、route、plugin version/hash；
- permission/session/install state 变化时关闭；
- 每连接和每 installation 有连接、消息、字节、速率和 queued-byte 上限；
- 慢 Browser 不拖住 plugin oRPC connection；允许丢弃可重建的 progress，但不能静默丢失
  approval、controller transfer 或 terminal state；
- 重连使用 cursor/event ID 补齐 plugin 私有数据库中的 durable timeline；
- bundle 不能读取主站 token，不能直接访问 Human API、Broker 或 device；
- plugin crash 只关闭该 plugin 的页面/channel，不影响其他 plugin 或 Human API。

## 11. LLM 调试 Agent

LLM harness 完全位于 SoulInjector plugin。Plugin Manager 不提供 prompt engine、memory、planner
或 workflow。

第一轮 tool 建议：

```text
get_case_context
inspect_elf_metadata
search_symbols
read_registers
read_memory
collect_snapshot
capture_uart
halt / resume / reset
request_human_approval
add_observation
propose_fix
```

要求：

- tool 只能调用 execution capability 允许的 Manager RPC；
- 模型不能自报 device/project/user scope；
- 每个 tool call 记录 model、harness、prompt、tool schema、输入/输出 digest、command 和审批；
- token、tool call、wall-clock、command、artifact bytes 和失败重试均有 budget；
- cancel/人工接管立即停止发起新 tool，正在执行的 device command进入定义的取消流程；
- LLM 输出是 hypothesis/suggestion，不能伪装成已观察事实；
- 自动修改源码和自动烧写不是初始范围。生成 patch 与实际 apply/flash 分开授权；
- 外部 LLM credential 只属于 plugin，不能进入 Manager 或 Soulcloud DB。

应先完成稳定的人工远程 debugger，再接入 LLM。否则无法区分模型错误、设备 primitive 错误和
网络/队列错误。

## 12. 权限和审计

Human API 不能继续给 plugin UI 固定空 permission snapshot。建议由产品确认并声明类似：

```text
debug.case.view
debug.case.edit
debug.observe
debug.control
debug.approve_destructive
debug.artifact.download
debug.report.review
debug.report.signoff
```

平台需要 project role/permission 的权威来源；plugin 私有 case assignment 可以进一步收窄，
不能放宽 Human API 权限。

必须审计：

- case/session 创建、assignment、人工接管和关闭；
- UI session/bootstrap、实时 controller 变化；
- artifact 上传/下载/hash；
- command 发起者、plugin/model snapshot、审批、投递和结果；
- LLM tool call 与人类 override；
- 报告生成、review、sign-off 和 revision。

常规 payload、源码和 memory dump 不应完整复制到平台审计日志；使用 ID/hash/size 和受控
artifact reference。

事件完成与 installation/device 生命周期锁在同一事务内判断 routing snapshot 是否仍为当前
binding：过期事件可以保留 history，但不能在迁移、禁用或换 profile 后继续提交旧的设备
command intent。

## 13. 分阶段实施

### 阶段 D0：产品契约冻结

**目标**：在改平台 schema 前固定第一个可用调试纵切。

工作：

1. 选择首批 target architecture/chip；
2. 列出设备现有 primitive 与缺失 primitive；
3. 冻结 command/event schema、最大内存范围、timeout 和取消语义；
4. 第一版只上传 ELF/firmware，source archive/VCS 后置；**已确认**；
5. 所有 destructive operation 均需人工逐次批准，LLM 不绕过 Human API approval；**已确认**；
6. plugin 私有 blob 使用独立 PostgreSQL `bytea`，不引入 S3/object storage；**已确认**；
7. 选定 plugin UI 独立 origin 与 bootstrap 流程。

退出条件：协议测试向量、错误码和设备安全终态有文档；不存在“任意脚本”或通用 workflow。

### 阶段 D1：SoulInjector Plugin 骨架与私有数据库

工作：

1. 创建独立 SoulInjector plugin package/image；**已完成基础版本**；
2. 建立 manifest、profile、Action、Event 和 UI route；
3. 建立私有 DB migration、target-config revision、artifact upload/chunk/bytea 以及
   case/session/observation/report revision 基础表；**已完成基础版本**；
4. 接入 Plugin Manager handshake 和 health；
5. Compose 开发部署加入 plugin 私有 DB，但不把 credential 给 Manager；
6. 测试 plugin DB failure/crash 不影响 Manager/Broker/Human API。

当前结果：target config、artifact 和最小 case/session/observation/report revision 数据在 plugin
私有 DB 重启后可恢复；artifact 可按 project scope 关联 case；plugin runtime 的资源上限可由
部署环境配置，未完成的 chunk upload 会自动过期清理。

对 `/home/hu/Projects/soul-injector` 的设备侧代码审查（2026-08-25）发现：当前源码仍有
`/soulinjector/v1/cmd/*` 与 `/soulinjector/v1/report/*` 的历史自定义 MQTT topic，以及旧的
`mq_cmd_pkt`/ArduinoJson 命令路径。这些只能作为迁移清单，不能作为新插件协议的兼容层；D2
必须把设备软件/固件改为现有 Soulcloud Device Broker 的 `/cmd/exec`、`/cmd/result`、
`/event`、`/log` 和 HTTPS 文件入口。当前工作树中 `components/esp-serial-flasher` 有未提交
修改，未在本计划审查中改动。

### 阶段 D2：设备联网与确定性 Debug Primitive

工作：

1. 将 SoulInjector 作为普通 Soulcloud Device 完成注册、认证、MQTT/WSS 和 HTTPS；**设备侧未完成**，且必须替换源码中历史 `/soulinjector/v1/*` topic，而不是保留双协议；
2. 实现冻结的高层 debugger commands；**plugin contract 已完成，设备 handler 未完成**；
3. 实现 target connected/progress/snapshot/finished events；**plugin status/log schema 已完成，设备 event producer 未完成**；
4. 实现 command 幂等、取消、本地 timeout 和安全 transport release；
5. 使用有界静态/初始化期 buffer，避免业务热路径不必要 heap allocation；
6. 验证断网、重投递、target 拔线和设备重启后的状态。

退出条件：不经过 plugin UI/LLM，也能用测试工具完成一次远程人工调试 primitive 纵切。

### 阶段 D3：Execution Capability 与 Command Provenance

工作：

1. 增加最小 debug execution 平台记录；**已完成基础版本**；
2. 实现 device control lease、renew/release/expiry；**已完成基础版本**；
3. 增加 command origin/execution/plugin/user correlation；**已完成基础版本**；
4. 实现 plugin 在短父 RPC 结束后的受限 execution lifecycle 与 device command RPC；**基础版本、同进程设备事件 capability 传递，以及已绑定 session 终态事件关闭平台 execution 已完成**；
5. Human API 实现 start/pause/cancel/take-over 权限入口；**start/session bootstrap 基础已完成，
   pause/cancel/take-over 及重启恢复仍未完成**；
6. 补并发 start、lease expiry、plugin reconnect、跨 device/project 和 cancel race 测试；**数据库
   集成测试以及 malformed bootstrap cleanup/并发冲突的边界测试已写入 CI，command cancellation
   的 membership race 也已覆盖；跨进程/真实 plugin
   reconnect 测试仍待补齐**。

退出条件：插件可以安全运行数小时 case，但 Manager 没有 step/DAG/agent state。

### 阶段 D4：Artifact 与设备文件传输

工作：

1. 实现 ELF/firmware metadata 与 plugin 私有存储；**已完成首版**；source metadata 留后续；
2. 实现 Manager scoped artifact metadata/transfer capability；**已完成 plugin-to-Manager 分块转发基础**；
3. 实现 Soulcloud HTTPS device transfer gateway；
4. 实现大小、hash、streaming、临时文件清理和失败恢复；
5. 大 snapshot/dump 上传后用 `/event` 通知；
6. 根据真实文件大小决定是否需要 Range，不引入对象存储作为前置条件。

退出条件：ELF 可供 plugin 分析，设备可安全下载所需固件/target config并上传 dump，正文不走
MQTT/oRPC 热路径。

### 阶段 D5：人工远程 Debugger MVP

工作：

1. case 创建、device/target/artifact 关联；**已完成私有 case 创建、artifact→case、target-config
   revision 存储，以及 execution→session 输入快照关联基础**；
2. SSR case/debugger 页面；**已完成最小 case 列表/创建、plugin-origin session 创建入口、session
   摘要、installation-scoped observation timeline、target 配置页面和基于 plugin-origin session
   的人工 action 控件、execution 发起人触发的 lease release/heartbeat 续租，以及受限的单条
   command cancellation；session
   控制闭环和实时状态 UI 仍待实现**；
3. 人工执行 identify/halt/read/reset/capture/close，并能在需要时释放当前 device lease；
4. command timeline、observation、错误与报告草稿；**报告草稿/修订/定稿基础、受限 command
   timeline 和失败/最新错误告警视图已完成**；
5. overseas guided view 和国内工程师 take-over；
6. 验证两个用户同时操作时只有 controller 能改变 target。

退出条件：不依赖 LLM，可以完成一次海外接线、国内工程师远程诊断、报告生成的端到端案例。

### 阶段 D6：Client Bundle 与实时 UI

工作：

1. 扩展 manifest UI asset 声明和 handshake capability；**已完成受限 asset RPC/manifest 基础**；
2. Manager 实现 asset fetch/hash/MIME/cache/独立 origin；**已完成 manifest hash/MIME/cache/
   代理和 dedicated-origin bootstrap 基础**；
3. 实现 Human API 一次性 bootstrap 和 plugin-origin session；**已完成 grant 签发、PostgreSQL
   原子单次消费、过期清理、path-scoped cookie 以及 Web 前端 POST/跳转**；
4. 实现 Browser ↔ Manager live channel 与 plugin oRPC stream/call；
5. 实现 terminal、progress、register/memory 和多人观察 UI；**当前已提供非实时的人工
   identify/read-registers/halt/resume/reset/start 控件，实时 channel 和完整视图仍待实现**；
6. 测试主站 token 不可见、session 撤销、慢消费者、backpressure、bundle 漂移和 plugin crash。

退出条件：Human Web 不 import plugin code；Browser 不直连 plugin；主站 refresh/access token
不暴露；实时 debugger 可重连恢复。

### 阶段 D7：LLM Agent MVP

工作：

1. 在 plugin 内实现 harness、tool registry、budget 和 cancellation；
2. 先开放只读工具，再逐项加入有明确审批的 destructive tool；
3. 保存 model/harness/prompt/tool snapshot 和完整证据关联；
4. 支持 agent pause、人类 take-over、继续和终止；
5. 生成包含事实、hypothesis、证据和修改建议的版本化报告；
6. 用已知故障固件建立可重复 evaluation corpus。

退出条件：agent 在固定测试集上能复现诊断过程；失败不会越 scope、无限重试或留下 target
处于未知调试状态。

### 阶段 D8：跨境维修产品化

工作：

1. case queue、assignment、comment、handoff 和通知；
2. 海外人员极简接线/状态 UI 与本地设备提示；
3. 国内工程师 observe/control/approval 流程；
4. 时区、locale、弱网和长时间离线恢复；
5. 报告 review/sign-off/export 和客户可见版本；
6. 数据 retention、访问审计和支持 SOP。

退出条件：非技术人员只需接线；case 可以跨时区交接；每次设备改变均可追溯。

### 阶段 D9：生产硬化

工作：

1. 长时间 soak：设备断线、Manager/plugin/DB 重启、MQTT 重投递；
2. chaos：plugin hang/OOM、私有 DB unavailable、LLM/API timeout；
3. 大 ELF/source/dump、UART flood 和多人 UI 压测；
4. command/event/artifact retention 和索引压测；
5. container CPU/RSS/PID/log、网络隔离、backup/restore 演练；
6. metric/alert：active execution、lease、command latency、event backlog、artifact bytes、agent cost；
7. 验证 plugin 无法访问 Broker、Soulcloud PostgreSQL、Device subnet 和 Human API internal
   endpoint。

退出条件：单个 plugin/LLM/私有 DB 故障不会拖垮核心 Soulcloud 服务或其他 plugin。

## 14. 明确不做

- 不建立 Station、Agent daemon 或工位身份；
- 不在 SoulInjector 设备上运行 plugin、容器、oRPC 或 LLM；
- 不建立 plugin ↔ device 直连；
- 不增加 debugger-specific MQTT topic；
- 不让云端逐 SWD bit/register polling round-trip；
- 不实现通用 workflow/DAG/step marketplace；
- 不让 Plugin Manager 保存 LLM conversation、case 或产品报告；
- 不要求现在引入对象存储、多 broker 或高频 telemetry 平台；
- 不在第一版自动修改源码并自动烧写；
- 不把 target MCU 注册成 Soulcloud Device，除非它本身独立联网并运行 Soulcloud 软件。

## 15. 实现前仍需产品负责人确认

以下选择仍会改变 wire、权限或部署，实施者不能自行决定：

1. 首批 target architecture/chip 具体值（代码保留 YAML 配置接口，不替产品选择）；
2. Soulcloud transfer gateway 采用 push staging 还是受控 pull proxy；
3. plugin UI 独立 origin 的具体域名、bootstrap 和 CSRF 方案；
4. case/artifact/LLM trace/report 的 retention 与客户删除语义；
5. 是否需要同时在线多个 plugin version 处理长时间未结束的历史 case。

已确认且不再阻塞当前实现的决定：第一版输入为 ELF/firmware，source archive/VCS 后置；所有
destructive operation 均需人工逐次批准；plugin 私有 blob 先存独立 PostgreSQL `bytea`，不
引入 S3/object storage。target architecture/chip 的具体选择仍由产品负责人决定，但必须通过
配置接口完成，不能由实施者擅自冻结。

当前每台 Soulcloud Device 只能绑定一个 plugin installation。SoulInjector 第一版只使用一个
SoulInjector plugin，因此不要求先修改为多 plugin fan-out；出现第二个真实消费方时再确认语义。
