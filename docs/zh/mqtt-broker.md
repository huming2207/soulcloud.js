# MQTT 消息代理（MQTT Broker）

> 本文档是 `docs/en/mqtt-broker.md` 的中文翻译，结构与其一一对应；如有出入以英文版为准。

## 传输：仅 MQTT over WebSocket

broker 在 `ws://host:port/mqtt` 提供 **MQTT 3.1.1 over WebSocket**（端口和路径可配置：`MQTT_BROKER_PORT`、`MQTT_BROKER_PATH`）。原始 TCP 在审计修复 S8 中移除。TLS 在 WS 端点前的反向代理处终结。

为什么自定义 WS 适配器（`packages/broker/src/mqtt/ws-adapter.ts`）：`ws` npm 包（aedes-server-factory / websocket-stream 所用）在 Bun 下**不受支持**（`createWebSocketStream` 会抛异常）。该适配器：

- 将 Bun 原生 WebSocket 消息桥接为 Node 风格的 `Duplex`，供 `aedes.handle` 消费
- 将 mqtt-packet 的多段 `write()` 输出重组为**每个 MQTT 包一个 WS 帧**（MQTT-over-WS 规范要求如此）
- 当 aedes 销毁流时关闭 WS（aedes 使用 `destroy()`，触发 `'close'` 而非 `'final'`）
- 将 `ws.send() < 0`（socket 缓冲区满）报告为流错误，使 aedes 永远不会在 QoS 1 帧被丢弃时误认为已投递（背压，审计修复）

握手（handshake）、掩码、分片和 ping/pong 由 Bun 原生 WebSocket（uWS 内核）处理。

## 主题（Topics，v1）

| 方向 | 主题 | 状态 |
| --- | --- | --- |
| 平台 → 设备 | `soulcloud/v1/devices/{uid}/cmd/exec` | 已实现（命令投递） |
| 平台 → 设备 | `soulcloud/v1/devices/{uid}/ota` | 已实现（OTA 通知：版本发布/任务元数据 + 每设备下载 JWT；设备自行通过 HTTP 获取 bin） |
| 设备 → 平台 | `soulcloud/v1/devices/{uid}/ota/result` | 已实现（下载/安装/失败确认驱动目标状态机） |
| 设备 → 平台 | `soulcloud/v1/devices/{uid}/cmd/result` | 已实现（幂等结果记录） |
| 设备 → 平台 | `soulcloud/v1/devices/{uid}/log` | 已实现（原始 on9log 摄取） |
| 设备 → 平台 | `soulcloud/v1/devices/{uid}/stat` | 已实现（校验；持久化 `fw` → device_firmware_state） |

主题常量/解析/校验集中在 `packages/core/src/protocol/topic.ts`。合法设备 UID 非空，且不含 `/`、`+`、`#` 或空白。

## 设备认证与授权（Device authentication and authorization）

`packages/broker/src/mqtt/broker.ts`：

- **身份绑定（审计修复 S1/S2）**：MQTT `clientId` 必须等于 `username`（设备 UID），并通过 `isValidDeviceUid`。所有授权信任 `client.id`；没有这个绑定，任何持有凭据的人都能冒充任何其他设备（包括通配符 clientId）。
- **认证（Authenticate）**：按 UID 查找 `devices`，拒绝 `auth_revoked` 设备，验证 argon2id 密码（`verifyDevicePassword`）。认证失败有固定 100 ms 延迟（暴力破解节流）；数据库故障返回 CONNACK code 3（服务器不可用）而非 code 4。
- **authorizePublish**：设备只能发布（publish）到自己的上行主题（`cmd/result`、`log`、`stat`）；服务端发布（`client === null`）放行；超大 payload 被提前拒绝（在 dispatch 中可配置的 `UPLINK_MAX_PACKET_BYTES` 检查之前，先过 256 KB 上限）。
- **authorizeSubscribe**：设备只能订阅（subscribe）自己的**下行**主题（`cmd/exec`、`ota`）——不能回环订阅自己的上行。

## 上行分派（Uplink dispatch）

`packages/broker/src/mqtt/dispatch.ts` 路由设备消息：

- `cmd/result` → 严格 MessagePack 解码 → `recordDeviceResult`（幂等）
- `log` → 容器分派（`packages/core/src/logging/container.ts`：首字节 0x9a = 原始 on9log 包，0x01 = on9log 包的 MsgPack 聚合）→ 每个元素经校验后作为独立的原始事件存储（热路径，无 ELF 工作；单个坏元素被丢弃，包其余部分存活）
- `stat` → 严格解码 → upsert `device_firmware_state`（fw 哈希）

每设备防护（DDoS）：`UPLINK_MAX_PACKET_BYTES`（默认 64 KB）和令牌桶限流器（`UPLINK_RATE_PER_SECOND` 20、`UPLINK_RATE_BURST` 100）——超限丢弃并记录日志，绝不缓冲。

## 命令发布（Command publication）

`packages/broker/src/mqtt/publish.ts` 运行轮询周期：

1. 使超期命令过期（`delivery_failed`，见命令队列文档）
2. `leaseNext` 认领最旧的可认领命令
3. 如果设备**离线，不发布**——延迟该命令（重试延迟 `offlineRetryMs`，默认 5 s），而不是让它在 `broker_accepted` 滞留（审计修复 M2）
4. QoS 1 下 `aedes.publish()`；回调成功**即** broker 接受（嵌入式 broker——无外部 PUBACK 往返）
5. `markBrokerAccepted`

## LISTEN/NOTIFY

`packages/broker/src/mqtt/notify.ts` 运行一条专用 pg 连接，LISTEN 两个通道（出错后用全新 `Client` 重连）：

- `soulcloud_commands` → `poller.wake()`（立即轮询）
- `soulcloud_credentials_revoked` → `kickDeviceSession()`（终止活动会话）

## 会话终止（Session kill，G 组）

`kickDeviceSession(aedes, deviceUid)` 关闭设备的 Aedes client（身份绑定使 clientId == 设备 UID）。API 吊销（revocation）端点在一个事务内写 `auth_revoked = true` 并 `pg_notify` UID；broker 踢掉活动会话。如果通知丢失，重连仍会被拒绝。

## 已知限制（Known limitations）

- 在线会话吊销依赖 NOTIFY 到达 broker（按设计有损）；重连拒绝路径是正确性兜底。
- 未实现 MQTT 5、QoS 2 和保留消息策略（QoS 1 足够；retain 可通过 `MQTT_COMMAND_RETAIN` 配置）。
- 滚动发布（rollout）的阶段通过同一机制创建普通 ota_jobs——broker 不感知滚动发布（按设计；见滚动发布文档）。
