# SoulCloud 小程序（Applet）规划 — 品类应用框架（米家模式）

> 本文档是 `docs/en/plan-applet.md` 的中文翻译，与英文版一一对应。

**日期**：2026-08-09 · **状态**：规划（尚未实现任何内容） · **适用范围**：
核心平台作为共享底座，各产品"小程序（applet）"承载品类特有逻辑与 UI——即米家模式：核心设备能力 + 按品类插件。

## 目标

把 SoulcloudJS 变成**平台 + 小程序（applet）**产品线：现有能力（设备身份/连接、OTA、命令、日志、用户/项目/RBAC、Web 控制台）成为共享核心；不同产品（智能灯、传感器、门锁……）在核心之上构建自己的功能，而无需 fork 或修改核心。

核心洞察，借鉴自米家模式：**小程序（applet）的边界是设备模型，而不是服务。** 连接、认证、topic 路由、OTA 与 RBAC 永远是核心的。一个小程序贡献：

1. 一个**能力模型**（其产品类型的属性 properties / 命令 commands / 事件 events），
2. **品类特有业务逻辑**（规则、场景、定时任务……），
3. **品类特有 UI**（菜单项、路由、设备详情标签页）。

## 现状差距（核心今天缺少什么）

| 差距 | 今天 | 需要 |
| --- | --- | --- |
| 设备类型概念 | `Device` 没有类型字段；所有设备都是同一类 | `Device.productType` |
| 能力模型 | 属性展示/逻辑硬编码在 `DeviceDetailPage` | 数据驱动 DSL（`AppletDefinition`） |
| 扩展点 | 路由硬接线在 `app.ts`；菜单/路由静态在 `router.tsx`/`AppLayout` | 小程序注册表（前端 + 后端） |

其余核心已经具备且可以保持不动（见下文"协议层"）。

## 设计原则

1. **核心与产品无关。** 核心代码库对任何品类零知识。品类只存在于 `packages/applets/*`。
2. **沿设备模型切分，而不是沿服务切分。** Phase A/B 不做微服务、不做微前端。用 monorepo 子包、静态集成，沿用现有工具链构建。
3. **消息代理 ACL 保持字符串化。** 设备身份与 topic 授权不得要求每次连接查数据库。小程序特有流量位于现有通用通道的**负载（payload）层**。
4. **核心契约只增不改。** 小程序只能*新增*端点、topic 类型、表与 UI 面；绝不允许改变核心行为或核心契约（API `/v1/*` 形态、topic 方案、WS 帧格式）。
5. **进程间集成已经存在。** `pg_notify` + WS 中枢（hub）（`packages/api/src/pg-listen.ts`、`useWebSocketStream`）与进程无关，可原样带入独立服务阶段。

## 架构

```
soulcloudjs/ (Bun workspace)
├── packages/core/               # 核心：schema、协议、OTA、队列（最小新增）
├── packages/api/                # 核心 API：+ 通用能力 API（读/写属性）
├── packages/broker/             # 核心：+ 一个用于属性上报的新上行 kind
├── packages/web/                # 核心 UI：+ AppletRegistry（动态菜单/路由/标签页）
└── packages/applets/
    ├── core-types/              # AppletDefinition 契约 + 注册表辅助（无运行时）
    ├── demo-lamp/               # 示例小程序：模型 + 后端插件 + UI
    └── demo-sensor/             # 示例小程序（演示多个小程序并存）
```

### 1. 设备模型 DSL

每个小程序声明其能力模型；核心以通用方式渲染与服务它：

```ts
// packages/applets/core-types/src/index.ts
interface PropertyDef {
  key: string;
  label: string;                 // 小程序字典中的 i18n 键
  type: "number" | "boolean" | "string" | "enum";
  min?: number; max?: number; step?: number;
  enumValues?: string[];
  writable: boolean;             // writable ⇒ 核心显示编辑器并发送命令
  unit?: string;                 // 仅展示
}

interface CommandDef {
  name: string;                  // payload.command
  params: { key: string; type: string }[];
}

interface AppletDefinition {
  id: string;                    // "demo-lamp"
  productTypes: string[];        // 与 Device.productType 匹配
  properties: PropertyDef[];
  commands: CommandDef[];
  menuItems: { label: string; path: string }[];
  routes: RouteDef[];            // 懒加载 React 路由（/lamp/:deviceId, …）
  deviceDetailTabs?: TabDef[];   // 追加到 DeviceDetailPage 的额外标签页
  backendRoutes?: ElysiaPlugin;  // 品类 REST 逻辑，由核心 app.ts 挂载
}
```

完全由 DSL 驱动的核心新增（无品类知识）：

- `DeviceProperty` 表：`(device_id, key, value JSONB, updated_at)`——每条已上报属性一行；核心提供 `GET/PUT /v1/devices/:id/properties`（鉴权复用现有按项目成员资格检查）。
- 核心设备详情页根据 DSL 自动渲染属性面板（由 `type/min/max/enumValues/writable` 生成 MUI 控件）。

### 2. 协议层（几乎不动）

| 需求 | 方案 | 核心改动 |
| --- | --- | --- |
| 属性上报（上行） | 新 topic 类型 `soulcloud/v1/devices/{uid}/prop`，JSON 负载 | `parseDeviceTopic` 新增一个 kind + broker 独立于 `DOWNLINK` 的上行放行（无数据库查询） |
| 设置属性 / 运行命令 | 现有 `cmd/exec`，负载 `{applet, command, params}` | 无 |
| 结果回执 | 现有 `cmd/result` | 无 |
| 小程序特有事件流 | 现有 WS 基建（`pg_notify` + hub） | 无 |

为什么这是安全的：broker 的 `authorizePublish`/`authorizeSubscribe`（`packages/broker/src/mqtt/broker.ts`）保持针对客户端自身 UID 的纯字符串检查。小程序无法扩大设备的命名空间；它只定义 *payload* 的含义。如果未来某品类确实需要自己的 topic 段，后续方案是感知 productType 的 authorize 钩子（只在连接时查库、带缓存），而不是重新设计。

### 3. 前端注册表

```ts
// packages/web/src/applets/registry.ts
import { lampApplet } from "@soulcloud/applet-demo-lamp";
export const applets = [lampApplet, sensorApplet];
```

- `AppLayout` 菜单 = 核心菜单 + `applets.flatMap(a => a.menuItems)`
- `router.tsx` = 核心路由 + `applets.flatMap(a => a.routes)`（React.lazy，Vite 对每个小程序代码分割）
- `DeviceDetailPage` 按 `device.productType` 查找小程序；渲染其标签页 + 自动生成的属性面板
- i18n：小程序字典在构建时合并进核心字典；五语言环境键数不变量（`dictionary.test.ts`）扩展为覆盖小程序字典
- **不做微前端**（不做运行时 bundle 加载）：monorepo 静态集成 + Vite 分割以零头成本获得同样的隔离（安全/版本管理/测试成本都低得多）

### 4. 后端集成：先进程内插件

- `app.ts` 增加 `registerApplets(applets)` 步骤，`.use()` 每个小程序的 `backendRoutes` 插件——同一进程、同一 Prisma client、同一测试设施
- 数据隔离靠约定：小程序 Prisma 模型加前缀（`LampScene`、`LampSchedule`），并在 `schema.prisma` 中说明
- **独立服务模式是 Phase C**：traefik（`deploy/traefik/`）已有路由模式；加 `/applets/{id}/*` → 专用容器。pg_notify + WS hub 基建已经是跨进程的，事件集成原样带入

### 5. 权限

现有 user/project/member RBAC 原样适用（设备属性与小程序路由走同样的成员资格检查）。按项目启用小程序（`Project.appletIds`）明确**不**规划，直到某个产品真正需要（YAGNI）。

## 数据模型新增

- `Device.productType TEXT`（v1 可空——没有小程序关联的设备保持当前通用 UI）
- `DeviceProperty (device_id FK, key, value JSONB, updated_at)`，唯一约束 `(device_id, key)`
- 小程序表：Phase A/B 在共享 Prisma schema 中用前缀模型；仅 Phase C 重新评估（多 schema 或独立数据库）

## 路线图

| 阶段 | 内容 | 规模 |
| --- | --- | --- |
| **A. 数据驱动核心** | `Device.productType` 迁移 · `DeviceProperty` 表 + 通用属性 API（GET/PUT，带成员资格鉴权）· `AppletDefinition` 类型 · `DeviceDetailPage` 自动渲染属性面板 · `/prop` 上行 kind + broker 放行 | 中——地基，先做 |
| **B. 小程序框架** | `packages/applets/core-types` · 前端注册表（菜单/路由/标签页）· `app.ts` 注册入口 · 两个示例小程序（灯 + 传感器）· 契约测试（违反契约的小程序使 CI 失败）· i18n 合并 + 键数不变量 | 中 |
| **C. 可选演进** | 独立服务模式（经 traefik 的 `/applets/{id}/*`）· 小程序 WS 流 · 按项目启用小程序 | 仅在真实第三方/隔离部署需求出现时 |

## 明确不做的事

- Phase A/B 的微服务 / 微前端
- 每个小程序独立 topic 命名空间（payload 层命令已足够；见上文）
- 小程序市场 / 运行时插件加载
- 按项目启用小程序

## 风险

- **Prisma 单 schema 增长**：小程序多了 ⇒ schema 变动频繁。缓解：前缀模型 + 严格只增规则；Phase C 重新评估。
- **契约漂移**：小程序破坏注册表契约会连累核心 UI 一起挂。缓解：编译期契约类型 + CI 契约测试（Phase B 项）。
- **核心 UI 耦合**：DeviceDetailPage 增加"按 productType 查找小程序"逻辑——必须失败闭合（无小程序 ⇒ 当前通用渲染，绝不崩溃）。
- **重建成本**：小程序路由改动会重建整个 web bundle（与任何 monorepo SPA 相同）。接受；运行时加载仍是明确的不做项。
