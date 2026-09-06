# Hosta / Hoya 项目评估

日期：2026-09-06。代码基线：Hosta `666eca9`，Hoya `2234baa`。本轮变更限于评估、决策和待办文档；不声称已经完成下面的功能修复。Hosta 原有 `.gitignore` 修改保留。

## 维护者补充与计划调整

前期全部使用命令行验证，Hosta 提供面向 agents 的非交互 CLI（H11），UI 先作为状态展示。H2 调整为只读展示与收敛旧交互；发布/回滚、诊断和定时管理以 API/CLI 验收。AI 生成增强降为 P2，复杂网页交互不作为预览交付门槛。以下历史问题依据仅适用于注明的本地基线，不能代表最新远端 main。

## 远端基线纠正与首轮实现（2026-09-06）

后续获取 Hosta 远端 main `a1bba14` 后确认：原评估使用的本地快照落后。
main 已有 `src/index.ts`、旧 Hoya sidecar 适配、丰富的 TypeScript 管理 API、
数据源/迁移/页面处理、部署回滚/停用/轮换和交互 UI。因此下文的“未连接 Hoya”、
“文件不存在”以及缺少部署管理的判断只描述旧快照，撤回其对最新 main 的适用性。

Hosta PR #14 正在最新 TypeScript 架构上接入独立 Hoya v1，保留已有管理数据模型，
提供 CLI、静态展示 UI、幂等创建、稳定发布凭据和真实 JS/WASM 回归；
旧交互工作区源码保留供后续评估。Hoya PR #12 修复值绑定，#13 提供 v1 协议、
进程执行和有界结果/日志。发布仍需精确版本的成功手动运行。
这些是首个可验证切片，并未完成对应 issues 中的全部加固与发布验收。

## 历史判断（本地旧快照）

Hosta 已有可用的产品原型骨架，Hoya 已有实际 QuickJS/Wasmtime 执行能力，但这两个工作区尚未组成一个贯通的平台。下一步应先让用户完成一次可信、可重复、可诊断的双运行时部署；AI、更多触发器和平台规模化不能替代这个闭环。

建议定位为“面向开发者的轻量开源 serverless 平台”，同时照顾通过模板/AI 使用的自动化用户。第一批场景用 JSON 转换、Webhook 校验、受控 API 聚合验收。JS 和 WASM 提供一致结果体验，语言兼容范围分别明确。

## 已有能力与差距

| 维度 | Hosta 当前 | Hoya 当前 | 下一步 |
| --- | --- | --- | --- |
| 创建 | React 页面、JS/WASM 选择、DeepSeek/演示生成 | 自带应用管理 demo UI | Hosta 成为产品入口，Hoya 提供独立 engine 模式 |
| 编辑与版本 | 创建不可变版本、保存/诊断/运行 | 接收内联源码或 WASM | dirty 状态、版本历史、明确当前运行对象 |
| 执行 | Node vm / WebAssembly，未连接 Hoya | QuickJS/Wasmtime、input、stdout/stderr | 版本化协议和双运行时一致 JSON 契约 |
| 资源限制 | JS 的计时 Promise 不能中断同步函数；WASM main 无中断 | JS interrupt/heap；WASM fuel/epoch/内存限制；4 槽并发 | 保留已有保护，补总期限、等待队列、host 缓冲和出站限制 |
| 发布 | 手动试运行门槛、稳定应用编码、Bearer hash | 引擎无需维护发布实体 | 发布不隐式轮换 key；停用、回滚、独立轮换 |
| 运行诊断 | API 附最近记录；UI 摘要和原始 JSON | metadata 和输出捕获 | 分页运行详情、错误分类、关联 ID 和可重试操作 |
| 构建 | 本机 rustc/moon 编译，模板返回 42 | WASM main 返回值按 JSON 指针读取 | 固定 ABI，JSON 示例，隔离可复现构建 |
| 运维 | 单 JSON 文件；定时 API，无对应 React UI | CI/Docker/K8s 文件与部分测试 | 事务存储、恢复、兼容发布和完整安装路径 |

## 关键问题及依据

1. **执行行为不符合平台目标（H1）**：`server.mjs:153` 的执行函数直接调用 Node 内的 guest 函数。`vm.runInContext` 超时仅覆盖前面的定义过程，之后的 `fn(input, ctx)` 不受它约束。同步死循环会阻塞事件循环，`Promise.race` 计时器不能抢占。WASM 也是直接调用 `main`。这是代码路径判断，本轮未在现有服务注入死循环。
2. **WASM 契约冲突（Y1/H5）**：Hosta 把 `main() -> i32` 当普通整数，Hoya `execute_wasm_with_input` 将 i32 当 NUL 结束的 UTF-8 JSON 地址。直接把现有产物交给 Hoya 不会得到等价结果。需要先固定 ABI 与输入能力。
3. **输入可能被解释为代码（Y2）**：Hoya `src/js_engine/mod.rs` 把 JSON 输入拼入 JS 模板字符串，再用 `JSON.parse` 解析。模板符号和转义会影响含义，应改成值绑定并做特殊字符回归。
4. **保护不完整（Y3/Y4/Y5）**：执行槽限制不等于等待队列有界；JS/WASM 的 host 日志 String 缓冲没有总字节限制；JS 网络黑名单和事后响应大小检查不构成完整出站策略，WASM 与 legacy 下载路径也不一致。鉴权中间件未覆盖 legacy UI 执行路由。已有 guest 限额应继续保留。
5. **用户执行的可能不是正在看的代码（H2）**：编辑器 textarea 是本地 state，run/diagnose 用已保存 `version.id`；按钮未表达未保存差异，也未对空版本/重复操作做完整保护。
6. **普通发布会破坏现有调用（H3）**：每次 publish 都生成新 key 并替换 hash。应把版本发布与凭据轮换拆开；Editor 切应用时也需清除旧 deployment/key 显示。
7. **生成成功不等于测试通过（H7）**：生成测试执行结果没有驱动 version ready 状态，且没有 expected output 断言。需要持久任务、schema 校验、断言与清晰失败恢复。
8. **文档与实现脱节（H9/Y7）**：旧 RFC 的 monorepo/提取引擎/JS-only 与当前目标冲突；Hoya `KNOWN_GAPS.md` 中的 Hosta `src/index.ts`、`hoya-client.ts` 等并不存在于当前 Hosta，不能把“全部修复”当验收事实。

这些问题按最早产生正确用户价值的顺序拆入 [Hosta 开发计划](DEVELOPMENT_PLAN.md) 与 Hoya 的 `docs/DEVELOPMENT_PLAN.md`，而非一次大重写。

## 用户旅程验收

| 用户动作 | 需要看到的反馈 | 失败后下一步 |
| --- | --- | --- |
| 首次启动 | 模型可选、引擎和工具链真实就绪状态 | 明确缺失组件及修复方法 |
| CLI 从模板/源码创建 | JS/Rust WASM 可运行输入样例与 appId | 保留文件和同一 appId，重试构建 |
| CLI 上传版本与测试 | 明确 versionId/hash、JSON 输入/结果/日志和退出码 | 定位错误、上传新版本并显式运行 |
| 发布与调用 | 当前线上版本、稳定 URL、一次性 key、curl | 试运行不足时说明；发布失败不影响旧版 |
| 更新与回滚 | 草稿/线上区分，普通发布 key 不变 | 回滚到已验证版本或停用 |
| 定位故障 | runId、版本/hash、错误分类和时间 | 根据错误修订或重试；重试生成新 run |

预览版目标：无 AI key，从 README 通过纯命令行到首次成功 JS/Rust WASM 调用每条路径 ≤10 分钟（依赖下载另计）；复现实例的失败运行均可由 runId 定位；普通版本升级不要求调用方改凭据。上述为目标，尚无用户测量数据。复杂异步网络、WASI/npm 兼容、自动扩缩容与多租户不纳入这轮承诺。

## 验证与局限

- `npm run build` 通过。
- `npm test` 退出成功，但报告 **0 tests / 0 suites**，不能算测试基线通过。
- `cargo test --offline --locked` 在工具链准备后因缺缓存依赖 `hdrhistogram` 失败，未执行 Rust 测试；不把依赖缺失判为业务代码失败。
- 临时目录中的 Hosta HTTP smoke 尝试因沙箱禁止本地监听（`listen EPERM`）未执行完成；未触碰原有应用数据。
- 用户流程判断来自当前 UI/API 源码审查，未完成浏览器交互验收、压力测试或隔离安全认证。
- 发布前已读取两个仓库全部状态的 issues，结果均为空。维护者确认 CLI/API 优先并授权发布后，已创建并回读验证 18 项 issues（Hosta 11、Hoya 7），含优先级/类型标签、A0/A1/A2 里程碑、验收和双向依赖。实际链接见两仓库开发计划。

## 建议立即开始的顺序

先做 Hoya Y1 协议与 Y2 输入绑定，随后完成 Y3/Y4/Y5 引擎基线并让 Hosta H1 接通。与此同时可准备 H11 CLI 命令/输出协议、H3 发布 API 和 Y6 兼容样例。H2 仅展示，不阻塞命令行验收。A0 通过后集中交付 A1，最后做 A2 的恢复与发布工程。许可证选择是开源预览发布前的维护者决定，不阻塞代码开发。
