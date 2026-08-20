# SoulcloudJS — 当前状态

> 本文档是 [docs/en/index.md](../en/index.md) 的中文翻译，与英文版结构一一对应；如内容冲突，以英文版为准。

**日期**: 2026-08-10 · **基线**: 596 个后端测试 + 221 个 web 单元测试全绿，
`tsc --noEmit` 干净，后端 + 浏览器 E2E 套件通过，CI 运行三个并行 job
（backend / web / web-e2e）。

SoulcloudJS 是用 Bun + TypeScript 重写的 Rust Soulcloud IoT 设备管理平台。
本文档集描述当前已有什么、它如何工作、以及哪些是刻意留待将来处理的。

## 话题

| 文档 | 覆盖内容 |
| --- | --- |
| [architecture.md](architecture.md) | 工作区布局、进程、进程间通信 |
| [database.md](database.md) | PostgreSQL schema、迁移、约束 |
| [mqtt-broker.md](mqtt-broker.md) | MQTT-over-WebSocket 消息代理、topic、设备认证/ACL、WS 适配器 |
| [command-queue.md](command-queue.md) | 持久化命令状态机、租约（lease）、投递超时 |
| [logging.md](logging.md) | on9log 二进制日志摄取（ingest）、ELF 固件产物、解码 |
| [protocol-log-packaging.md](protocol-log-packaging.md) | 面向固件的日志上行打包规格：分派容器（0x9a 原始 / 0x01 MessagePack 数组）、字节级示例 |
| [rest-api.md](rest-api.md) | REST 端点、错误映射、分页（pagination） |
| [authentication.md](authentication.md) | 人类用户 JWT 双令牌认证、设备按会话认证、凭据 |
| [security.md](security.md) | 威胁模型、DDoS 防护、审计历史（3 轮评审） |
| [testing.md](testing.md) | 测试策略、fixtures、CI |
| [web.md](web.md) | Web 控制台：技术栈、认证流程、页面、i18n、测试 |

## 快速事实

- **运行时**: Bun 1.4, TypeScript strict, 零原生依赖（只有 `jose`、`pg`、
  `elysia`、`zod`、`aedes`、`@msgpack/msgpack`、`mqtt-packet` 作为测试辅助）。
- **进程**: `@soulcloud/api` (REST, :8080)、`@soulcloud/broker`
  （MQTT over WebSocket, :1883/mqtt）和 `@soulcloud/web`（SPA, Vite :5173
  开发模式）——两个后端进程、一个 PostgreSQL、一个浏览器 UI。
- **进程间通信**: 仅 PostgreSQL（持久化出站队列（outbox）+ 租约轮询；
  LISTEN/NOTIFY 作为有损唤醒）。
- **协议**: MQTT 3.1.1 over WebSocket；命令使用 MessagePack payload；
  日志使用原始 on9log 包（单包或 MsgPack 打包——见
  [protocol-log-packaging.md](protocol-log-packaging.md)）。
- **认证**: 人类用户使用 JWT 双令牌（访问令牌 + 服务端刷新令牌）；设备
  使用按会话（per-session）MQTT 认证（绝不用 JWT）。
- **Web UI**: React 19 + Material UI 9，五种语言（zh/en/ru/uk/it），
  221 个单元测试 + 浏览器 E2E。
- **OTA**: 版本发布（release）→ 部署（per-device JWT over MQTT、HTTP 拉取）→
  三层目标状态机 → 带门控（gating）/停滞（stall）判定/回滚的分阶段滚动发布（phased rollout）。
