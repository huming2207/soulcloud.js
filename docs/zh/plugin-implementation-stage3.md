# 插件系统实施记录（阶段 3）

> 本文档记录 `plugin-and-station-architecture.md` 中阶段 3（Action 与声明式
> Web UI）的落地实现。阶段 1/2 记录见 `plugin-implementation-stage1-2.md`。

**日期**：2026-08-22 · **基线**：726 个后端非 E2E 测试全绿、`tsc --noEmit`
干净、i18n 硬编码扫描通过。web 套件存在 95 个**先于本阶段**的既有失败
（`scripts/test.sh` 历来排除 web 目录），本阶段未引入新失败。

## 概览

阶段 3 打通三条链路：

```
Action 下行：
  Web 表单（由 inputSchema 渲染）
    → POST /v1/devices/:id/actions/:action_id
    → validateActionInput（SDK 纯校验器）
    → manifest.wire.encode（纯函数，API 进程内执行）
    → DeviceCommandSchema 权威校验 → enqueueBatch（既有 durable command queue）

Profile 绑定（高风险操作，§3）：
  dry-run（实体 diff + 阻断原因）→ PUT /profile（绑定 + 实体注册 + 审计同事务）

Installation 生命周期：
  create / patch config / migrate（版本迁移 + reconcile 同事务）/ disable / enable
  —— 全部写 audit_events
```

## Plugin SDK 变更

| 文件 | 内容 |
| --- | --- |
| `types.ts` | **修正 `CommandArgument`**：从类型标签（`{str}`/`{u64}`…）改为命名单键 map（`{ channel: 3 }`），与真实 DeviceCommand wire contract 及 §5 示例一致——阶段 1 的类型无法直接入队；`ActionDescriptor.inputSchema` 收紧为 `ActionInputSchema` |
| `action-schema.ts`（新增） | 扁平输入 schema 语言（string/number/integer/boolean × required/enum/min/max/title/description/default）+ `validateActionInput`（API 权威校验）+ `validateActionInputSchema`（注册期 fail-fast）。同一份声明同时驱动 API 校验与 Web 表单渲染（§7.1），刻意不引入 JSON Schema 依赖 |
| `validation.ts` | manifest zod schema 按 `actionInputFieldSchema` 收紧；跨字段规则接入 schema 自检 |

## Core 服务层

| 文件 | 内容 |
| --- | --- |
| `plugins/actions.ts`（新增） | `encodePluginAction`：schema 校验 → encoder → 编码输出结构复检（单键标量 map、参数数量上限）→ **复用核心 `DeviceCommandSchema` 做最终权威校验**。错误类型 `unknown_action` / `invalid_action_input` / `invalid_action_output` |
| `audit.ts`（新增） | `recordAuditEvent`：追加式审计写入，与所描述操作**同事务**提交；表永不更新/删除 |
| `plugins/installation.ts` | 新增 `updateInstallationConfig` / `setInstallationState`（error 态禁止盲目 enable）/ `listProjectInstallations` / `migrateInstallationInTransaction`（版本变更 + error 恢复 + reconcile 单事务）/ `dryRunDeviceProfile`（checks + added/removed/changed 实体 diff + blockingReasons）；`bindDeviceToInstallation` 拆出事务内核 `bindDeviceInTransaction` 供 API 与审计同事务组合 |

## 数据库（迁移 `20260821120000_audit_events`）

```text
audit_events
  id, project_id FK->projects CASCADE,
  actor_user_id FK->users SET NULL（服务身份可空）,
  action VARCHAR(64), subject_type, subject_id, detail JSONB, created_at
  索引：(project_id, created_at DESC)、(subject_type, subject_id, created_at DESC)
```

## API 路由（`packages/api/src/api/plugins.ts`，§16 草案落地）

控制面：

```text
GET    /v1/plugins/catalog
GET    /v1/projects/:projectId/plugin-installations        含 device_count
POST   /v1/projects/:projectId/plugin-installations        版本取部署 registry
PATCH  /v1/plugin-installations/:installationId            config_json
POST   /v1/plugin-installations/:installationId/migrate    显式迁移 + reconcile + 审计
POST   /v1/plugin-installations/:installationId/disable    （草案之外补 enable）
POST   /v1/plugin-installations/:installationId/enable     error 态拒绝盲启
```

设备插件：

```text
POST   /v1/devices/:deviceId/profile/dry-run               不落库的绑定预检报告
PUT    /v1/devices/:deviceId/profile                       绑定+注册+审计同事务
DELETE /v1/devices/:deviceId/profile                       解绑回 generic（草案外补充）
GET    /v1/devices/:deviceId/plugin-view                   descriptor×state 合并视图
GET    /v1/devices/:deviceId/actions                       声明式 action 列表
POST   /v1/devices/:deviceId/actions/:action_id            202 {batch_id, wire_command}
```

约定与偏差：

- 错误映射：`unknown_action`/`device_not_bound`/`invalid_installation` → 404；
  schema/profile 类错误 → 400；version/binding/state 冲突 → 409。
- Action 调用中 `enqueueBatch` 自持事务（序列快照），审计记录在其后独立写入，
  失败仅记日志不回滚已入队命令（代码注释说明该取舍）。
- 「独立权限」暂以项目成员资格承担——平台尚无角色体系；审计半边已落地，
  角色系统引入后应收紧 PUT /profile 与 installation 写路径。
- 草案中的 `/disable` 之外补充了 `/enable`（禁用后无恢复路径不可用）。

## Web（声明式 UI，§7.1）

- `api/plugins.ts`：plugin-view / actions / invoke 客户端。
- `components/PluginPanel.tsx`：设备详情页新增「插件」Tab——绑定信息卡、
  Entity 行（值+单位、质量 Chip、告警 Chip、stale 推导）、Action 表单
  （enum→下拉、number/integer→数字输入、required 标注、default 预填），
  执行结果显示批次号。10s 轮询刷新状态。
- i18n 五语言（zh/en/ru/uk/it）全部补齐 key，占位符用 i18next `{{x}}` 风格。

## 测试

| 套件 | 覆盖 |
| --- | --- |
| `api/tests/api/plugins.test.ts`（新增，15 用例） | catalog、installation 全生命周期（含 error 盲启拒绝、migrate 幂等冲突）、dry-run diff、绑定/解绑 + 审计行断言、plugin-view 合并、action 输入校验失败/未知 action/成功入队（解码 MessagePack 断言 cmd+args）、generic 设备无 action |

## 刻意未做（后续阶段）

- 短期 plugin UI session token 与 iframe UI：声明式 UI 已覆盖当前需求，
  待出现需要隔离 bundle 的真实插件再实现（§7.2）。
- profile `configurationSchema` 校验（配置目前仅要求 JSON 对象）。
- 安装级角色权限（依赖角色体系）。
