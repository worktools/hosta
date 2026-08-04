# RFC 0004：交付计划与验收标准

- 状态：Accepted for planning
- 日期：2026-08-04

## 1. 实现策略

采用纵向切片：先用固定脚本打通创建、执行、发布和调用，再接入 DeepSeek；最后加固隔离和体验。这样每个里程碑都有可运行成果。

## 2. 里程碑

### M0：项目骨架与契约

- Monorepo：`apps/web`（Node/TypeScript）、`crates/runner`（Rust）、`packages/contracts`（JSON schema/OpenAPI）。
- Docker Compose 启动 web、runner 和持久数据卷。
- 数据库 migration、health/readiness、结构化日志和统一 ID。
- 固化 Runner v1 请求/响应 schema，并以契约测试约束 Node/Rust 两端。

验收：固定的 hello-world 代码可由控制面调用 Runner，重启后 run 记录仍存在。

### M1：无 AI 的发布闭环

- App、Version、Run、Deployment 的数据模型与 API。
- 使用预置 JS 版本完成试运行、发布、Webhook key 和运行记录。
- 最小网页：应用列表、创建页、版本页、运行详情页。
- 实现代码 hash、不可变版本、输入限制、同步 Webhook 和限流。

验收：固定脚本可从网页发布，并由 `curl` 调用；失败运行可定位。

### M2：DeepSeek 生成闭环

- provider interface、DeepSeek adapter、配置校验、timeout/有限重试。
- 版本化 prompt、结构化输出 schema、格式修复一次。
- 静态校验、AI 测试用例执行、SSE 生成进度。
- 基于用户追加要求创建修订版本。
- 记录 token、延迟和估算成本。

验收：三个基准需求均能生成并通过试运行；provider mock 可覆盖成功、限流、超时和非法 JSON。

### M3：Runner 加固

- 从 Hoya 提取/重写最小 QuickJS runner，移除远程 URL 执行和 UI/存储耦合。
- 强制时间、内存、输出、日志和并发限制；每次执行清洁上下文。
- 默认禁网；容器非 root、只读根文件系统、无宿主目录挂载。
- 错误分类、取消传播、过载拒绝、恶意样例与模糊测试。

验收：死循环、内存增长、日志洪泛、超大结果、宿主 API 探测和 SSRF 样例均被限制或拒绝，Runner 可继续服务后续请求。

### M4：产品化与发布候选

- 完整的空状态、错误状态、复制调用示例、停用和 key 轮换体验。
- 数据保留/清理任务，日志脱敏，基础用量与成本页面。
- E2E、故障注入、备份恢复说明和部署文档。
- 明确“仅本地/受信用户预览”或完成多租户安全评审后再开放公网。

验收：达到 RFC 0001 成功指标和 RFC 0003 主流程完成定义。

## 3. 测试矩阵

- 单元：状态转换、hash、key 校验、schema、policy、错误映射、成本计算。
- 契约：Node 请求与 Rust 响应对同一 JSON schema 兼容。
- 集成：SQLite migration、DeepSeek mock、Runner timeout、发布事务。
- E2E：创建 → 生成 → 自动测试 → 试运行 → 发布 → Webhook → 日志。
- 安全：SSRF、密钥泄漏、原型污染、超大/深层 JSON、死循环、内存/日志炸弹。
- 恢复：进程在 generation/run 中途退出，重启后非终态可被识别并安全处理。

## 4. 基准需求集

首批持续回归至少覆盖：

1. 输入订单数组，按币种汇总有效订单金额并返回 JSON。
2. 校验 Webhook payload 的必填字段，规范化字符串后输出新对象。
3. 输入一组事件，按类型分组计数并忽略未知类型。

网络调用用例留到 capability policy 完成后再加入，避免为了演示过早开放任意出站请求。

## 5. 开工前需要落定但不阻塞规划的问题

- Hosta 的许可证和目标部署平台；
- MVP 是严格单用户本地模式，还是从第一天加入账号登录；
- DeepSeek 账户对应的 base URL、模型配置名和预算上限；
- 是否将 Hoya 代码复制进 monorepo、作为独立 crate 依赖，或只参考后重写。

默认建议：单用户本地模式；Hosta monorepo 内新建最小 runner，并从 Hoya 按需迁移经过测试的执行代码，避免继承无关页面和远程 URL 执行接口。

## 6. 暂不建设的基础设施

在单机 MVP 证明主流程前，不引入 Kubernetes、Kafka/NATS、Redis、微服务拆分、服务网格、向量数据库或多模型路由。外部队列和 PostgreSQL 的触发条件是多进程/多节点执行、需要可靠异步任务，或 SQLite 已成为经测量的瓶颈。

