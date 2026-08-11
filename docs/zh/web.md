# Web 控制台 — 当前状态（Web Console — Current Status）

> 本文档是 `docs/en/web.md` 的中文翻译，与英文版一一对应。

**日期**：2026-08-09 · **基线**：221 个单元测试 / 33 个文件全绿，`tsc --noEmit` 干净，web <-> API 浏览器 E2E 通过，CI 并行运行三个任务（backend / web / web-e2e）。

Web 控制台（`packages/web`）是 SoulcloudJS 平台的人机界面：设备管理、解码日志、固件版本发布（release）与 OTA 滚动发布（rollout）。它是纯 SPA，只与 Elysia REST API（`:8080`）通信——绝不触碰 MQTT 或消息代理（broker）。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 构建 | Vite 6，路由级代码分割（`React.lazy`） |
| UI | React 19 + Material UI 9（+ Data Grid 9、Emotion） |
| 数据 | TanStack Query 5（服务端状态、轮询）+ axios |
| 路由 | React Router 7（`createBrowserRouter`） |
| 国际化（i18n） | react-i18next（应用文案）+ MUI/Data Grid 语言包 |
| 测试 | bun:test + happy-dom + React Testing Library + user-event |

开发服务器将 `/v1` 和 `/health` 代理到 `http://localhost:8080`；生产反向代理后面也预期使用相同的前缀。

## 认证流程

- **访问令牌（access token）**：仅保存在内存中（`api/http.ts` 的模块状态），从不持久化——短时有效（15 分钟）。
- **刷新令牌（refresh token）**：存 `localStorage`（`soulcloud.refresh_token`），每次刷新时轮换。
- **401 处理**：axios 响应拦截器用单飞（single-flight）Promise 刷新并重试原请求一次；认证端点（`/v1/auth/login|register|refresh|logout`）豁免以避免刷新循环。刷新失败会清空令牌并跳转 `/login`。
- **会话恢复**：页面加载时 `fetchMe()` 收到 401，拦截器透明刷新并重试，应用无需登录页即可已认证落地。
- **项目选择**：`/v1/me` 项目列表，按浏览器持久化（`soulcloud.project_id`），存储的 id 失效时自动纠正。

## 页面

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/login`、`/register` | 认证 | 注册即服务端登录（返回令牌对） |
| `/` | 仪表盘 | 项目摘要 + 设备数 |
| `/devices` | 设备列表 | Data Grid、服务端分页（pagination）、空状态引导 |
| `/devices/:deviceId` | 设备详情 | 标签页：概览 / 命令 / 日志 |
| `/logs` | 日志 | 设备选择器 + 解码日志流（REST 表格 5 秒自动刷新，或基于 WS 流的 xterm.js 实时终端视图：历史回放 + 分级配色行、跟随/清空、暗色模式感知） |
| `/firmware` | 固件 | 版本发布 + ELF 固件产物（artifact）标签页、上传对话框 |
| `/rollouts` | OTA 列表 | 进度条、10 秒轮询 |
| `/rollouts/:rolloutId` | 滚动发布详情 | 按状态操作、阶段步进器、5 秒轮询 |
| `/ota-jobs/:jobId` | OTA 任务 | 逐目标表格、5 秒轮询 |

关键交互：

- **创建设备**：对话框签发一次性 MQTT 凭据（只显示一次，带复制按钮）；`device_uid` 必须对 MQTT topic 安全。
- **凭据**：两步确认对话框（旧凭据作废、活动会话被踢）后显示一次性密码。
- **固件绑定**：设备固件哈希 <-> ELF 固件产物（回填（backfill）此前无法解码的日志事件）。
- **命令**：JSON 参数校验、投递超时、带状态徽章的命令历史与批次详情对话框、10 秒轮询。
- **命令历史**：命令表单的名称字段支持 zsh 风格 ↑/↓ 导航（`useCommandHistory`，最新 → 最旧，进行中的草稿保留并在末尾恢复）；已提交命令去重（无连续重复），每设备上限 50 条，按设备持久化在 localStorage（`soulcloud.cmdhistory.<deviceId>`）——历史在刷新后仍在，且绝不跨设备泄漏。
- **实时日志**：`useLogStream(deviceId, {onEvent})` 以子协议认证 `["soulcloud", "<access token>"]`（浏览器无法设置 header）打开 `GET /v1/ws/logs?device_id=<uuid>`，收到 `{type:"ready"}` 后是 `{type:"log", device_id, event}` 帧（事件结构与 REST 端点完全一致），指数退避（backoff）重连（1 s → 30 s 上限）。日志页在 REST 表格（5 秒自动刷新、分页、原始视图）与实时终端（xterm.js：REST 历史最旧优先回放，随后实时流式行带级别配色、跟随/清空、暗色模式感知；设备可控文本已净化——C0/C1 控制字符在 writeln 前剥离）之间切换。
- **滚动发布创建**：自动策略（可编辑累计比例，客户端校验升序 + 末位 = 1）或分组策略（设备集分组）、回滚基线选择器、门控（gating）参数。
- **滚动发布控制**：暂停/恢复/中止/回滚按钮仅在适用状态下启用。

## 国际化（i18n）

五种语言环境（locale）——简体中文（默认）、英语、俄语、乌克兰语、意大利语。字典完整性在编译期强制（`Record<DictKey, string>`，缺键会使 `tsc` 失败），占位符跨语言环境一致（有测试），俄语/乌克兰语翻译是真实的且互不重叠（测试中交叉核对）。MUI 组件文案与 Data Grid 通过 `createTheme(baseTheme, locale)` 和网格语言包跟随应用语言环境；应用栏的语言菜单持久化选择。

## 测试

- **221 个单元测试 / 33 个文件**（`bun run --cwd packages/web test`）：i18n 字典不变量、axios 认证流程（mock axios：Bearer 注入、单飞 401 刷新、豁免列表、登出跳转）、认证/项目 contexts、每个页面与对话框（渲染、校验、流程）、API 层 URL/body 构造、主题 LinkBehavior。
- **覆盖率**：94% 行 / 85% 函数（33 个文件）。
- **浏览器 E2E**（`scripts/web-e2e-ci.sh`）：启动 API + 生产构建（vite build + preview）、播种用户、通过 API 创建设备，然后在真实浏览器中验证前端渲染真实后端数据（登录页、已认证仪表盘、设备行、固件/滚动发布空状态，以及日志页：设备选择器 → 表格 → 带实时 WS"已连接"状态的 xterm 终端）。所有浏览器调用共享一个 agent-browser 会话；交互是确定性的（业务操作走 API 层，页面状态用 `wait --text` 条件）。
- CI：`web` 任务在无数据库情况下运行 typecheck + 单元测试 + 构建；`web-e2e` 任务安装 agent-browser 并对全新数据库运行浏览器 E2E。

## 已知限制 / 未决事项

- **部署**：生产镜像 + compose 已就位（api/broker 用 `Dockerfile.backend`，web 用 `packages/web/Dockerfile`，由最小 nginx 提供服务——SPA fallback + 不可变资源缓存，容器内无代理）。Compose 直接暴露 API/web/MQTT 端口；TLS 终止与 `/v1` 到 API 的路由预期在反向代理处完成（参考部署用 traefik，配置在 `deploy/traefik/`），位于基础 compose 文件之外。
- **包体积**：主 chunk 约 636 KB 压缩后（MUI）；路由级分割已就位，manualChunks 分割是未来的优化项。
- **MQTT 设备注册流程没有超出创建设备的认证 UI**（设备接入有意保持最小）。
- 全文日志搜索、对象存储归档、保留策略与组织/租户多租户仍是后端未决事项（与 Rust 版范围相同）。
