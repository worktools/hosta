# Hosta RFCs

本目录记录 Hosta 的产品与技术决策。Hosta 的目标是成为一个带网页入口的“个人 AI 软件工厂”：用户用自然语言描述自动化需求，系统生成脚本，在受限运行时中验证，随后发布为可通过 HTTP 调用的服务。

当前阶段只追求一条可演示、可验证的主流程，不在首版实现自主进化、复杂工作流或脚本市场。

## RFC 状态

| RFC | 标题 | 状态 |
| --- | --- | --- |
| [0001](0001-product-scope.md) | 产品边界与 MVP | Accepted for planning |
| [0002](0002-mvp-architecture.md) | MVP 架构与技术选型 | Accepted for planning |
| [0003](0003-main-flow.md) | 生成、试运行与发布主流程 | Accepted for planning |
| [0004](0004-delivery-plan.md) | 交付计划与验收标准 | Accepted for planning |

## 已确定的方向

- 控制面与网页服务：Node.js + TypeScript。
- 执行面：Rust，基于 Hoya 的 QuickJS 执行能力改造。
- MVP 只生成和执行 JavaScript；WebAssembly 作为后续扩展。
- 默认 AI 提供方：DeepSeek，通过 OpenAI-compatible adapter 接入，避免业务逻辑绑定供应商。
- 首版主流程：描述需求 → 生成代码 → 沙箱试运行 → 查看日志 → 发布 → Webhook 调用。
- 本地单机优先；数据库先用 SQLite，接口保持可迁移至 PostgreSQL。

## RFC 约定

- `Proposed`：讨论中。
- `Accepted for planning`：可作为实现依据，开发过程中仍可通过新 RFC 修订。
- `Implemented`：实现和验收条件均已完成。
- 重要范围或架构变化应新增 RFC，不静默改写已经落地的决策。

