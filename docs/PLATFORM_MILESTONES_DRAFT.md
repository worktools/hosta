# WASI / QuickJS 平台改造：issues 与 milestones 审阅草案

状态：**项目暂缓（2026-09-23）**。本文保留为未批准的历史草案，下列新 issue/milestone 未创建、未启动；原双运行时方向待重新决策。[当前决定](WASI_JS_PLATFORM_PLAN.md)。

补充评估见 [标准演进与产品成立条件](PLATFORM_PATH_ASSESSMENT.md)。下文保留首版拆分供对照；建议修订为 B1 提前有界 HTTP/项目流程、B2 包含最小凭据、B0 起持续维护标准兼容。API 的 Streams/取消依赖需要先确认，不能按首版清单机械拆开。修订尚待 review。
依据：维护者确认 Wasmtime 本地已经升级，QuickJS 长期维护 WinterTC 子集。现有规划入口为 Hosta #20、Hoya #15/#16；本草案替代其中以 Wasmtime 33 为限制、把完整 Web API 作为潜在终点的表述。

## 决策基线

- WASM 面向 WASI 0.3.1 / Component Model，使用已升级的 Wasmtime；实现时固定实际验证通过的工具链版本、特性和 WIT 依赖。版本固定用于可复现构建，不是限制升级。
- 当前会话 checkout 中 Hoya Cargo.toml 为 33.0.0、Cargo.lock 为 33.0.2，PATH 中 CLI 为 18.0.3。这仅表明本会话未定位维护者升级后的构建环境；需核对实际 checkout/依赖/二进制/CI，不能将旧 checkout 当作未来架构约束。
- QuickJS 持续以显式版本化的 WinterTC 子集为产品目标。采用标准 API 的名字与行为；未实现项公开列出。新增 API 由实际 FaaS 场景驱动，完整 WinterTC、Node.js 或浏览器兼容不是验收目标。
- Hoya 拥有 guest WIT/JS binding、执行协议、隔离、资源预算与能力执行；Hosta 拥有版本/发布、入口、授权配置、任务状态与 CLI。共享契约在 Hoya 维护，由 Hosta 固定版本消费。
- JSON 函数入口先保留；原生 HTTP handler/streaming 是明确的后续里程碑。既有 artifact 的兼容与回滚单独验收，不要求永久维持每一种旧 ABI。
- 全程 CLI/API 验收、UI 展示优先。里程碑按退出门槛推进，暂不设日期。

## Milestones 草案

两仓库使用相同名称；GitHub milestone 各仓库独立，通过 Hosta #20 的依赖清单汇总进度。

| Milestone | 用户可见结果 | 完成门槛 |
| --- | --- | --- |
| B0 · 运行时契约与能力声明 | 用户能查清产物、API 和权限是否受支持 | 固定工具链记录；WIT/JS 契约、支持矩阵、doctor 和拒绝路径通过 |
| B1 · WASI 与 WinterTC 子集执行预览 | Rust component 和 QuickJS 函数都能通过 CLI 发布、调用、回滚 | 真实双运行时 E2E；旧产物回归；超时、内存与隔离验证；不依赖网络能力 |
| B2 · 受控异步 I/O 与 HTTP | 两种运行时可按同一授权策略访问 HTTP；HTTP 入口支持正确取消与背压 | 异步生命周期、出站策略、HTTP/streaming 端到端及负例通过 |
| B3 · 可复现发布与性能验收 | 可安装、升级、诊断，并有可信性能基线 | 兼容矩阵、恢复/回滚、配额、资源回收和性能报告通过 |

依赖：B0 → B1 → B2 → B3。B1 的 WASM 与 QuickJS 实现可并行；B2 的运行时开发可先开展，但启用公共出站必须先完成策略和资源门槛。性能基线从 B1 开始采集，在 B3 做发布验收。

## 拟准备的 issues

以下临时编号用于讨论；review 后再创建或拆分。每个 issue 的验收包含文档和必要的真实引擎测试。

### B0

**Y-A：确认实际工具链与运行时能力矩阵（Hoya，新增，P0）**

- 核对升级后的 checkout、Cargo.lock、CLI、构建产物与 CI；记录实际 Wasmtime/QuickJS/WIT/bindings 版本与启用特性。
- 最小 fixture 验证 Component Model、目标 WASI 接口和 0.3.1 所需特性；失败显示具体缺失项。
- 输出可复现命令和兼容矩阵，不把本机 CLI 版本等同于嵌入库版本。

**Y-B：定义 FaaS guest 契约与能力 profile（Hoya，新增，P0）**

- 分开声明执行协议、artifact 格式/ABI、WASI 接口版本、WIT world、JS API profile；避免把一切压成 runtime="wasm" 或一个版本号。
- 提供版本化 WIT invoke 草案、JS 声明、输入/结果/错误/日志 fixtures；定义 deadline、取消和资源所有权。
- WinterTC 首批范围建议 URL/URLSearchParams、TextEncoder/TextDecoder、Headers、Request/Response 的有界内存 body；AbortSignal 和 Streams 在 B2 开放。方法级记录支持情况与偏差，不用空实现伪装支持。
- 实现机制决定前核对依赖；标准 API 优先复用成熟实现，通过选定的上游测试验证。

**H-A：在 doctor 与版本模型中暴露运行时契约（Hosta，拆自 #20，P0）**

- doctor 列出 ABI、WASI/WIT world、JS profile 与允许能力；区分宿主支持和应用已获授权。
- 上传/发布检查兼容性，版本与部署固定契约及能力配置；不支持时返回稳定错误码与可行动原因。
- 依赖 Y-B；延续 #13 CLI 约定，不重复新建 CLI 框架。

### B1

**Y-C：WASI component JSON 函数执行路径（Hoya，拆自 #15，P1）**

- 实现 component 加载及所选 invoke world；显式区分旧核心模块和新 component。
- 能力默认拒绝，校验 import/world/hash；覆盖超时、资源释放、错误映射、过载及旧 ABI 回归。
- Rust component 示例可独立构建/执行；依赖 Y-A/Y-B，复用 #7 的资源预算验收。

**Y-D：QuickJS WinterTC 基础子集（Hoya，拆自 #16，P1）**

- 实现 Y-B 确认的 API 范围，保持现有 main(input, ctx)；运行实际 API 行为测试和选定上游测试。
- 区分语言能力、Web API、平台 ctx binding；支持清单和偏差纳入 JS profile 版本。
- API 覆盖扩张不作为成功指标；内存、初始化时间和兼容性结果可复现。

**H-B：双运行时 CLI 部署闭环（Hosta，拆自 #20，P1）**

- component/JS 上传→试跑→发布→调用→日志→版本切换→回滚均验证 hash、ABI/profile 与能力。
- 纯命令行真实 Hoya 集成，保留旧产物回归；构建产物不提交仓库。
- 依赖 H-A/Y-C/Y-D；复用 #7 构建、#5 部署和 #8 查询能力，仅补缺项。

### B2

**Y-E：异步宿主调用、取消与预算（Hoya，新增，P0）**

- QuickJS 事件循环/Promise 与 WASI async 调用都服从 invocation deadline；定义响应结束、未完成任务、客户端断开和强制终止语义。
- AbortController/AbortSignal、所需 Streams 子集按标准行为实现；取消释放 socket、stream、Promise 和 worker 资源。
- 限制并发 I/O、宿主缓冲、总字节与调用次数；不默认支持无界后台任务或所有 timers。
- 依赖 B1；归入 #7 的资源治理验收体系。

**Y-F：共用出站策略与 fetch / wasi:http client（Hoya，扩展现有 #8，P0）**

- 使用同一策略处理 JS fetch 和 WASI HTTP；覆盖目的地、DNS 重绑定、内网/元数据地址、重定向、凭据、超时和字节限制。
- 未授权拒绝；对 policy、超时、网络错误提供稳定分类。策略配置由 Hosta 提供，Hoya 负责执行。
- 正常 HTTP fixture 与 SSRF/超限/取消负例跨运行时一致；依赖 Y-E。

**H-C：应用能力授权与 HTTP 入口（Hosta，新增，P1）**

- CLI/API 管理版本化授权，支持预览差异、显式发布和回滚；输出不得泄露秘密。
- 配合 Hoya HTTP handler adapter（WASI service、QuickJS Request/Response）传递状态码、header、body、stream 和取消，定义执行完成时点与日志终态。
- 大体积响应不写入运行 JSON；通过有界流传输。流在 Hosta→Hoya→worker 各段的协议与背压设计需先 review。
- 依赖 Y-E/Y-F 和 #10 的治理；HTTP adapter 的 Hoya 代码在 #15/#16 子任务跟踪。

### B3

**H-D / Y-G：发布、兼容与性能门槛（扩展两仓库现有 #11，P1）**

- 固定实际验证过的工具链和引擎版本，提供跨仓库 CI、示例、升级/回滚步骤。
- 固定硬件、负载和产物测 cold/warm 延迟、p95、吞吐、RSS、构建大小与取消后资源回收；B1 建基线，B3 根据测量确定阈值，避免凭空承诺数字。
- 明确旧 ABI 支持窗口；按收益再决定编译缓存/worker 复用，独立验证跨请求状态隔离。
- #10 的持久化/恢复与两仓库资源、权限问题达标后才开放相应发布能力。

## 已有 issues / milestones 如何处理

- Hosta #20 保留跨仓库总览；Hoya #15/#16 保留两条运行时工作的总览。拆出具体子 issue 后补 task list 与依赖，不重复保留同一验收工作。
- A0/A1/A2 的已有工作继续按真实验收状态管理。已合并首个切片不等于整项完成；本次新计划不批量关闭或迁移旧 issue。
- #7/#8/#11 等跨阶段父 issue 保留原里程碑；给 B 阶段新增子 issue 引用父项。一个 issue 不同时承担多个 milestone 的交付。
- 暂缓独立立项：完整 WinterTC、Node 兼容、JS→WASM 替代引擎、通用文件系统/裸 socket、任意 npm/ESM 模块加载，以及 KV/secret 产品接口；出现明确场景后单独 review。

## 请重点 review 的建议

1. B1 先交付 JSON 函数与 WinterTC 基础对象，原生 HTTP/流放 B2。
2. 首批 JS API 以 Y-B 的清单为准，持续维护显式子集；新增 API 逐项验收。
3. B0–B3 以验收门槛管理，不先设日期；保持既有 A 系列历史归属，用子 issue 连接新阶段。
