# Hosta RFCs

本目录记录 Hosta 的产品与技术决策。Hosta 的目标是成为一个带网页入口的“个人 AI 软件工厂”：用户用自然语言描述自动化需求，系统生成脚本，在受限运行时中验证，随后发布为可通过 HTTP 调用的服务。

当前阶段只追求一条可演示、可验证的主流程，不在首版实现自主进化、复杂工作流或脚本市场。

## RFC 状态

| RFC                                          | 标题                                            | 状态                   |
| -------------------------------------------- | ----------------------------------------------- | ---------------------- |
| [0001](0001-product-scope.md)                | 产品边界与 MVP                                  | Accepted for planning  |
| [0002](0002-mvp-architecture.md)             | MVP 架构与技术选型                              | Accepted (updated)     |
| [0003](0003-main-flow.md)                    | 生成、试运行与发布主流程                        | Accepted for planning  |
| [0004](0004-delivery-plan.md)                | 交付计划与验收标准                              | Accepted for planning  |
| [0005](0005-platform-vision.md)              | 平台愿景与 Vercel 式开发者体验                  | Proposed               |
| [0006](0006-ui-hierarchy.md)                 | 界面层级设计与信息架构                          | Proposed               |
| [0007](0007-llm-api-exploration.md)          | LLM API 自动探索与智能生成                      | Proposed               |
| [0008](0008-iteration-management.md)         | 全生命周期迭代管理                              | Proposed               |
| [0009](0009-inter-app-and-external-data.md)  | 小程序互联与外部数据源接入                      | Proposed               |
| [0010](0010-wasm-jspi-error-handling.md)     | WASM Host 错误处理与 JSPI Reject 语义           | Proposed（探索已验证） |
| [0011](0011-llm-sandbox-landscape-survey.md) | LLM 生成代码执行沙箱——业界方案综述与 Hosta 定位 | Informational          |
| [0012](0012-hoya-sandbox-security-review.md) | Hoya 低成本沙箱安全审查与演进建议                | Informational          |

## 已确定的方向

Hosta 定位为**以 LLM 代码生成为核心的、面向轻量级小程序（mini-app）的研发平台**，参考 Vercel 的低门槛开发者体验。

- 控制面与网页服务：Node.js 22+，单文件 HTTP server。
- 执行面：`vm.createContext`（JavaScript）和 WebAssembly 进程内执行（Rust/MoonBit，通过 JSPI 支持异步）。
- 数据通信：WASM host 函数与 `main()` 返回值使用 JSON 信封协议（`{"ok":true,"data":"..."}` / `{"ok":false,"error":{"code":"...","message":"..."}}`）。
- 小程序粒度：每个程序是独立的、可调用的微型服务，支持 HTTP 调用和程序间调用。
- 数据管理：每个程序可绑定 JSON 数据源，支持版本化快照和迁移脚本。
- 版本管理：不可变版本，草稿/发布双指针，手动切换线上版本。
- LLM 驱动全生命周期：生成、测试、修订、优化均由 AI 辅助。
- 默认 AI 提供方：DeepSeek，通过 OpenAI-compatible adapter 接入。
- 本地单机优先；JSON 文件存储，接口保持可迁移至 SQLite/PostgreSQL。

## RFC 约定

- `Proposed`：讨论中。
- `Accepted for planning`：可作为实现依据，开发过程中仍可通过新 RFC 修订。
- `Implemented`：实现和验收条件均已完成。
- `Informational`：背景调研/知识整理，不代表已批准的实现决策。
- 重要范围或架构变化应新增 RFC，不静默改写已经落地的决策。
