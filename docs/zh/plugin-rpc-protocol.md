# Plugin Manager ↔ plugin 双向 RPC 与 SSR 协议

**状态**：目标协议及当前实现边界；旧插件 RPC 代码和入口已删除
**日期**：2026-08-23

本文只规定独立 Plugin Manager 与云端 plugin instance 之间的通信。Soulcloud Client 不使用
该 RPC；设备继续通过 Device Broker 的 MQTT/WSS 和少量 HTTPS 通信。

## 1. 目标与非目标

目标：

- plugin code 永不进入 Plugin Manager、Human API 或 Device Broker 进程；
- 一条 oRPC/WebSocket 同时承载 Manager → plugin 和受限 reverse RPC；
- event、Action、Entity 和 SSR 使用同一身份、deadline、大小与并发边界；
- plugin crash/hang/OOM 只影响该 plugin；
- SSR React component 在 plugin 内执行，Manager 只校验和透传结果；
- PostgreSQL lease 支持多个 Manager replica；同一 plugin/version 多 endpoint/多副本路由尚未实现。

非目标：

- 不管理 plugin 容器生命周期；
- 不让 plugin 连接 Device Broker、Device、DB 或本地硬件；
- 不把设备 MessagePack 改成 JSON/oRPC；
- 不实现用户运行时安装；
- 不实现 React hydration、RSC framework 或 plugin client bundle；
- 不保留旧 HTTP MessagePack RPC、Dispatcher/Host endpoint 或兼容 alias。

## 2. 拓扑与连接方向

Plugin Manager 根据部署配置主动连接 plugin；plugin 不反向发现 Manager：

```text
Plugin Manager                         plugin instance
      │                                      │
      │──── WebSocket /rpc/ws ──────────────▶│
      │──── system.handshake ───────────────▶│
      │◀─── manifest + identity + limits ────│
      │                                      │
      │──── plugin/action/ui call ──────────▶│
      │◀─── scoped reverse calls ────────────│
      │◀─── result / HTML fragment ──────────│
```

每个 Manager replica 可以连接每个 endpoint。相同 plugin/version 的多个 instance 必须返回
相同 canonical manifest hash。reverse call 沿父 operation 所在的同一 WebSocket 返回，不能
被发送到其他 Manager replica。

开发或可信容器网络默认使用 `ws://`；跨主机部署使用 `wss://`。两者都必须认证，不能因为
没有 TLS 就允许匿名连接。

## 3. oRPC 组合

使用 oRPC v2，单 WebSocket 双 prefix：

```text
soulcloud:m2p:v1:    Manager → plugin
soulcloud:p2m:v1:    plugin → Manager
```

prefix 必须在解码前验证，未知 prefix/frame 关闭连接。一个方向的 request ID 不能被另一方向
消费。普通值使用 oRPC JSON serializer；`Uint8Array` 在 RPC adapter 转为有界 Blob，进入
SDK/plugin 前恢复为 `Uint8Array`。

契约包只包含类型、schema、错误和 binary adapter：

```text
packages/plugin-rpc-contract/
  manager-contract.ts
  plugin-contract.ts
  schemas.ts
  errors.ts
  binary.ts
```

它不得依赖 Prisma、Human API auth、部署 secret 或 plugin implementation。

## 4. Handshake 与 manifest

连接建立后第一条业务 procedure 必须是 `system.handshake`：

```ts
interface PluginHandshakeResult {
  rpcProtocolVersion: 1;
  pluginApiVersion: number;
  pluginId: string;
  pluginVersion: string;
  manifest: unknown;
  manifestHash: string;
  capabilities: {
    reverseRpcVersion: 1;
    blob: boolean;
    ssr: false | { version: 1; streaming: boolean };
  };
}
```

Manager 必须：

1. 对照 endpoint 配置检查 plugin ID；
2. 校验 RPC/Plugin API version；
3. 对 manifest 做 canonical serialization 后自行计算 hash，不信任 plugin 自报 hash；
4. 校验 manifest schema、数量、字符串和总字节上限；
5. 与 DB 中同 ID/version snapshot 比对；
6. hash 不同则拒绝连接，不覆盖旧 snapshot；
7. handshake 完成前拒绝所有其他 procedure/reverse call。

manifest 是唯一声明来源。Human API 和 Manager binary 不编译第二份 registry。

## 5. Manager → plugin procedure

第一版：

```text
system.handshake
system.ping
plugin.handleEvent
action.encode
ui.render
ui.handleAction
```

### 5.1 `plugin.handleEvent`

输入是 Device Broker 已持久化 event 的 immutable routing snapshot：

```ts
interface HandleEventInput {
  operationId: string;
  operationToken: string;
  deadlineMs: number;
  event: {
    id: string;
    seq: bigint;
    kind: string;
    schema: number;
    receivedAt: string;
    payload: unknown;
  };
  installation: {
    id: string;
    projectId: string;
    pluginId: string;
    pluginVersion: string;
    config: unknown;
  };
  device: {
    id: string;
    uid: string;
    profileId: string;
    profileVersion: number;
  };
}
```

plugin 返回有界 Entity updates、logs 和声明式副作用 intent。Manager 做最终 schema/scope
校验，并只在父调用成功后与 event completion 同事务提交。

### 5.2 `action.encode`

输入已由 Human API/Manager 按 manifest Action schema 校验。plugin 只编码现有
DeviceCommand；Manager 再以核心 DeviceCommand schema 权威复检。用户输入错误映射 400，
plugin encoder 输出错误映射 502，不能混淆。

### 5.3 `ui.render`

React component 在 plugin 进程内执行。输入只含 route、params 和最小用户/installation
上下文：

```ts
interface PluginUiContext {
  requestId: string;
  installationId: string;
  projectId: string;
  user: {
    id: string;
    locale: string;
    permissions: string[];
  };
  routeId: string;
  params: Record<string, string | number | boolean>;
}
```

禁止传递长期 JWT、cookie、数据库对象、任意 request header 或未经过 route schema 的 query。

当前结果是有界 HTML fragment，并为以后更透明的 SSR pass-through 保留 capability：

```ts
interface PluginSsrMeta {
  mode: "fragment";
  title?: string;
  status?: number;
  cache?: "no-store" | { maxAgeSeconds: number };
}
```

未来启用 HTML stream 时必须受 deadline、chunk、累计字节和 backpressure 限制。Manager 生成公共 document
shell、CSP 和错误页。plugin 不能设置 cookie、CORS、CSP、redirect target 或任意响应 header；
允许的 title/status/cache metadata 仍由 Manager 校验。

第一版不传 client bundle，不 hydration。表单提交进入 Manager 的 `/plugins/*` action route，
再调用 `ui.handleAction`。该 procedure 返回 redirect intent、validation errors 或重新渲染所需
状态，不能直接绕过 Human API 权限创建 Soulcloud 副作用。

## 6. Plugin → Manager reverse procedure

当前已实现：

```text
context.entities.get
context.commands.enqueue
```

contract 已保留但生产 handler 尚未实现：

```text
context.plugins.callScoped
context.ui.getData
```

所有 reverse input 必须携带：

```ts
interface OperationProof {
  operationId: string;
  operationToken: string;
}
```

不得携带或覆盖 project/installation/device/user scope。Manager 从 active operation registry
恢复这些字段。

### 6.1 Entity read

plugin 只传 `entityKey`。Manager 验证 active operation/token/connection、Entity 归属、当前
profile revision、deprecated 状态、结果 schema 和 reverse call budget。

### 6.2 Command enqueue

plugin 只传 command + arguments，不传 target device。Manager 固定使用父 operation device，
验证 DeviceCommand，并先暂存 intent。只有父 operation 成功时才提交；失败、timeout 或 socket
关闭时全部丢弃 staged intent。

### 6.3 Scoped plugin-to-plugin

涉及 project、installation、device、Entity、Command、用户数据或当前 operation 的跨 plugin
调用必须经 `context.plugins.callScoped`。Manager 验证 caller、找到 target plugin/version、
派生更窄的短期 capability，并限制调用深度、fan-out、并发、deadline 和字节。

plugin 可直接访问公网 API，也可直接调用其他 plugin 的无租户/纯计算接口；这类直连不能携带
Soulcloud project/device/user identity，不能调用 Manager reverse RPC。

### 6.4 UI data

SSR plugin 需要 Soulcloud 数据时使用 `context.ui.getData`，由 Manager 结合 Human API 已签发
的 permission snapshot 和当前 UI operation scope 校验。plugin 不得使用浏览器 token 直接
调用 Human API。

## 7. Operation capability

每次 `handleEvent`、`action.encode`、`ui.render` 或 `ui.handleAction` 创建 active operation，
至少保存 connection、plugin/version、installation/project、可选 device/user、monotonic
deadline、reverse budget、staged effects 和 active/sealed/discarded 状态。

operation token 不可猜测，只传明文一次，Manager 只存 hash。校验顺序：格式 → operation →
constant-time token compare → connection/plugin/version → deadline/state → scope → operation limit
→ global limit。

父调用返回前 seal operation，拒绝未完成的 reverse call；等待有界 cleanup grace 后再 commit。
这样 plugin 不能启动未 await 的 reverse call，在父响应后偷偷产生副作用。

## 8. 用户上下文与 `/plugins/*`

Human API 是用户权限权威：

```text
Browser → Human API: request plugin UI session
Human API → Browser: path-scoped HttpOnly cookie + /plugins/* URL
Browser → Plugin Manager /plugins/* (cookie is sent automatically)
Manager → plugin ui.render
```

session 至少绑定 audience、user、project、installation、plugin/version/manifest hash、route、
permission snapshot、locale、issued/expiry 和 nonce。Manager 不接收长期用户 JWT；session 不可
跨 route/installation 重放，权限变化、plugin 升级或 installation disable 后必须失效。

session 不放在 URL query、fragment、plugin HTML 或长期浏览器存储中。cookie 只覆盖对应
`/plugins/{installation}/` 路径，因此普通导航与无 JavaScript form 可以工作，而 plugin 仍看不到
token。

传给 plugin 的用户上下文遵循最小化原则，不默认包含 email、全局角色或其他个人信息。

## 9. Public API egress 与网络边界

plugin 可以访问 weather、map、geocoding、厂商云等公网 API，并可持有只属于自己的外部服务
credential。要求：

- credential 按 plugin instance 注入，Manager 不接收或转发；
- 外部调用有 connect/request timeout、response limit 和连接池上限；
- 外部服务失败归类为 plugin/remote dependency error，不拖垮 Manager；
- plugin 网络禁止访问 Broker、DB、Device subnet、Human API internal endpoint 和 cloud
  metadata endpoint；
- direct plugin-to-plugin endpoint 由部署配置明确暴露，不能通过任意 URL 代理制造 SSRF。

## 10. Deadline、取消与 liveness

每个父调用由 Manager 用本地 monotonic clock 保存绝对 deadline；wire 的 `deadlineMs` 是发送时
剩余预算，不是跨进程可比较的绝对时钟。reverse call 不能延长父 deadline。到期后 Manager
abort 本地请求、discard operation/staged effects，并按错误类别 retry/dead-letter。连接是否
失效由 WebSocket、heartbeat 和 connect timeout 判断，应用不因单次业务 timeout 杀进程。

Manager 不 kill/restart plugin。`system.ping` 只检测连接和 plugin event loop；真正 liveness
restart 由 Docker/systemd/Kubernetes 执行。

## 11. 大小、并发与 backpressure

以下全部由部署配置给出硬上限：

- WebSocket frame、JSON depth/nodes/array/string；
- Blob count、per-Blob 和 operation total bytes；
- active operations 和 pending requests；
- global/per-plugin/per-installation concurrency；
- reverse global/per-plugin/per-installation/per-operation concurrency；
- reverse call、staged command 和 log 数量；
- SSR chunk、total HTML、render concurrency 和 queued bytes；
- socket send-side queued bytes 和 reconnect rate。

Bun `ServerWebSocket.send()` 返回值和 `drain` 必须接入 transport bridge。超过 backpressure
上限不能继续排队或复制 payload，应终止对应 operation/connection。

## 12. 输出校验和事务

```text
plugin implementation
  → plugin-side output schema/preflight
  → oRPC contract output schema
  → Manager authoritative domain validation
  → staged effects
  → parent success
  → one DB transaction
```

plugin-side validation 只是快速反馈，不能代替 Manager。Entity descriptor revision、Action、
DeviceCommand、scope、大小和 installation state 均由 Manager 最终校验。

## 13. 错误分类

| 类别 | 示例 | event | circuit breaker |
| --- | --- | --- | --- |
| 用户输入错误 | Action/UI form schema 不合法 | 不适用/400 | 不计入 |
| 永久 plugin 输出错误 | 未知 Entity、坏 command、坏 SSR metadata | dead/502 | 不计入 infrastructure breaker |
| 永久设备数据错误 | 未声明 event/schema、payload 不合法 | dead | 不计入 |
| 瞬时 plugin/transport | timeout、disconnect、overload、crash | retry | 计入对应 plugin |
| 外部依赖失败 | weather/map/vendor API timeout | 按 plugin 声明类别 | 不影响其他 plugin |
| Manager 内部错误 | DB unavailable、transaction failure | retry | 不归咎 plugin |

错误必须保留来源，不能统一包装成 `internal_error`。

## 14. 配置草案

旧 `PLUGIN_HOST_*`/`PLUGIN_DISPATCHER_*` 名称直接删除。目标命名：

```text
PLUGIN_ENDPOINTS=plugin.id=ws://plugin-id:8090/rpc/ws
PLUGIN_MANAGER_INTERNAL_BIND=0.0.0.0
PLUGIN_MANAGER_INTERNAL_PORT=8091
PLUGIN_MANAGER_SERVICE_TOKEN=...
PLUGIN_MANAGER_UI_SESSION_SECRET=...
PLUGIN_RPC_AUTH_TOKEN=...

PLUGIN_RPC_MAX_FRAME_BYTES=...
PLUGIN_RPC_MAX_OPERATIONS=...
PLUGIN_RPC_MAX_PENDING_REQUESTS=...
PLUGIN_RPC_MAX_REVERSE_CALLS=...
PLUGIN_RPC_BACKPRESSURE_BYTES=...
PLUGIN_RPC_HEARTBEAT_INTERVAL_MS=...
PLUGIN_RPC_HEARTBEAT_TIMEOUT_MS=...
PLUGIN_RPC_CONNECT_TIMEOUT_MS=...

PLUGIN_EVENT_POLL_INTERVAL_MS=...
PLUGIN_EVENT_LEASE_MS=...
PLUGIN_EVENT_BATCH_SIZE=...
PLUGIN_EVENT_MAX_CONCURRENCY=...
PLUGIN_EVENT_TIMEOUT_MS=...
PLUGIN_EVENT_MAX_ATTEMPTS=...
PLUGIN_EVENT_RETENTION_DAYS=...
PLUGIN_ENTITY_HISTORY_RETENTION_DAYS=...
PLUGIN_RETENTION_BATCH_SIZE=...
PLUGIN_RETENTION_MAX_BATCHES=...

PLUGIN_SSR_TIMEOUT_MS=...
PLUGIN_SSR_MAX_HTML_BYTES=...
PLUGIN_SSR_MAX_CONCURRENCY=...
```

具体默认值由现有实测和部署规模确定，不属于 wire protocol。

## 15. 测试要求

- handshake：ID/version/API/hash mismatch、超大/畸形 manifest；
- transport：双 prefix、未知 frame、断线、backpressure、heartbeat、reconnect；
- operation：过期 token、跨连接/project/device、seal 后 reverse call；
- Entity/Action：正常、坏 schema、坏 encoder、transaction rollback；
- event：QoS 1 duplicate、lease recovery、retry/dead、fairness；
- plugin-to-plugin：纯计算直连与 scoped Manager call 的边界；
- SSR：权限不足、过期 session、HTML 上限、stream 中断、timeout、坏 status/header；
- chaos：plugin crash/hang/OOM 不影响 Manager 其他 plugin、Human API 或 Broker；
- multi-replica：两个 Manager 连接同 plugin、event 只完成一次、reverse 返回正确连接；
- deployment：plugin 能访问公网 API，但不能访问 Broker/DB/Device/internal Human API。

## 16. 当前落地与后续原则

- 历史 Dispatcher/Host 实现、入口、endpoint、环境变量和兼容 alias 已删除；当前
  `plugin-manager`、`plugin-runtime`、SDK 和 RPC contract 是全新实现；
- 编译期 manifest/worker 双 registry 已删除，唯一声明来自 handshake + immutable snapshot；
- Station/workflow/device-side plugin runtime 不属于当前系统；
- 已落地的 oRPC transport、operation capability、event queue、Entity transaction、retry、
  retention 和 circuit-breaker 继续遵守本协议；
- 后续只在本协议和最新实施计划上增量实现阶段 7–8，不恢复旧设计或建立双轨兼容。
