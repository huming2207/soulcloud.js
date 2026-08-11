# SoulcloudJS 架构

> 本文档是 [docs/en/architecture.md](../en/architecture.md) 的中文翻译，与英文版结构一一对应；如内容冲突，以英文版为准。

## 概览

SoulcloudJS 是一个 Bun workspace monorepo，包含三个包：

```
soulcloudjs/ (Bun workspace)
├── packages/core/    @soulcloud/core     Shared library (not deployable)
├── packages/api/     @soulcloud/api     REST API server (Elysia, :8080)
└── packages/broker/  @soulcloud/broker   MQTT-over-WebSocket broker (Aedes, :1883/mqtt)
```

两个可部署进程、一个共享库——沿用了原始 Rust 布局（api + worker + core），
但把消息代理（broker）内嵌进来，而不是使用外部 MQTT 服务器。

## 为什么是两个进程（而不是一个）

- **事件循环隔离**: Bun 每个进程是单线程的。MQTT 路由和 HTTP 流量不能互相
  饿死；设备数量上来后，共享事件循环会同时拖累两者。
- **独立扩缩容**: API 和消息代理可以各自独立扩展。多个消息代理实例通过
  PostgreSQL 租约锁定（lease locking）（`FOR UPDATE SKIP LOCKED`）协调。
- **故障隔离**: 消息代理崩溃不会拖垮 web API。

## 进程间通信

刻意**没有直接 IPC**。PostgreSQL 是唯一通道：

```
api enqueueBatch ──▶ device_commands (durable outbox)
                          │
broker leaseNext ◀── (poll every 500ms, or LISTEN/NOTIFY wake-up)
                          │
broker aedes.publish ──▶ device ──▶ cmd/result
                          │
broker recordDeviceResult ──▶ device_commands (result fields)
```

- `LISTEN/NOTIFY`（`soulcloud_commands`）只是**有损唤醒提示**：
  轮询器总能从持久化的行中恢复。通知丢失只损失延迟，不损失正确性。
- `LISTEN/NOTIFY`（`soulcloud_credentials_revoked`）唤醒消息代理去杀掉
  已吊销（revoked）设备的存活会话；即使丢失，吊销依然拒绝重连。
- Redis / 其他消息代理被刻意排除；只有当实测负载证明 PostgreSQL 不够用时
  才会引入。

## 进程边界

| 组件 | 拥有 | 禁止 |
| --- | --- | --- |
| `@soulcloud/api` | REST API、认证（JWT）、设备凭据管理、ELF 上传、日志查询、滚动发布推进循环（仅 DB 轮询器） | 不跑 MQTT 事件循环、不直接连接设备 |
| `@soulcloud/broker` | Aedes 消息代理、设备认证/ACL、上行分派（dispatch）、命令轮询器、会话击杀 | 不提供面向人类的 HTTP API |
| `@soulcloud/core` | Prisma client、协议编解码（codec）、队列逻辑、on9log 解析、ELF 解析、密码/认证原语 | 不可部署 |

## 关键文件

- `packages/core/src/index.ts` — 共享库的公开表面
- `packages/core/src/db.ts` — Prisma client 单例（生成客户端的唯一导入处）
- `packages/api/src/index.ts` — API 入口；绑定 host:port（支持 IPv6），
  通过 `app.stop()` 优雅关停
- `packages/broker/src/index.ts` — 消息代理入口；装配 broker + dispatch +
  poller + notifier
- `packages/broker/src/mqtt/ws-adapter.ts` — Bun 原生 WebSocket 传输
  （见 MQTT broker 文档）

## 配置

环境变量在启动时用 Zod 校验（类型化、可操作的失败信息）。参见
`.env.example`；必需：`DATABASE_URL`。API 额外要求 `JWT_*`；
消息代理额外要求 `MQTT_*`、`COMMAND_*`、`UPLINK_*`。

## 开发

```sh
docker compose up -d --wait postgres
bun install
bun run db:migrate     # or db:deploy
bun run dev            # api + broker with --watch
bun test               # 243 tests
bun run typecheck      # tsc --noEmit
```
