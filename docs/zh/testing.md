# 测试与质量（Testing & Quality）

> 本文档是 `docs/en/testing.md` 的中文翻译，与英文版一一对应。

**基线**：后端 642 个测试、51 个文件（隔离的 `soulcloud_test` 数据库，串行 `--isolate` 执行）+ 前端 226 个单元测试、36 个文件，`tsc --noEmit` 干净，oxlint 干净，CI 硬编码中文（CJK）扫描（scripts/scan-hardcoded-i18n.sh）通过。E2E 脚本（命令循环、日志摄取、OTA、滚动发布、web <-> API）全部通过。

## 策略

- **单元测试**覆盖确定性逻辑：协议编解码（MessagePack、on9log 包、SLIP）、printf/fmt 渲染器、ELF 解析（合成 ELF 构造器，覆盖 ELF32/64、LE/BE、PT_LOAD、`.noload`、畸形输入）、限流器（注入时钟）、密码哈希。
- **集成测试**针对真实 PostgreSQL（本地 Docker 或 CI 服务）：命令队列状态机、API 端点、broker + 分派（dispatch）、LISTEN/NOTIFY。
- **WebSocket 流测试**：随机端口上的真实监听 + 真实 `pg_notify` 触发——握手认证/成员资格拒绝路径、去抖（debounce）合并、最大等待、令牌过期关闭（4401）、连接上限、订阅者键规范化，以及"无订阅者时绝不触碰数据库"。
- **终端净化测试**：设备可控文本在 `writeln` 之前剥离 C0/C1 控制字符（转义序列注入无法到达 xterm）。
- **CI 护栏**：对 `ci.yml` 运行 actionlint（固定 v1.7.12），另有静态扫描——i18n 字典之外的硬编码中文（CJK）会使构建失败。
- **等效真实设备测试**：基于 Bun 原生 WebSocket + `mqtt-packet` 构建的迷你 MQTT-over-WebSocket 客户端（`packages/broker/tests/helpers/mqtt-client.ts`）（mqtt.js 的 WS 传输在 Bun 下不可用）。
- **真实固件 fixture**：编译好的 on9log Unix 演示 ELF（约 1 MB）及其 SLIP 输出已入库，位于 `packages/core/tests/fixtures/`——零 `/tmp` 依赖、零静默跳过。用 `scripts/build-on9log-fixtures.sh` 重新生成。
- **其他合成 fixture**：`tests/helpers/elf-builder.ts` 构造最小 ELF；日志测试手工构造与合成 ELF 地址匹配的 on9log 包。

## 测试布局

```
packages/core/tests/
  topic/command/stat.test.ts      协议编解码
  protocol/structure.test.ts      MessagePack 深度/重复键
  on9log/packet|render|slip.test.ts
  on9log/demo-integration.test.ts 真实固件输出 + ELF
  elf/parser|elf64.test.ts        合成 ELF 套件
  queue/queue|rate-limit.test.ts  队列状态机、限流器
  logging/logging.test.ts         摄取/解码/回填（合成）
  logging/container.test.ts       log 容器协议（raw/msgpack 合并包、
                                  上限、畸形元素）
  security/password.test.ts       仅 argon2id
packages/api/tests/api/
  auth.test.ts                    JWT 流程、轮换、吊销
  commands.test.ts                批次 API + 错误 + 鉴权
  logging.test.ts                 固件产物、日志、凭据
  firmware.test.ts                版本发布、下载 JWT、部署、停滞
  rollout.test.ts                 滚动发布创建/详情/生命周期
  config.test.ts                  JWT_SECRET 接线、快速失败
packages/broker/tests/mqtt/
  broker.test.ts                  WS 认证/ACL/投递/会话踢除
  notify.test.ts                  LISTEN/NOTIFY + 重连
  ota-publish.test.ts             OTA 投递 + 经 WS 的 ACK
```

## 可靠性实践

- **异步数据库断言不用固定 sleep**：`waitFor()` 带超时轮询谓词（真正的重连延迟也用轮询）
- **测试隔离**：清理范围限定在测试设备/项目。Bun 1.4 的 `--isolate` 在同一进程内为各文件提供新的全局对象；后端套件保持串行，因为队列 worker 会有意扫描共享数据库行，使用独立的 `--parallel` worker 时可能租走其他测试的命令。
- **被跳过的测试不存在**：每个测试都真实运行（fixture 已入库）
- 内部错误泄漏会使测试失败（`500` 响应断言响应体不含内部消息）

## CI

`.github/workflows/ci.yml`（GitHub Actions，`master` 分支）并行运行三个任务：

1. **backend**（postgres 服务）：install → `db:generate` → `db:deploy` → `bun run typecheck` → `bash scripts/test.sh`（在隔离的 `soulcloud_test` 数据库上 642 个测试）→ 双进程 E2E（`scripts/run-e2e.sh`）
2. **web**（无数据库）：install → web typecheck → 226 个单元测试（`bun run --cwd packages/web test`）→ 生产构建
3. **web-e2e**（postgres 服务）：install → `db:generate`/`db:deploy` → 安装 agent-browser（Chrome for Testing）→ `bash scripts/web-e2e-ci.sh`（浏览器 <-> API 对全新数据库的 E2E）

## 前端测试

- **单元测试**：`bun run --cwd packages/web test`——bun:test + happy-dom 全局对象（由 `src/test-setup.ts` 注入），React Testing Library + user-event。文件以串行 `--isolate` 运行；Bun 会在文件之间重置全局对象，因此模块 mock（`mock.module`）不会跨文件泄漏。
- **覆盖率**：`bun run --cwd packages/web test --coverage`——33 个文件 94% 行 / 85% 函数（i18n 字典、axios 认证流程、contexts、每个页面/对话框、API 辅助、主题）。
- **浏览器 E2E**：`scripts/web-e2e-ci.sh`（需要 agent-browser 在 PATH 中）——启动 API + Vite，播种用户，通过 API 创建设备，然后在真实浏览器中验证前端渲染真实后端数据。所有浏览器调用共享一个 agent-browser 会话；等待基于条件（`wait --text`），无固定 sleep。

## 脚本

| 脚本 | 用途 |
| --- | --- |
| `scripts/e2e.ts` | 命令循环 E2E（注册用户 → 入队 → WS 设备收到 → 结果 → 完成） |
| `scripts/e2e-logging.ts` | 日志 E2E（注册 → 上传 ELF → stat → 原始包 → 解码查询） |
| `scripts/e2e-ota.ts` | OTA E2E（上传 → 部署 → MQTT 通知 → HTTP 下载 → ACK → 任务查询） |
| `scripts/e2e-rollout.ts` | 滚动发布 E2E（创建 2 阶段滚动发布 → 阶段 1 完成 → 推进循环激活阶段 2） |
| `scripts/latency.ts` | enqueue→设备延迟测量（LISTEN/NOTIFY 唤醒） |
| `scripts/bench-elf.ts` | ELF 解析基准（每 1 MB ELF 36 µs，每个解码事件 40 µs） |
| `scripts/web-e2e-ci.sh` | web <-> API E2E：浏览器渲染真实后端数据（认证、设备、固件、滚动发布） |
| `scripts/prepare-test-db.ts` | 创建/迁移/清空隔离的 `soulcloud_test` 数据库 |
| `scripts/test.sh` | 后端测试运行器（隔离测试数据库，排除 web 包套件） |
| `scripts/build-on9log-fixtures.sh` | 重新生成入库的演示 ELF + 输出 |
