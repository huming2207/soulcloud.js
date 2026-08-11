# 安全（Security）

> 本文档是 `docs/en/security.md` 的中文翻译，与英文版一一对应。

本文档总结威胁模型（threat model）、分层防御，以及三轮外部审计（Kimi）——其发现均已验证并修复。

## 分层防御

### 1. MQTT 层（消息代理 broker）

- **身份绑定**：clientId 必须等于 username（设备 UID）并通过 UID 校验——无法冒充、无通配符 clientId
- **每设备限流**：令牌桶（持续 20 msg/s，突发 100），可通过 `UPLINK_RATE_*` 配置；超限直接丢弃，绝不缓冲
- **包大小上限**：`authorizePublish` 中的早期拒绝（256 KB）以及分派（dispatch）层的限制（`UPLINK_MAX_PACKET_BYTES`，64 KB）
- **认证节流**：认证失败等待 100 ms；数据库故障返回 CONNACK code 3（服务器不可用）
- **背压（backpressure）**：`ws.send() < 0`（套接字缓冲区已满）上报流错误，QoS 1 帧绝不会被静默丢弃

### 2. 解析层

- MessagePack：嵌套深度上限 512，拒绝重复键，拒绝尾部多余字节，长度有界，区分 byte-array 与 bin
- on9log：有界的头部/负载解析，动态字符串长度上限（64 KB），BOOT 包不透明处理，BUFFER 块边界检查，level 0..5 校验
- SLIP（仅测试辅助）：所有抛出路径都会消费坏字节，损坏的流可以重新同步
- ELF：纯解析（从不执行），所有偏移量均做边界检查，只提取可识别的段（无 DWARF/strings）

### 3. 渲染层

- 字段宽度 ≤ 4096，精度 0..100，总输出 ≤ 1 MB——恶意格式字符串产生类型化错误，绝不会 OOM/RangeError

### 4. API 层

- 每个 path/query/body 参数均经 Zod 校验
- 统一的 500 `{error:"internal"}`——不泄漏内部消息
- 上传在缓冲前上限 32 MB（声明长度 + 分块传输的流式上限）
- 命令批次上限 1000 个目标设备

### 5. 认证与凭据

- 人类用户与设备密码均用 argon2id（Bun.password）；无旧格式兼容
- JWT 访问令牌（access token）短时有效；刷新令牌（refresh token）服务端存储、可吊销、轮换并带全链复用检测
- 所有项目作用域操作强制项目成员资格（403）
- 设备凭据吊销会杀死活动会话

## 审计历史

三轮外部审查（`REVIEW_RESULT.kimi.md`、`REVIEW_VERIFY.kimi.md`，以及 `llm-docs/soulcloud/` 中的结果记录）共产生 33+ 项发现。全部经过验证（其中数项通过运行时测试复现）并修复。要点：

| 轮次 | 关键修复 |
| --- | --- |
| 1（RESULT） | 身份冒充、`{:g}` 尾零丢失、运行 24.8 天后 int4 溢出、错误泄漏、上传内存 DoS、非原子导入、递归深度、负 bigint、精度 RangeError、BOOT 包、序号排序、notify 重连 |
| 2（VERIFY） | CI 分支 + 缺失的 prisma generate、Content-Length 检查顺序、WS 背压、trimFloat 第二条路径、跨项目固件绑定、接入死缓存、scrypt N 校验 |
| 3（Round-3） | 分块上传上限、日志热路径缓存、入库 fixture（零静默跳过）、测试隔离（无全局 DELETE）、slip 辅助重同步 |

每轮都新增了回归测试；最终覆盖率审计又补了 8 个测试，并修复了一个真实的 IDOR（命令批次未检查设备项目成员资格）。

## 未决事项（已记录，非 bug）

- 滚动发布（rollout）回滚是尽力而为的通知：离线设备在其投递窗口过后必须手动重新触发；无 A/B 或重刷能力的设备无法由平台回滚
- 消息代理 WS 端点在设备凭据之外没有额外认证（TLS 是反向代理的职责；可增加 WebSocket origin 检查）
- 登录节流是进程内的（每用户名失败 5 次锁 60s；内存态、按实例）。注册暴力破解与 OTA 下载限流**未内置**——生产部署必须在反向代理处限流（已在 .env.example / README 中说明）
- 对象存储加密/保留策略暂缓
- `hashDevicePassword` 的 argon2id 参数使用 Bun.password 默认值（成本调优属于部署决策）
