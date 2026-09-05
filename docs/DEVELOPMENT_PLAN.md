# 开发计划与 Issue 管理

评估日期：2026-09-06。状态：开发计划，未实施功能不得视作已完成。

GitHub 同步状态：**已同步并回读验证**：[worktools/hosta issues](https://github.com/worktools/hosta/issues) 共 11 项，附优先级/类型标签、A0/A1/A2 里程碑及双向依赖。完整结构化记录见 [issue-drafts.json](issue-drafts.json)。H 开头编号属于 Hosta，Y 开头属于 Hoya；这些是本地规划编号，不是 GitHub issue 号码。

Hosta 维护用户体验、应用/版本/发布、触发、构建和运维控制面；Hoya 独立维护 QuickJS/Wasmtime 执行服务、协议、隔离、host capabilities 和发布产物。通过版本化 HTTP 协议集成，不复制引擎源码，不建立跨仓库相对路径依赖。

## 交付原则

前期全部通过命令行验证，CLI/API 是主要操作入口。Hosta CLI 面向 agents：非交互、稳定 JSON、退出码、stdin/文件输入、明确版本及可恢复查询。UI 先只读展示应用/版本/运行状态，复杂交互待使用反馈后评估，不作为前期验收依赖。AI 与定时管理为可顺延增强。

## 交付阶段

| 阶段 | 用户可验收结果 | 退出条件 |
| --- | --- | --- |
| A0 双运行时执行基线 | 相同 JSON 服务由独立 Hoya 执行，故障不阻塞 Hosta | 协议与 ABI 固定；值绑定、资源预算、默认禁网、鉴权完成；双运行时契约与故障用例通过，基础 CLI 可用 |
| A1 开发者闭环 | 无 AI、无浏览器，通过 CLI 完成源码→版本→试运行→发布→调用→定位错误 | JS/Rust WASM 闭环、稳定 key、版本明确、可恢复创建与运行详情；MoonBit 通过兼容验证后开启 |
| A2 开源预览交付 | 干净环境可安装、升级、备份并参与贡献 | 持久化/恢复、真实 CI、发布兼容矩阵、文档与许可证选择完成；AI/定时管理为 P2 可顺延项 |

阶段是质量门槛，不承诺未经估算的日期。单个实现 PR 尽量在 1–3 个工作日内可独立评审；较大 issue 按验收条目拆子项，保留父项及依赖。CLI 命令/schema 设计和 fixture 准备可在 A0 期间推进，功能完成仍依赖真实 Hoya 验证。

## 管理规则

- P0：阻塞可信执行基线；P1：核心用户流程或预览版交付；P2：可延期增强。每项只有一个优先级、一个阶段、一个类型。
- issue 放在实现归属仓库；跨仓库需求用链接表达依赖，不在两边复制同一工作。
- 初始均不分配个人、不设假定日期；领取时指派负责人，每仓库建议至多 2 项正在实现，优先清除依赖。
- 开始前复核代码和依赖；完成时由 PR 关联 issue，附复现步骤、测试/演示和兼容影响。验收未全满足不关闭。
- 新 issue 必须包含用户问题、代码依据、验收和不做范围；重复项确认后链接原项关闭。本轮发布前两仓库已有 issue 数均为 0。
- 每轮发布检查未完成项和依赖，记录顺延原因；不以文档声称完成替代测试。已配置本任务每 30 分钟检查 PR 评论、Actions 和冲突；无变化时静默。

## 待办明细

### H1 · P0 · A0 · 通过独立 Hoya 执行 JS/WASM，移除平台进程执行路径

GitHub：[hosta #3](https://github.com/worktools/hosta/issues/3)

server.mjs execute 使用 node:vm 和 WebAssembly.instantiate，无 Hoya 客户端；Promise.race 无法中断同步死循环，WASM main 也无执行超时。

验收：

- [ ] 实现可配置 Hoya URL/token、协议兼容检查、健康状态与 Node adapter；手动、生成测试、诊断、Webhook、定时任务共用执行接口。
- [ ] 试运行与线上使用相同内容 hash、协议及限制；引擎断线、超时和版本不兼容返回可理解错误及 runId。
- [ ] 正常模式不能回退到 Node vm/WASM 执行；若保留 demo，明确隔离标识并禁止作为部署模式。
- [ ] 通过命令行启动独立 Hoya 进程并运行 JS/WASM fixtures；引擎故障和超时后 Hosta /health 及后续请求仍可用，不依赖浏览器完成验收。

依赖：[Y1](https://github.com/worktools/hoya/issues/5)、[Y2](https://github.com/worktools/hoya/issues/6)、[Y3](https://github.com/worktools/hoya/issues/7)、[Y4](https://github.com/worktools/hoya/issues/8)、[Y5](https://github.com/worktools/hoya/issues/9)。

### H2 · P1 · A1 · UI 先提供应用、版本与运行状态展示，收敛未验收交互

GitHub：[hosta #4](https://github.com/worktools/hosta/issues/4)

frontend/src/main.jsx 编辑 textarea 后 run/diagnose 仍请求 version.id；没有 dirty/pending 状态，刷新会重置编辑内容，version 为空仍可点操作。

验收：

- [ ] 提供只读应用列表、草稿/线上版本、引擎能力及健康状态、运行列表和详情；数据来自与 CLI 相同的 API。
- [ ] 展示 versionId、artifact hash、状态、时间、日志/错误和真实模型配置；不得写死 DeepSeek ready 或伪装已接入 Hoya。
- [ ] 现有编辑、运行和发布交互可暂时隐藏或禁用并指向 CLI 使用说明，避免执行旧版本或显示跨应用密钥；不要求完善网页编辑器、发布向导或 dirty-state 交互。
- [ ] 通过命令行驱动 API fixture 并执行组件渲染/展示断言，验证成功、失败、无数据、离线状态；浏览器人工交互不作为前期发布验收门槛。
- [ ] 后续是否恢复并细化网页创建/编辑/发布操作，根据 CLI 使用反馈单独评估，不在本项承诺。

依赖：[H1](https://github.com/worktools/hosta/issues/3)。

### H3 · P1 · A1 · 保持重新发布后的调用密钥稳定，提供停用、轮换和回滚

GitHub：[hosta #5](https://github.com/worktools/hosta/issues/5)

server.mjs publish 每次 randomBytes 后覆盖 keyHash；前端没有停用、独立轮换、回滚或可复制 curl；Editor 切应用未清 deployment 状态。

验收：

- [ ] 普通版本发布保持调用 URL 与 key 不变；CLI/API 独立提供显式 key 轮换，仅轮换时使旧 key 失效，并说明影响。
- [ ] CLI/API 提供发布历史、回滚到曾验证版本、停用/恢复；并发调用锁定开始时版本，返回部署和版本 ID。
- [ ] 首次发布/轮换仅本次响应返回密钥，CLI 可按用户选择输出且不写入常规日志；提供可运行的 curl 示例，状态查询和 UI 不返回历史明文密钥。
- [ ] 纯命令行端到端验证 v1 发布→v2 发布旧 key 可用→回滚→停用拒绝→轮换旧 key 失效；不要求网页操作。

依赖：[H1](https://github.com/worktools/hosta/issues/3)。

### H4 · P1 · A1 · 提供无 AI、纯命令行的首次部署指南与环境诊断

GitHub：[hosta #6](https://github.com/worktools/hosta/issues/6)

新建流程强制 create 后 generate；侧栏写死 DeepSeek ready；Rust/MoonBit 编译失败后留下无版本应用，页面未提供明确恢复路径。

验收：

- [ ] 通过 CLI 从 JS 模板、WASM 示例或已有源码创建；无模型 key、浏览器和交互式终端也能完成首次部署。
- [ ] hosta doctor/status 报告实际 Hoya/协议、模型可选配置和构建工具能力；缺依赖给出可复制修复命令，WASM 固定模板明确标为示例。
- [ ] 创建/编译失败返回机器可读 appId/jobId 与错误码，可在同一应用重试而不重复创建；文档演示该恢复路径。
- [ ] 从干净环境用 README 的 shell 命令完成 JS/Rust WASM 创建→上传版本→运行→发布→invoke→按 runId 查结果；每条 ≤10 分钟（首次依赖下载另记），脚本按退出码与 JSON 断言结果。

依赖：[H11](https://github.com/worktools/hosta/issues/13)、[H5](https://github.com/worktools/hosta/issues/7)。

### H5 · P1 · A1 · 把 WASM 源码编译变成可诊断、可复现的产物流程

GitHub：[hosta #7](https://github.com/worktools/hosta/issues/7)

server.mjs compileWasm 在控制面调用本机 rustc/moon；starter 与 Hoya ABI 不同；WASM 执行不使用用户 JSON 输入。

验收：

- [ ] 采用 Hoya ABI v1 示例，记录源码、工具链、编译参数、artifact hash 和构建日志，执行只传固化产物。
- [ ] 编译工具缺失、语法错误和 ABI 不兼容以稳定错误码、构建日志和修复建议通过 API/CLI 返回；不支持的语言在能力发现中明确禁用。
- [ ] 构建使用隔离且有时间/CPU/内存/输出/并发上限的环境，和请求处理解耦；编译器不获得平台 secrets。
- [ ] Rust 完整 JSON 输入输出优先验收；MoonBit 经相同 fixture 验证后开启；全部构建、上传和执行可用命令行完成，无网页编辑器依赖。

依赖：[Y1](https://github.com/worktools/hoya/issues/5)、[Y6](https://github.com/worktools/hoya/issues/10)。

### H6 · P1 · A1 · 通过 API/CLI 查询运行记录、结构化日志与可行动错误

GitHub：[hosta #8](https://github.com/worktools/hosta/issues/8)

前端只显示最近一次摘要和原始 JSON；API 附带最近 20 条运行，无分页详情体验；失败运行不能便捷关联源码版本。

验收：

- [ ] API 支持按状态/触发来源/版本筛选分页；详情包含 runId、versionId/hash、输入、结果、结构化日志和排队/执行耗时。
- [ ] 错误区分用户异常、超时、策略拒绝、过载、引擎离线和平台错误，返回稳定错误码、retryable 与下一步；秘密字段脱敏。
- [ ] 提供按 runId 查询/等待终态和带原输入重试，重试创建新 run 且带 retryOf；CLI 消费同一协议，UI 只读展示。
- [ ] 纯命令行覆盖成功、抛错、超时、引擎停机和分页，按 Webhook 返回 runId 查询并断言错误与日志；无浏览器验收要求。

依赖：[H1](https://github.com/worktools/hosta/issues/3)。

### H7 · P2 · A2 · 让生成任务可恢复，并以测试断言决定版本可发布性

GitHub：[hosta #9](https://github.com/worktools/hosta/issues/9)

generated tests 只执行，不比较 expected output，也未用失败结果改变 ready；生成无持久任务或进度，未生成 inputSchema；UI 必须经过 AI 创建。

验收：

- [ ] AI 是可顺延的可选增强，不阻塞无 AI 的 CLI 发布闭环；通过 API/CLI 暴露持久 generationId、状态、幂等提交、取消/有限重试和按原应用修订。
- [ ] 严格校验模型结构、inputSchema、至少正常/边界测试及期望值，逐用例执行断言；任何失败标 needs_revision。
- [ ] 生成版本发布必须满足生成测试断言和该版本显式试运行（CLI/API 均可）；已有代码/模板按其测试与显式试运行规则发布，无需经过 AI。schema 用于运行和 Webhook 输入校验。
- [ ] provider mock 覆盖超时、限流、非法 JSON、断言失败、刷新/重启恢复；记录 token/耗时，不伪造成本。

依赖：[H1](https://github.com/worktools/hosta/issues/3)。

### H8 · P1 · A2 · 引入可迁移持久化、执行恢复和网关基本治理

GitHub：[hosta #10](https://github.com/worktools/hosta/issues/10)

当前 data/hosta.json 全量直接 writeFile，串行保存链一次失败后会持续 rejected；重启无 running 状态恢复，/hooks 和 /invoke 无限流。

验收：

- [ ] 迁移到事务性持久化（建议 SQLite），导入旧 JSON 时备份和校验 app/version/deployment/hash；迁移失败可恢复。
- [ ] 持久化任务终态、幂等 key 和发布事务；启动识别中断任务并明确失败/可重试，不盲目重放副作用。
- [ ] 实现应用/实例并发、Webhook 限流、请求/存储配额、历史保留和分页；过载可重试且不泄露源码或内部地址。
- [ ] 故障注入验证写失败恢复、进程中断、重复提交、备份恢复、限流及长时间运行后存储有界。

依赖：[H1](https://github.com/worktools/hosta/issues/3)。

### H9 · P1 · A2 · 交付可复现的开源预览版、双仓库 CI 和贡献入口

GitHub：[hosta #11](https://github.com/worktools/hosta/issues/11)

README 与实际 WASM/UI 能力不一致；npm test 发现 0 个测试，未见 Hosta CI、LICENSE、贡献指南；旧 RFC 与独立 Hoya 方向冲突。

验收：

- [ ] 提供固定 Hoya 发布版本的 Compose 或等价单机启动方式，包含持久卷、readiness、模型可选配置与升级/备份说明。
- [ ] CI 从命令行执行真实 CLI/API E2E 与跨仓库 JS/WASM 契约集，无浏览器或 LLM key 前置条件；测试文件缺失必须失败，不能用构建成功代替功能验收。
- [ ] 完成全新安装、发布调用、版本升级、故障诊断、备份恢复验收，并报告首次成功时间/步骤及失败恢复率。
- [ ] 提供贡献指南、issue/PR 模板、安全报告渠道、支持范围；维护者选定许可证后补 LICENSE，未完成前不宣称已有开源授权。

依赖：[H3](https://github.com/worktools/hosta/issues/5)、[H4](https://github.com/worktools/hosta/issues/6)、[H5](https://github.com/worktools/hosta/issues/7)、[H6](https://github.com/worktools/hosta/issues/8)、[H8](https://github.com/worktools/hosta/issues/10)、[H11](https://github.com/worktools/hosta/issues/13)、[Y7](https://github.com/worktools/hoya/issues/11)。

### H10 · P2 · A2 · 通过 CLI/API 管理定时任务并明确恢复语义

GitHub：[hosta #12](https://github.com/worktools/hosta/issues/12)

server.mjs 已有 interval schedule 创建/停用/重启装载，但当前 React UI 没有定时管理入口；停机补跑与重叠语义未明确。

验收：

- [ ] CLI/API 支持创建、暂停、恢复、删除和状态查询，返回执行版本、输入、下次时间、最后结果及 runId；UI 仅展示，暂不增加管理交互。
- [ ] 明确使用固定版本还是跟随发布，默认固定且切换需可见；已停用应用的定时行为有一致语义。
- [ ] 明确停机错过调度、失败重试、重复与重叠策略，重启不无限补跑；显示时区。
- [ ] 用可控时钟验证重启、暂停、失败和版本切换；本阶段不引入完整 cron/DAG/连接器市场。

依赖：[H3](https://github.com/worktools/hosta/issues/5)、[H6](https://github.com/worktools/hosta/issues/8)、[H8](https://github.com/worktools/hosta/issues/10)。

### H11 · P1 · A0 · 提供面向 agents 的非交互 CLI 与机器可读输出

GitHub：[hosta #13](https://github.com/worktools/hosta/issues/13)

当前 package.json 没有 bin 入口，仅 start/dev/build/test；已有 HTTP API 和 /llms.txt，但 agent 需手工拼 HTTP 请求。维护者要求 CLI/API 优先，前期全命令行验证，UI 先展示。

验收：

- [ ] 提供可安装的 hosta 命令及 --help/version；通过 HTTP API 操作平台，不直接读写数据库或复制执行引擎。基础命令覆盖 doctor/status、apps create/list/get、versions upload/list、run、publish、invoke、runs get/list/logs；回滚/密钥/调度等随对应 API issue 扩展。
- [ ] 支持 --json 输出版本化、稳定 JSON 结果（含 ID、status、error.code、retryable）；stdout 只输出结果，诊断走 stderr。成功退出 0，参数/认证/网络/执行失败有文档化非零退出码；等待模式遇到 guest failed/timed_out 也必须非零。
- [ ] 支持文件或 stdin 传入源码/JSON，明确 --app/--version 和不可变 hash；无隐式 latest 发布。--wait/--timeout 等待异步任务，返回 jobId/runId 便于恢复查询，超时不盲目重复有副作用的命令。
- [ ] 默认无需 TTY 或提问；服务 URL/token 可由显式配置或环境提供，密钥不进入普通日志。破坏性操作需要明确 flag（如 --yes）并检查作用对象；普通发布不隐式轮换 key。
- [ ] 文档与 --help 可供 agent 发现命令、schema、退出码及幂等规则；写操作重试复用明确 idempotency key，不自动重试不确定的 invoke/发布副作用。支持幂等需要服务端 API 配合。
- [ ] 用 spawn CLI 的集成测试验证无 TTY、管道输入、JSON 可解析、stderr 分离、guest 失败退出码、无效凭据、服务离线和版本不存在；真实 Hoya JS/WASM smoke 全程命令行。A0 先实现基础命令与最小幂等，A1 扩展治理/诊断子命令，按子项验收。

依赖：[H1](https://github.com/worktools/hosta/issues/3)。
