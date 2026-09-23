# 路线评估：标准演进与产品成立条件

2026-09-23；**项目已决定暂缓**。本文保留研究依据和备选建议，未批准任何最终路线。相关规划 issues 标记暂缓，milestones 不启动；见 [当前决定](WASI_JS_PLATFORM_PLAN.md)。

## 判断

路线可行：Wasmtime/Component Model 承担 WASM 标准运行时，QuickJS 提供明确的 WinterTC 子集，Hosta 负责部署与操作体验。这能支撑以开发者和 agents 为用户、自托管的受控函数平台。它尚不足以证明公开多租户平台的运营能力，也没有用户采用或性能实测数据来证明商业成立。

最主要风险是兼容工作变成两个运行时的持续维护负担，而产品需求被 ABI 和 API 清单推迟。应同时交付两类证据：升级标准后旧应用仍正确运行；真实用户能用 CLI 独立完成有价值的任务。

## 标准演进的具体风险与应对

| 风险 | 后续表现 | 设计/验收要求 |
| --- | --- | --- |
| 运行时升级不等于完整工具链升级 | WIT、绑定生成器和 guest 编译器与宿主不匹配，实例化或执行失败 | 维护已测试的整套版本组合；固定生产发布，候选组合跑同一 corpus；安全修复与新增 guest API 分开交付 |
| 任意拼装子集导致组合爆炸 | 每应用一组不同 polyfill/API，无法解释兼容性 | 少量命名 profile，声明依赖闭包与标准/测试快照；权限配置独立于 API 版本；全局对象存在不表示应用获得出站权限 |
| Web API 只有同名外观 | bodyUsed、clone、重复 header、取消或错误类型与库预期不同 | API 名字之外验证行为；复用维护中的实现，固定 WPT 子集、通过/失败/未覆盖清单；Hoya 不能用自定义返回值代替标准 fetch 异常语义 |
| 自定义 WIT 逐渐替代标准接口 | 标准 component 必须改代码才能进 Hosta | HTTP 优先采用 wasi:http 标准 world；自定义 invoke 仅服务 JSON/非 HTTP 函数，平台特有 binding 单独命名/版本化；用未导入平台扩展的组件在另一匹配宿主上验证可移植性 |
| 共享接口变成最小能力交集 | 为照顾另一运行时而放弃标准的原生行为 | 共享授权、预算与平台错误分类；保留 WASI 和 JS 各自原生类型/错误/入口；平台扩展通过 adapter 对齐 |
| 无限兼容旧版本 | 安全升级被旧行为锁住，测试矩阵失控 | 建议一个稳定 profile 代际、前一代有限维护、下一代试验；评审后明确窗口与退出条件，不能靠永久运行旧引擎维持兼容 |

标准事实：WASI 将采用的 Component Model 特性累计作为版本要求，工具链支持仍需逐项确认；官方迁移说明特别提示 WIT/生成器/运行时不匹配的风险。[WASI releases](https://wasi.dev/releases)、[WASI 0.3](https://wasi.dev/releases/wasi-p3)。Wasmtime 的发布与兼容政策独立于 Hosta 的应用契约，应独立跟踪。[Wasmtime release process](https://docs.wasmtime.dev/stability-release.html)

WinterTC 完整符合性要求覆盖其列出的接口。本项目定位应一直表述为“遵循 WinterTC 的指定子集”。标准对象之间有依赖，例如 Request/Response 的 Body 接口具有 ReadableStream、bodyUsed 和消费规则；即使 HTTP 传输第一版采用有界缓冲，也不能将其伪装成无状态字符串对象。[WinterTC](https://min-common-api.proposal.wintertc.org/)、[Fetch Body](https://fetch.spec.whatwg.org/#body-mixin)。[WPT](https://web-platform-tests.org/)是可复用的行为测试来源，需补运行环境适配和本平台预算/策略测试。

建议 B0 增加一项持续任务“标准变更与兼容回归”：每个上游稳定发布产生差异评估；明确负责维护的仓库/负责人；候选引擎运行固定 WIT、旧应用 corpus、选定 WPT、跨仓库 E2E 和性能测试；发布兼容矩阵后才提升为稳定。未通过留在实验支持，不改变现有部署行为。评估周期和安全响应期限应根据实际维护人力确定。

## 产品化：建议先证明什么

建议首个可交付定位：**自托管、CLI/agent 友好的受控短函数平台，用于 Webhook、轻量 API 和自动化中的数据处理/外部服务调用。** 这是待用户验证的产品假设。JavaScript 降低开始使用的成本；WASM 接纳其他语言产物并提供明确的 guest 边界；两者共用一次部署、观察、回滚流程。

三个验收场景应持续跑通：

1. 无网络数据转换/校验：从项目目录测试、发布、调用、查看输入输出和错误、回滚。
2. 入站 Webhook/轻量 API：保留 method、URL、原始 body 和必要 headers，可返回自选状态与 headers；验签场景需要时再引入经过测试的 HMAC/密钥 binding。
3. 调用获准的外部 HTTP 服务：由应用权限和凭据绑定完成授权，超时/失败可诊断；结果不确定时不自动重放副作用。

“能执行 echo”只能证明运行通路，不能证明场景价值。建议用首次成功部署时间、独立完成/诊断/回滚率、升级后旧应用通过率和真实项目重复使用来决定是否增加 API；测试通过率与性能数据另外记录，不能代替用户证据。

当前计划需要修正的产品缺口：

- **完整 HTTP 放得过晚。** B1 至少有界支持标准 HTTP 请求/响应，首版传输可缓冲；B0 先定取消、资源所有权和流扩展边界，B2 再提供跨进程流和受控出站，减少以后重写入口。
- **项目而非单文件上传。** B1 提供最小 manifest、固定 profile、构建/测试/发布流程和可复现产物。先支持离线打包后的依赖；没有必要同时开放运行时远程 npm 加载。源码引用、lockfile、sourcemap 与诊断也需有归属。
- **凭据不能与通用 KV 一起无限延后。** B2 的外部服务调用应包含最小权限绑定、轮换、脱敏和审计；默认不把宿主密钥放进 worker 环境。可优先考虑由 broker 向获准目的地注入凭据。若确需 guest 读取明文，必须明确授权边界，不能承诺阻止已获权 guest 主动输出秘密。通用数据库/KV 可继续延后。
- **取消不是撤销。** 杀掉执行进程不撤销已发出的请求；状态必须区分执行终止与外部副作用未知。已开始流式响应后不能改写成 JSON 错误；运行终态需独立记录。
- **生产可用性不由 ABI 保证。** 事务持久化、限流、日志保留/敏感输入处理、备份恢复、稳定安装升级属于首个可靠预览版门槛。当前进程隔离到公开多租户之间仍需要权限/网络/OS 资源与控制面隔离工作，应另立目标，不能隐含在 B3 中。
- **性能收益尚未证明。** 两种引擎、worker 启动/编译和 Hosta↔Hoya 数据搬运都有成本。以代表性任务测冷/热延迟、峰值 RSS 与吞吐；优先减少重复编译/大对象复制，再评估池化，避免为了缓存放弃隔离。存储格式与控制 API 不应承担大型流 body。
- **开源采用需要交付保障。** 许可证选择、可复现安装、支持范围、独立 Hoya 发布、依赖升级说明与贡献入口也在两仓库 #11 的交付范围；这些应纳入预览完成标准。

## 对 milestones 的建议修订

| 阶段 | 调整后的退出门槛 |
| --- | --- |
| B0 | 工具链和少量命名 profile、标准变更机制；决定 guest 入口/取消/流扩展契约；三个真实场景写成验收用例 |
| B1 | JSON + 有界 HTTP 的双运行时闭环；依赖完整的基础 Web API 子集；manifest/离线打包/本地测试；首轮用户任务与性能基线 |
| B2 | 异步出站 + 最小凭据绑定 + 跨进程流/取消；权限/超时/资源回收/副作用未知可观察；外部服务场景验收 |
| B3 | 可复现自托管发布、持久化/恢复、可见支持窗口与升级演练；用户场景证据和性能回归门槛；公开多租户另行评审 |

在旧草案上拟新增：Y-H“标准跟进与兼容回归”（B0 起持续）、H-P“项目 manifest 与可复现开发流程”（B1）、H-S“最小凭据绑定与生命周期”（B2）。Y-B/Y-D 必须先处理 API 依赖闭包，Y-E 的取消/资源生命周期设计提前到 B0，H-C 拆为 B1 有界 HTTP 与 B2 流/授权。不把小功能强行做成一堆平级 issue；先按交付结果确认拆分。

以上保留为 review 建议；不启动对应任务，也不表示性能或用户需求验证已完成。

## 备选方向：收敛 WASM，停止 QuickJS / WinterTC 扩展

这是待 review 的替代方案，尚未决定移除 JS，也未修改代码或远端计划。

**建议倾向：停止自研 QuickJS Web API 的扩展，把 WASI component 作为新的主交付格式；对已有 QuickJS 路径做有限迁移。** 适用于优先交付可维护的自托管函数平台、而非把“直接运行 JS 源码”作为核心用户承诺的情况。

| 方案 | 收益 | 代价 | 建议 |
| --- | --- | --- | --- |
| 继续 native QuickJS + WASM 双路线 | JS 源码直接运行，平台可独立控制 JS API | 两套异步/权限绑定、标准测试和资源生命周期长期维护 | 只有真实 JS 使用需求足以支撑成本时继续 |
| 停止 QuickJS 扩展，WASM 为主，旧 JS 有限兼容 | 可逐步收敛宿主能力和标准升级矩阵，迁移可控 | 过渡期仍有兼容维护 | 当前更推荐 |
| 立即移除 QuickJS | 最快缩减依赖与代码 | 破坏旧 JS 应用及平台内部脚本功能 | 先核对实际使用与替代方案；无使用时可缩短过渡 |

主路径的收益主要是维护精力集中：不必自建 QuickJS Web API/事件循环，不必为两种原生引擎分别绑定 HTTP、取消、密钥和宿主资源。Wasmtime 和 WASI 工具链的兼容、资源/网络政策、构建隔离、产品持久化仍然需要维护，不能据此承诺运行更快或隔离自动完成。

### 产品取舍

产品定位相应改为“面向开发者与 agents 的 WASI component 部署与运行平台”。先保证一个维护良好的语言模板（建议 Rust）及项目级 build/test/deploy；其他语言按工具链支持逐个验收，不宣称所有能生成 .wasm 的语言都可直接运行。发布入口接收 component，CLI 承担源码到产物的可复现流程。

会损失 JS 单文件即跑的便利；构建、依赖下载、错误定位和首次使用门槛更高。需要完整脚手架、构建诊断与本地执行反馈来抵消。若目标用户主要粘贴 JS 自动化脚本，这条取舍可能削弱核心价值，必须用实际项目验证。

“删除原生 QuickJS”不必等于“永远不支持 JavaScript”。[ComponentizeJS](https://github.com/bytecodealliance/ComponentizeJS)可将 JS 连同 SpiderMonkey 运行时封装为 component，但官方仍标为实验性，其 JS/Web API 和 async 支持取决于工具链。它是未来可选的构建适配器；不能未经验证就作为移除 QuickJS 的等价替代。

若以后验证 JS→component，应检查目标 WASI/WIT 版本、API 行为、产物大小、构建时间、冷启动、RSS、错误栈与安全升级。包含 JS 引擎的组件会带来体积与供应链成本；当前 Hoya v1 的 1 MiB artifact 上限不能被视为新 component 路径的合理固定预算。此类工具还可能在构建时执行 guest 顶层代码，构建隔离和凭据隔离必须保留。嵌入 JS 引擎的安全修复需要重建/发布受影响产物，不能只升级 Hoya 宿主。

### 移除前的具体依赖

本次代码检查确认并不只有用户函数依赖 JS：

- `src/executor.ts` 的 runMigration 将迁移脚本作为 JS 发给 Hoya。
- `src/routes/pages.ts` 的 processScript 固定包装成 JS 执行。
- `src/routes/apps.ts` 与生成流程默认 JS；`lib/hoya-client.mjs` 要求引擎同时声明 javascript/wasm，否则 doctor 判定不兼容。
- 类型、模板、CLI 文档、旧版本元数据与 E2E 都包含双运行时假设。

应先清点实际依赖，再分别选择迁移为显式 component 调用、替换为必要的声明式处理或在清晰告知后退役遗留功能；不把脚本转移回 Hosta 的 Node 进程执行。保留已有版本/运行历史，对不可执行的退役版本给出明确状态和迁移指引。存在实际旧部署时才定义兼容窗口，不以猜测制造永久维护义务。

### milestones 如何收敛

- B0：采用 WASM 主线决策、契约/工具链、旧 JS 使用盘点和退出方案；去掉 WinterTC profile 实现任务。
- B1：WASI component JSON/有界 HTTP + Rust 项目 CLI 闭环；改 doctor 为按 artifact 的实际能力验证，处理内部 JS 功能依赖。
- B2：WASI async/HTTP 的权限、凭据、流/取消与治理；无需同步实现 QuickJS fetch。
- B3：发布、性能、兼容升级及旧 JS 退役验收。JS→component 仅按用户需求另开构建工具验证，不阻塞主线。

待 review 后：Hoya #16 可标记 deferred/superseded，#15 成为主线；Hosta #20 和里程碑草案去掉双运行时硬门槛，新增“旧 JS 依赖与迁移”。单纯将 QuickJS 拆到另一个仓库不会减少维护成本，因此不以新建仓库作为默认第一步。

## 与社区方案比较：先决定复用边界

资料核对：2026-09-23。以下依据官方文档/公告，未安装或跑对比 benchmark；“支持”需落实到选定发行版和目标 world，WASI 0.3 的公告不能替代 0.3.1 全部特性及平台完整验收。

| 方案 | 官方支持证据及已有能力 | 对 Hosta/Hoya 的影响 |
| --- | --- | --- |
| Wasmtime + wasmtime-wasi/http | 官方 WASI 说明列出最终 0.3 支持；提供可嵌入运行时，serve 是开发测试入口 | 自建执行服务的可靠基础，但发布、权限、记录、恢复、网关等仍需实现；不把 serve 当完整生产 FaaS |
| Spin 4 | 官方 4.0 公告称稳定支持 WASIp3；manifest/build、HTTP、能力配置、变量、KV/SQLite 等已有文档 | 与轻量函数平台方向最接近，是最应先试用的复用候选和产品基线；我们的 B1/B2 很多工作已有实现 |
| wasmCloud 2.x | 官方 runtime 文档声明自 2.5 起启用 WASI 0.3，支持 P2/P3；有 host plugins、配置/密钥、存储及 Kubernetes 路径 | 更适合较丰富的服务/能力绑定和集群部署目标；开发可用 wash dev，不应笼统说所有用法都必须 K8s；平台对象模型/运维依赖需评估 |
| SpinKube | 将 Spin 应用集成进 Kubernetes，包含 operator、containerd shim 等 | 已有 K8s 运维时可考虑；其具体 WASI 支持受所用 Spin/执行器版本约束，不能直接从 Spin 4 的公告推导全部组合可用 |

来源：[WASI 0.3 runtime support](https://wasi.dev/releases/wasi-p3)、[Wasmtime serve 适用范围](https://docs.wasmtime.dev/cli-options.html#serve)、[Spin 4 公告](https://spinframework.dev/blog/announcing-spin-4-0)、[Spin manifest](https://spinframework.dev/v4/manifest-reference)、[wasmCloud runtime](https://wasmcloud.com/docs/runtime/)、[wasmCloud 安装路径](https://wasmcloud.com/docs/installation/)、[SpinKube overview](https://www.spinkube.dev/docs/overview/)。Wasmtime 在线 API 文档仍有将 P3 标为 experimental 的文本，因此嵌入 API 的稳定程度须按实际选定发行版验证，不仅根据发布概述推断。

### 竞争与复用判断

停止 QuickJS 后，WASM 引擎和 HTTP 执行本身更缺少自建差异。CLI/agent 也不是独占价值：例如 [wash CLI](https://wasmcloud.com/docs/wash/commands/)已经公开 JSON output、非交互选项。Hosta 可验证的价值应是“目标用户是否用更少配置完成安全的发布、查询、诊断、升级与回滚”，而不是再包装一套命令。

候选方向：Hosta 做面向指定用户场景的控制面，底座先选一个社区方案验证；Hoya 若继续独立维护，职责可收敛为执行接入/生命周期适配服务，或保留明确有价值的独立执行协议。它不必同时重新实现组件加载、Web API、KV、能力路由和集群调度。不要一开始承诺支持多个后端，否则会把双引擎维护负担换成多平台适配负担。

仍需验证的映射问题包括：Hosta 每次调用的 runId/hash 与平台日志关联；部署/就绪/版本切换并非一次性执行；取消与资源回收；共享进程和现有每次独立 worker 的隔离差异；权限/secret 配置是否能一对一落地；平台扩展的可移植性；失败终态和外部副作用未知。不能把 shell 调用 spin up 或 wash dev 当成完整执行适配器。

### 建议将社区底座验证置于新功能开发前

建议首先以 Spin 作为轻量场景的对照，wasmCloud 作为能力绑定/集群需求较强时的候选；Wasmtime 直接嵌入作为自建成本的比较基线。本轮仅提议验证，不代表选型已完成。

1. 固定版本，用同一组标准 HTTP component 跑 JSON API、获准外部调用和慢响应取消；检查目标 WASI/WIT imports/exports。使用平台特有存储时另列其依赖，不能宣称同一产物任意宿主可用。
2. 用 Hosta 的核心操作完成 create/deploy/invoke/query/rollback，核对 run 与版本、凭据不暴露、故障诊断及重启恢复。记录需新写和重复维护的代码。
3. 对比首次部署步骤、安装依赖、冷/热 p95、RSS、失败/取消后的资源回收、升级迁移负担；相同硬件和负载下测量，不按社区性能宣传直接排序。
4. 决策：若社区已满足产品场景，优先复用；如果缺口仅在运行历史/agent 工作流，补 Hosta 控制面；只有找到明确、可复现且难以扩展解决的执行缺口，才扩展 Hoya 自建宿主。若 Hosta 也没有可验证优势，则直接使用/贡献上游是可接受结果。

拟将此项作为 B0 首个“复用还是自建”决策 issue。原 B1/B2 中与上游重叠的实现工作，在该决策完成前不全部排入开发承诺。该验证尚未启动，规划事项随项目暂缓。
