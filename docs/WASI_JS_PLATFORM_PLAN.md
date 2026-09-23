# 面向 WASI 0.3.1 与 QuickJS 的 FaaS 改造计划

更新：2026-09-23。此文是设计与验收计划，当前产品仍使用 Hoya execution v1；不得把计划中的 WASI、HTTP、`fetch` 或模块加载能力标为已实现。

## 依据与当前差距

- [WASI 0.3.1 发布说明](https://github.com/WebAssembly/WASI/releases/tag/v0.3.1)与[WASI 0.3 官方说明](https://wasi.dev/releases/wasi-p3)：0.3.0 引入 Component Model 原生 `async func`、`future<T>`、`stream<T>`；0.3.1 增加所需 Component Model 的 `map<K,V>`、`implements` 和 `external-id`。它不是把旧 WASM 模块重新编译就能使用的 ABI 更新。`wasi:http/service` 暴露异步请求处理器；`middleware` 用于组合。`wasi:io` 在 0.3 中移除。
- [WASI 运行时支持说明](https://wasi.dev/releases/wasi-p3#runtime-and-tooling-support)：最终 0.3.0 起点为 Wasmtime 46；43–45 对应先前 RC。0.3.1 验收还须逐项验证运行时与绑定生成器对新增 Component Model 特性的支持，不能把“能跑 0.3.0”写成“支持 0.3.1”。文档建议同一套 WIT、运行时和 bindings 版本固定；WASI 0.2 component 可作为过渡路径。
- 现有 Hoya 使用 Wasmtime `33.0.0`、`wasm32-unknown-unknown` 原始模块、`hoya_main() -> i32` 指向 NUL 结尾 JSON 的 `hoya-json-v1` ABI；只链接少量 `env` import，不链接 WASI。Hoya v1 协议还拒绝所有非空 `capabilities.network`。Hosta 以 JSON input/result、版本 hash 和 runId 调用它。现有 JS 是 QuickJS 脚本 `main(input, ctx)`，只暴露 `ctx.log/now/datasource`，没有 ESM、`fetch` 或异步宿主 I/O。参见 [Hoya v1 契约](https://github.com/worktools/hoya/blob/main/docs/engine-v1.md)。

## 目标与边界

保持 Hosta 负责应用/版本/发布、入口路由、密钥和可观测性；Hoya 独立负责 guest 运行、资源预算和 host capability 执行。先定义共同的**平台能力语义**，再分别绑定到 WASI component imports 和 QuickJS API。WASI 的规范版本、Hosta/Hoya 的 HTTP 执行协议版本、FaaS guest API 版本分别记录，不能共用一个“v2”标签。

建议先保留当前 JSON 函数形态，新增 `component-wasi-0.3.1` 作为并存的 artifact ABI；未来需要原生 HTTP 流时再选 `wasi:http/service`。WASI `service` 适合 HTTP 处理器，但不能自然代表队列、定时任务等非 HTTP 事件；这些可通过 Hosta 定义的版本化 WIT `invoke` world 表达。两种 world 应有清晰的互通边界，不能偷偷把 JSON v1 冒充为 WASI。

### 候选能力模型

| 能力 | WASM component | QuickJS | 平台约束 |
| --- | --- | --- | --- |
| 基础调用 | 自定义 WIT `invoke`，或可选 `wasi:http/service` | `main(input, ctx)`；后续可选标准 `Request -> Response` handler | 请求、结果、错误、runId、traceId 和版本 hash 一致；保留 v1 |
| 时间/随机 | `wasi:clocks`、`wasi:random` | `Date`/Web Crypto 中选定子集 | 明确安全随机、可测时钟和预算；不宣称完全等价 |
| 出站 HTTP | `wasi:http` client import | 标准 `fetch`/`Request`/`Response` 形态 | 默认拒绝；Hosta 授权，Hoya 校验目的地、DNS/重定向、大小、超时与取消；同一策略引擎 |
| 数据/密钥 | 平台自定义 WIT import | `ctx` 中的专有 binding | 按应用/版本最小授权；密钥值不进入部署历史、URL、普通日志；审计访问 |
| 日志 | 平台 WIT log import | `ctx.log`，可考虑 `console` 兼容 | 统一级别、字段、截断与 runId，不能绕开预算 |
| 流/取消 | `stream<T>`、`future<T>`、async handler | Web Streams、`AbortSignal` 兼容层 | 背压、客户端断开、deadline、资源上限与清理一致 |

这里的 WIT world 和 JS `ctx` 是 **Hosta/Hoya 平台契约**，不是 WASI 标准的一部分。初始版本只承诺已有的纯计算、日志、时间和只读快照；出站、密钥、持久存储、流与定时器都要独立验收后才开放。WASI 导入的存在本身也不代替运行时的 URL、资源或租户策略。

## QuickJS 可参考的标准

- [ECMAScript](https://tc39.es/ecma262/)规定语言语义，QuickJS 是实现；它不定义 FaaS 的网络、密钥、存储或部署接口。
- [WinterTC Minimum Common Web API](https://min-common-api.proposal.wintertc.org/)面向服务器 JS 运行时，列出 `Request`/`Response`/`Headers`、`fetch`、Streams、`URL`、`AbortController`、Web Crypto、计时器等可移植 API。可用它选择 JS 用户侧 API，并用标准 Web API 测试；当前 QuickJS 只提供很小子集，不能宣称符合该规范。授予 `fetch` 能力仍由 Hosta/Hoya 决定。
- [ComponentizeJS](https://github.com/bytecodealliance/ComponentizeJS)说明 JS 可以绑定 WIT/组件，但目前是实验性的 SpiderMonkey 路线，不等同于给当前 QuickJS 添加 WASI。未来若评估“JS 编译成 WASM component”，须单列技术验证和成本测量，不与 QuickJS 原生运行方案混为一谈。

建议 JS 先保持 `main(input, ctx)`，逐步加入标准对象与经授权的异步 I/O；等权限、模块打包、流和兼容测试稳定后，再评估 `export default async function(request, env, ctx)` 之类的 HTTP handler。不要为了类似浏览器而默认开放全局网络、文件系统、进程环境或无限定时器。

## 分阶段执行与退出门槛

1. **契约冻结与兼容矩阵（Hosta + Hoya）**：列出 artifact ABI、WASI 版本、JS API 版本、Hoya 执行协议和 capability 字段；明确默认拒绝及拒绝错误码。产出版本化 WIT 草案、JS TypeScript 声明、相同调用/错误/日志 fixtures 和迁移表。CLI `doctor` 必须区分“当前 v1 可用”“0.3.1 实验支持”“不兼容”；现有 JS 与 Rust WASM 测试不退化。
2. **WASI 0.3.1 可行性验证（Hoya）**：在隔离分支升级/并行引入支持 0.3.1 所需特性的 Wasmtime 与 bindings，固定依赖与 WIT；用最小 component 验证 `async func`、stream/future、`map` 与多实例接口导入；运行 WASI testsuite 相关用例。测冷启动、峰值 RSS、吞吐、超时、取消及错误映射。无法满足 0.3.1 特性时应明确降级为“仅 0.3.0/0.2 实验”，不伪称通过。
3. **双 ABI 与 CLI 端到端（Hoya → Hosta）**：Hoya 按显式 ABI 选择旧 `hoya-json-v1` 或 component，不自动猜测；Hosta 上传时验证 component/WIT、hash 与能力声明，版本和部署锁定 ABI，CLI 上传、试跑、发布、调用、回滚都输出该 ABI。无 AI、无 UI 的 Rust component 与旧 Rust/JS 回归共存；真实 Hoya 进程 smoke、协议负例和重启/过载验证通过后才列为预览能力。
4. **QuickJS 可移植 API 子集（Hoya → Hosta）**：先实现标准 `URL`、`Headers`、`Request`/`Response`、`AbortSignal`、必要 Streams 的可测试子集，再接策略受控 `fetch`；按实际支持列表运行 conformance/fixture 测试，并记录偏差。后续按需求添加 ESM bundling、Web Crypto 和平台 binding；同步 WIT/JS 权限矩阵。CLI `doctor` 和版本元数据报告 JS API 级别，旧 `main` 脚本继续运行。
5. **发布门槛与观测（Hosta + Hoya）**：新 ABI/API 先 opt-in；建立 JS/WASM 相同的拒绝、取消、限流、密钥泄露、跨应用隔离与出站 SSRF 测试。记录每种 ABI 的冷启动、p95 延迟、RSS、构建大小和失败率的基线及硬件/负载，达到约定阈值后再考虑默认切换。保持旧 artifact 的回滚路径和明确弃用窗口。

前置依赖：Hosta #10 的事务持久化和基本网关治理、Hoya #7/#8 的预算与出站策略、两仓库 #11 的发布/兼容矩阵；这些不必全部完成才做只读技术验证，但不完成就不开放生产能力。

## 跟踪任务

- [Hosta #20：平台契约与迁移](https://github.com/worktools/hosta/issues/20)
- [Hoya #15：WASI 0.3.1 component 验证](https://github.com/worktools/hoya/issues/15)
- [Hoya #16：QuickJS 可移植 API 与受控能力](https://github.com/worktools/hoya/issues/16)

执行顺序为契约/兼容矩阵与两个 Hoya 技术验证可并行，双 ABI 集成必须等待 WASI 验证，受控出站必须等待统一策略与资源预算。文档与 issue 的验收项要随着工具链实测更新，不依据未来预期提前变更产品能力声明。
