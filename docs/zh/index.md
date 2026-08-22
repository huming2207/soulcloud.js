# SoulcloudJS — 当前状态

> 本文档是 [docs/en/index.md](../en/index.md) 的中文翻译，与英文版结构一一对应；如内容冲突，以英文版为准。

**日期**: 2026-08-21 · **基线**: 698 个后端非 E2E 测试 + 226 个 web 单元测试全绿，
`tsc --noEmit` 干净，后端 + 浏览器 E2E 套件通过，CI 运行三个并行 job
（backend / web / web-e2e）。插件系统阶段 1+2 已实施（见
[plugin-implementation-stage1-2.md](plugin-implementation-stage1-2.md)）。

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
| [plugin-and-station-architecture.md](plugin-and-station-architecture.md) | 商用设备插件、工业 Entity、插件隔离、烧录工位和弱网通信规划（仅中文提案） |
| [plugin-implementation-stage1-2.md](plugin-implementation-stage1-2.md) | 插件系统阶段 1+2 实施记录：SDK、编译期注册表、entity 模型、事件队列、dispatcher/host 容器隔离（仅中文） |
| [plugin-rpc-protocol.md](plugin-rpc-protocol.md) | Dispatcher ↔ Plugin Host 的 oRPC v2/WebSocket 双向 RPC 协议、资源治理和兼容迁移计划（已实施基础 transport，保留 HTTP 兼容） |

## 快速事实

- **运行时**: Bun 1.4, TypeScript strict, 零原生依赖（只有 `jose`、`pg`、
  `elysia`、`zod`、`aedes`、`@msgpack/msgpack`、`mqtt-packet` 作为测试辅助）。
- **进程/容器**: `@soulcloud/api` (REST, :8080)、`@soulcloud/broker`
  （MQTT over WebSocket, :1883/mqtt）、`@soulcloud/plugin-dispatcher`
  （插件事件调度）和按插件拆分的 `@soulcloud/plugin-host` 容器，以及
  `@soulcloud/web`（SPA, Vite :5173 开发模式）和 PostgreSQL。
- **进程间通信**: 核心进程之间仅 PostgreSQL（持久化出站队列（outbox）+ 租约轮询；
  LISTEN/NOTIFY 作为有损唤醒）；dispatcher 与 plugin-host 之间为容器网络上的
  oRPC v2 双向 WebSocket（`PLUGIN_HOST_ENDPOINTS`）；HTTP MessagePack-RPC
  （`PLUGIN_HOST_URLS`）作为迁移兼容路径（§6.5）。
- **协议**: MQTT 3.1.1 over WebSocket；命令使用 MessagePack payload；
  日志使用原始 on9log 包（单包或 MsgPack 打包——见
  [protocol-log-packaging.md](protocol-log-packaging.md)）。
- **认证**: 人类用户使用 JWT 双令牌（访问令牌 + 服务端刷新令牌）；设备
  使用按会话（per-session）MQTT 认证（绝不用 JWT）。
- **Web UI**: React 19 + Material UI 9，五种语言（zh/en/ru/uk/it），
  226 个单元测试 + 浏览器 E2E。
- **OTA**: 版本发布（release）→ 部署（per-device JWT over MQTT、HTTP 拉取）→
  三层目标状态机 → 带门控（gating）/停滞（stall）判定/回滚的分阶段滚动发布（phased rollout）。
