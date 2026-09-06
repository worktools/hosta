# Hosta RFCs

当前方向：WASM/QuickJS 开源 serverless 平台，Hoya 独立维护；CLI/API 优先，UI 先展示，AI 为可选增强。[RFC 0013](0013-independent-engine-platform.md) 修订与此冲突的早期交付方向；详见[开发计划](../docs/DEVELOPMENT_PLAN.md)。

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

| [0013](0013-independent-engine-platform.md) | 独立 Hoya 引擎与双运行时平台 | Accepted for planning |

## 已确定的方向

- 控制面：Node.js + TypeScript；独立执行面：Hoya v1，QuickJS/Wasmtime。
- CLI 创建、上传、验证、发布、调用、日志查询；UI 展示运行状态。
- 不可变版本、JSON 数据源、快照和迁移沿用现有数据模型。
- 当前单机 JSON 存储，事务存储与发布治理按 issues 逐项验收。
- 旧 RFC 中的 Node 执行、JSPI、网络与互调能力不代表 v1 可用能力，当前边界见兼容性文档。

## RFC 约定

- `Proposed`：讨论中。
- `Accepted for planning`：可作为实现依据，开发过程中仍可通过新 RFC 修订。
- `Implemented`：实现和验收条件均已完成。
- `Informational`：背景调研/知识整理，不代表已批准的实现决策。
- 重要范围或架构变化应新增 RFC，不静默改写已经落地的决策。
