# RFC 0003：生成、试运行与发布主流程

- 状态：Accepted for planning
- 日期：2026-08-04

## 1. 目的

本 RFC 定义 MVP 必须首先打通的纵向主流程，以及每个步骤的状态、失败处理和接口边界。实现顺序应围绕这条路径，而不是先建设完整平台基础设施。

## 2. Happy path

```text
创建 App
  → 提交需求与示例输入
  → DeepSeek 生成结构化 spec + JS + tests
  → 服务端 schema/静态校验
  → Runner 执行 AI 生成的 tests
  → 用户用示例输入试运行
  → 用户确认发布该不可变版本
  → 获得 Webhook 地址与 key
  → HTTP 调用
  → 查看结果与日志
```

## 3. 详细步骤

### 3.1 创建应用

UI 收集名称、自然语言需求和可选示例 JSON。`POST /api/apps` 只创建 App，不触发模型。随后 `POST /api/apps/:id/generations` 创建 Generation job，以便重试和刷新页面不会重复计费。

### 3.2 生成版本

Generation orchestrator 构造版本化系统提示词，要求模型：

- 遵守唯一的 `main(input, ctx)` 契约；
- 输出严格 JSON，不使用 Markdown code fence；
- 列明假设和输入 schema；
- 生成至少一个正常用例和一个边界用例；
- 不包含密钥、Node API、包依赖或未获授网络访问。

通过 SSE 向 UI 推送粗粒度阶段：`queued → calling_model → validating → testing → ready`。不把模型的原始思维过程存储或展示。

### 3.3 校验与自动测试

执行前按顺序完成：响应 JSON schema 校验、代码大小检查、模块语法解析、禁用语法/标识符扫描、输入 schema 校验和 capability 检查。静态扫描只是早期拒绝机制，不能替代沙箱。

每个模型测试用例都由 Runner 独立执行。全部成功则版本成为 `ready`；任何失败则成为 `needs_revision`，UI 显示可操作错误。MVP 不自动无限修复；允许用户点击“根据错误修订”，产生一个新版本，并限制修订轮数。

### 3.4 用户试运行

用户编辑 JSON 输入并发起运行。控制面创建 `runs` 记录，将固化代码和限制发送给 Runner，收到结果后写入结果、结构化日志与指标。页面展示：

- 版本号与 code hash；
- 输入和 JSON 结果；
- 日志级别、时间和顺序；
- 排队时间、执行时间与最终状态；
- 区分用户代码错误、超时、策略拒绝和平台错误。

只有至少一个用户试运行为 `succeeded` 的 `ready` 版本可以发布。

### 3.5 发布

发布事务将 `apps.published_version_id` 切换到目标版本，并创建或更新 deployment。版本内容保持不可变。首次发布生成高熵 Webhook key，数据库仅保存 hash。

发布结果页面给出地址、Bearer key、输入 schema 和可复制的 `curl` 示例。再次生成只改变草稿指针，不影响线上版本。

### 3.6 Webhook 调用

网关验证 deployment 状态、Bearer key、速率和 body 大小，再校验输入 schema并创建 run。MVP 使用同步调用，设置严格总超时；超时返回稳定错误和 `runId`，用户仍可在运行列表查询最终记录。

调用始终锁定请求开始时的版本。发布切换不得让一次执行混用两个版本。

## 4. 状态机

### Version

```text
generating → validating → testing → ready → published
     │            │          │
     └────────────┴──────────┴→ needs_revision
                                  │
                                  └→ 生成新 Version（旧版本不变）
```

`published` 是该版本曾被发布的事实；当前线上版本以 App 的发布指针为准。

### Run

```text
queued → running → succeeded
                 ├→ failed
                 ├→ timed_out
                 ├→ rejected
                 └→ internal_error
```

终态不可重写。重试必须创建新的 run，并记录 `retry_of_run_id`。

## 5. 错误语义

| 类别 | 示例 | 是否可重试 | 对外信息 |
| --- | --- | --- | --- |
| `MODEL_ERROR` | provider 超时、限流 | 有限重试 | 生成暂时失败和关联 ID |
| `GENERATION_INVALID` | 输出不符合 schema | 可人工重试 | 失败字段，不展示内部 prompt |
| `POLICY_REJECTED` | 禁用 API、网络目标不允许 | 修改需求后 | 明确被拒绝的能力 |
| `USER_CODE_ERROR` | JS exception、返回值不可序列化 | 修订版本 | 安全化错误位置和消息 |
| `EXECUTION_TIMEOUT` | 超过时间限制 | 通常需修订 | 限制值与 runId |
| `PLATFORM_ERROR` | Runner 不可用 | 可重试 | 通用信息和关联 ID |

## 6. 默认限制（MVP 起始值）

以下是实现初值，必须可配置并通过压测/安全测试修订：

- 源码 128 KiB；请求体 1 MiB；结果 1 MiB；日志 64 KiB；
- 单次执行 wall-clock 3 秒；
- 每个应用并发 2，实例全局并发由 Runner 容量决定；
- 生成调用 60 秒，格式修复最多 1 次；
- Webhook 每 deployment 每分钟 30 次；
- 默认无任何出站网络。

## 7. 可观测性

每个请求贯穿 `requestId`, `generationId`, `runId`, `appId`, `versionId`。日志不得包含密钥、完整 Authorization、DeepSeek 请求头或未脱敏的敏感输入。核心指标：生成成功率/延迟/token、验证失败率、执行状态/延迟、队列深度、Runner 饱和度和每应用调用量。

## 8. 主流程完成定义

在一台新机器按 README 启动后，可以仅通过浏览器完成：创建一个 JSON 转换服务、用 DeepSeek 生成、看到自动测试通过、手动试运行、发布、复制 `curl` 调用，并在网页看到对应 run 与日志。关闭并重启控制面后，应用、版本、deployment 和历史 run 仍然存在。

