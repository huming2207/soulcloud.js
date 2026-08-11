# 日志（Logging，on9log）

> 本文档是 `docs/en/logging.md` 的中文翻译，结构与其一一对应；如有出入以英文版为准。

设备以 **on9log 二进制格式** 记录日志（固件组件位于 `on9log_demo/components/on9log`）：紧凑的 18 字节头，使用 ELF 地址而非格式字符串。平台不可变地存储原始包，并在查询时对照已上传的固件 ELF 按需解码。

## 协议摘要（Protocol summary）

```
18-byte little-endian header:
  magic 0x9a | type_level (type<<4 | level) | seq u16 | time_ms u32 |
  tag_id u32 | fmt_id u32 | payload_len u16 (0xffff = streaming)
```

包类型：`0 LOG`（参数表 + 编码参数）、`1 DROPPED`（丢弃计数器）、`2 TIME_SYNC`、`3 BOOT`（不透明负载——格式尚未定义）、`4 BUFFER`（分块内存转储）。参数类型：32 位、64 位、指针、动态字符串（u32 长度 + 字节）、字符串视图。

MQTT 直接携带原始包字节（无 SLIP——MQTT 本身就有消息边界；SLIP 仅用于 UART 传输，位于测试辅助代码中）。

## 日志容器协议（上行）（Log container protocol）

MQTT `log` topic 的 payload 是一个**分派容器**：首字节选择格式，为未来类型（raw text、JSON 等）留出空间。

| 首字节 | 格式 |
| --- | --- |
| `0x9a` | 原始 on9log 包——未改变，即 on9log magic 本身 |
| `0x01` | MessagePack 聚合数组：`array of bin`（`bin8`/`bin16`），每个元素是一个完整的 on9log 包 |
| 其他 | 保留——该包被拒绝 |

聚合数组让固件可以把多条日志包合并进一次 MQTT publish（通常在其出站队列积压时）。broker 拆分容器，并通过普通的单包路径（`ingestLogPacket`）逐条摄取（ingest）每个元素，因此 `raw_log_events`、解码和实时日志流都不变。畸形元素被丢弃并计数；它绝不会使容器其余部分失效。元素必须是 `bin8`/`bin16`（自定界），且每个容器元素数上限为 4096。

面向固件的线上规格（字节级示例、编码器选择、合并指南）参见 [protocol-log-packaging.md](protocol-log-packaging.md)。

## 流水线（Pipeline）

```
device ── MQTT log topic ──▶ broker (validate + store raw, <1ms)
                                  │
ELF upload ──▶ API (SHA-256 → store → synchronous dictionary import)
                                  │
query ──▶ API (tag/fmt IDs → dictionary → renderFormat → response)
```

- **热路径**（`packages/core/src/logging/ingest.ts`）：严格包解析，向 `raw_log_events` 插入一条带信封元数据的记录，从 `device_firmware_state` 关联固件产物（artifact）（fw hash → build_id → 项目级产物）。无 ELF 工作，无渲染。
- **导入**（`packages/core/src/logging/artifact.ts`）：SHA-256 构建标识（每项目唯一），提取 `.noload_keep_in_elf.*` 字符串（格式 + 标签）和已分配的只读字符串，事务性，并发上传下幂等（P2002 → 复用现有行）。
- **解码**（`packages/core/src/logging/decode.ts`）：查询时字典查找 + `renderFormat`（printf + fmt 语法）。无法解码的事件返回 `message: null`——永远不会报错——原始数据保留用于回填（backfill）。批量解码每个产物只加载一次字典（无 N+1）。

## 渲染器（Renderer）

`packages/core/src/on9log/render.ts` 支持：

- printf 转换（`%d %u %x %X %p %c %s %f %e %g`，flags/width/precision，`%.*s` / `%*d` 消耗参数；负宽度 = 左对齐；`%+08d` 在符号后补零）
- fmt 风格占位符（`{}`、`{:x}`、`{:#x}`、`{:>10}`、`{:.6f}`、嵌套 `{:{}}`、位置参数 `{0:{1}}`、花括号转义）
- 对裸 64 位 `{}` 的文档化启发式（线上格式无法区分 int64/uint64/double；绝对值 ≥ 2^53 且浮点指数合理时按浮点渲染，NaN/Inf 已处理，小整数保持整数）

安全：字段宽度上限 4096，精度 0..100，总输出上限 1 MB——恶意格式字符串产生类型化错误，绝不会 OOM。

## ELF 解析器（ELF parser）

`packages/core/src/elf/parser.ts` 是一个无依赖的 ELF32/64 LE/BE 解析器：通过 PT_LOAD 段做 vaddr → 文件偏移映射，带已分配段回退（`.noload` 段不在任何加载段中，需要此回退）。所有偏移都有边界检查；提取仅限于已识别段（不导入 DWARF/strings——它们可能包含构建路径和凭据）。基准测试：解析 1 MB 真实 ELF ≈ 36 µs；完整解码 ≈ 40 µs/事件。

## 安全（Security，审计驱动）

- broker 处的每设备限流（rate limit）和包大小上限（见 MQTT 文档）
- 动态字符串长度上限（64 KB，固件上限 1024）
- 解析器严格有界（不根据长度分配内存）
- BOOT 包不透明存储；DROPPED/TIME_SYNC/BUFFER payload 做长度检查；BUFFER 分块对照声明总长校验；LOG 级别校验 0..5

## 已知限制 / 未决事项（Known limitations / open items）

- 容器分派保留了 `0x9a` 和 `0x01` 之外的所有首字节值；新类型（如 raw text、JSON）可在不做另一次破坏性变更的情况下添加
- 全文搜索（tsvector）未实现；原始归档是事实来源，未来可添加解码投影
- 对象存储归档和保留策略推迟到数据量需要时再做
- `decodeState` 回填按设备当前固件哈希关联；如果旧固件从未上传，历史事件会对照最新 ELF 渲染（文档化的简化）
