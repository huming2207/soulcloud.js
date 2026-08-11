# 认证

> 中文翻译，与 docs/en/ 同名英文文档对应。


按设计，有两种截然不同的认证模型：

- **人类用户**（REST API）：JWT 双令牌——短生命周期的无状态访问令牌（access token）
  + 长生命周期的服务端刷新令牌（refresh token）
- **设备**（MQTT）：按会话（per-session）的有状态认证——绝不用 JWT

## 人类用户：JWT 双令牌

实现：`packages/core/src/auth/tokens.ts`，路由在
`packages/api/src/api/auth.ts`。

### 流程

```
register/login ──▶ {access_token, refresh_token}
                       │
   access_token (HS256 JWT, default 15 min, stateless)
       │  used for every protected API call: Authorization: Bearer ...
       ▼
   expires ──▶ POST /v1/auth/refresh {refresh_token}
                   │  verifies server-side record
                   │  revokes the old token
                   ▼
         {new access_token, new refresh_token}   (rotation)
```

### 刷新令牌设计

- 256 位随机值；`refresh_tokens` 中**只存储其 SHA-256**
- 默认 30 天，服务端过期
- **每次刷新都轮换（rotation）**：旧令牌被吊销，签发后继令牌并带
  `rotated_from` 链接
- **重用检测（reuse detection）**：重放已被轮换的令牌会吊销整条链
  （沿 `rotated_from` 链接双向追溯）——合法客户端刷新后，被盗令牌即不可用
- 登出吊销当前出示的令牌

### 密码存储

通过 `Bun.password` 使用 argon2id（`packages/core/src/security/password.ts`）。
不接受任何遗留格式（scrypt/明文兼容已按要求移除）。`generateDevicePassword()`
生成 24 字节 base64url 值。

### 授权

`authenticateRequest()` 校验 Bearer JWT 并加载用户；
`userCanAccessProject()` 执行 `user_projects` 成员资格（membership）检查。
受保护端点：命令批次、固件产物（上传/列表）、日志查询、固件状态、设备凭据。
项目作用域操作对非成员返回 403；未知资源返回 404。

当前的租户（tenancy）模型是**直接 用户 → 项目 成员资格**（`user_projects`）。
`organisations` 系列表仍是未来多租户层的脚手架（scaffolding）。

## 设备：按会话有状态（不用 JWT）

为什么设备不用 JWT：

| | JWT（无状态） | 按会话 |
| --- | --- | --- |
| 吊销 | 滞后，需要黑名单 | 立即（拒绝重连 + 击杀会话） |
| 重连 | 令牌刷新流程 | 直接再 CONNECT |
| 凭据暴露 | 令牌可离线验证 | 凭据只在 CONNECT 时使用 |
| MQTT 模型 | 不匹配 | 原生（CONNECT/会话生命周期） |

### 流程

```
POST /v1/devices/:id/credentials   (authenticated human)
        └─▶ returns {mqtt_username = device_uid, mqtt_password} ONCE
             stores argon2id hash, clears auth_revoked
                    │
device CONNECT (username = device_uid, password)
        └─▶ broker authenticate: clientId === username (identity binding),
             not revoked, argon2id verify
                    │
        session lives until disconnect
                    │
POST /v1/devices/:id/credentials/revoke
        └─▶ auth_revoked = true + pg_notify(soulcloud_credentials_revoked, uid)
             broker kicks the live session (kickDeviceSession)
             reconnect is refused
```

### 身份绑定（identity binding）

MQTT `clientId` 必须等于 `username`（设备 UID）并通过
`isValidDeviceUid` ——这正是按 clientId 击杀会话正确且能防止冒充的原因
（审计修复 S1/S2）。

### 凭据轮换

重新签发凭据会替换哈希——旧密码立即失效（已用真实连接测试）。

## 配置

`JWT_SECRET`（≥ 32 字符，生产环境无默认值）、`JWT_ACCESS_TTL_SECONDS`
（900）、`JWT_REFRESH_TTL_SECONDS`（2592000）。`createApp(prisma, jwtConfig)`
接受该配置；测试使用自己的短 TTL 实例来覆盖过期场景。

## 测试

`packages/api/tests/api/auth.test.ts`（15 个测试）：注册（个人项目）、
登录成功/密码错误、重复 409、轮换 + 旧令牌重用、链式吊销、登出、
受保护端点 401/403、未知/过期刷新令牌、输入校验、访问令牌过期（1 秒 TTL）、
凭据 404。`packages/broker/tests/mqtt/broker.test.ts` 补充：已吊销设备在
CONNECT 时被拒、重新签发的凭据可连接、凭据轮换使旧密码失效、
通过 WS 击杀会话、对离线设备调用 `kickDeviceSession`。
