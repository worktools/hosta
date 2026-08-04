# RFC 0002：MVP 架构与技术选型

- 状态：Accepted for planning
- 日期：2026-08-04

## 1. 决策摘要

Hosta 采用“Node.js 控制面 + Rust 执行面”的两进程架构，保留清晰协议边界。MVP 可由 Docker Compose 或单机进程启动，未来无需重写核心即可将执行面扩为 worker 池。

| 层 | MVP 选择 | 原因 |
| --- | --- | --- |
| Web/API | Node.js 22+、TypeScript、Fastify | 适合产品 API、流式生成和前端协作 |
| Web UI | React + Vite | 构建生成、试运行、日志等交互界面 |
| 数据访问 | SQLite + Drizzle ORM | 本地启动简单，schema 可迁移到 PostgreSQL |
| AI adapter | 自有 provider interface，DeepSeek 为默认实现 | 使用兼容 Chat Completions 的边界，便于替换和测试 |
| 执行服务 | Rust、Axum、QuickJS | 延续 Hoya 已有技术积累，控制宿主能力 |
| 队列 | MVP 使用数据库状态 + 进程内有界队列 | 先跑通主流程；多节点前再引入外部队列 |
| 部署 | Docker Compose | 明确控制面与执行面的资源和网络边界 |

## 2. 逻辑架构

```text
Browser
  │ HTTP/SSE
  ▼
Hosta Web/API (Node.js)
  ├── App / Version / Deployment / Run API
  ├── Generation orchestrator ──► DeepSeek adapter
  ├── Policy and validation
  └── SQLite
          │ private HTTP, signed request
          ▼
Hosta Runner (Rust, derived from Hoya)
  ├── QuickJS runtime
  ├── resource limits
  ├── capability-filtered host APIs
  └── stdout/stderr/result capture
```

控制面是唯一公开入口。Runner 不暴露公网端口、不读取数据库、不持有 DeepSeek key，只接收一次执行所需的代码、输入、限制和能力清单。

## 3. 为什么改造 Hoya，而不是直接复用

Hoya 已提供 Axum、QuickJS/Wasmtime、stdout/stderr 捕获和简单页面，适合作为执行原型。但 Hosta 需要调整边界：

- 删除“根据任意远程 URL 下载并执行”的默认路径，避免 SSRF 和代码来源漂移；
- 执行请求直接携带由控制面按 hash 固化的代码；
- 加入 wall-clock、CPU/指令、内存、栈、日志和响应大小限制；
- 每次运行创建干净上下文，禁止访问宿主文件、进程环境和系统命令；
- `fetch` 默认关闭，开启时执行 DNS/IP、协议、端口、重定向和响应大小策略；
- 将当前内存 AppStorage 和 Hoya 页面移出 Runner；
- 返回稳定的结构化执行协议和错误码；
- Wasmtime 保留为后续能力，不进入 MVP 主流程。

QuickJS 本身不是完整的安全边界。MVP 的 Runner 还应运行在非 root 容器中，使用只读文件系统、无宿主挂载、受限网络和容器级 CPU/内存限制。面向公网或多租户前，应评估每次执行使用隔离子进程、microVM 或专用沙箱。

## 4. 代码契约

生成脚本只允许一个入口：

```js
export async function main(input, ctx) {
  ctx.log("info", "started");
  return { ok: true, value: input.value };
}
```

`input` 必须为 JSON。`ctx` 只暴露版本化能力：

- `ctx.log(level, message, fields?)`
- `ctx.now()`
- `ctx.fetch(request)`：仅在应用获授网络能力时存在
- `ctx.secrets.get(name)`：Phase 2 才实现；MVP 不向脚本提供 secrets

禁止动态 import、`eval` 的额外代码来源、Node.js builtin、npm 包和持久化全局状态。生成提示词和静态校验器必须共同维护这个契约。

## 5. Runner 协议（内部）

`POST /v1/executions`

请求：

```json
{
  "runId": "run_...",
  "code": "export async function main(input, ctx) { ... }",
  "codeSha256": "...",
  "input": { "value": 1 },
  "limits": {
    "timeoutMs": 3000,
    "memoryMb": 64,
    "maxLogBytes": 65536,
    "maxResultBytes": 1048576
  },
  "capabilities": { "network": [] }
}
```

响应：

```json
{
  "status": "succeeded",
  "result": { "ok": true, "value": 1 },
  "logs": [],
  "metrics": { "durationMs": 12 },
  "error": null
}
```

状态限定为 `succeeded | failed | timed_out | rejected | internal_error`。控制面必须验证返回的 `runId` 与代码 hash。

## 6. AI provider 边界

控制面定义 `ModelProvider.generate(request)`，配置项至少包括：

- `AI_PROVIDER=deepseek`
- `DEEPSEEK_API_KEY`
- `DEEPSEEK_BASE_URL`
- `DEEPSEEK_MODEL`（不在源码中硬编码具体型号）
- timeout、最大重试次数和 token 上限

模型输出必须符合 JSON schema，字段包含 `summary`、`assumptions`、`inputSchema`、`code` 和 `testCases`。解析或 schema 校验失败时最多进行一次“修复格式”调用；仍失败则结束生成，不执行猜测性代码。

日志只记录 provider、模型配置名、延迟、token 使用和请求关联 ID；不得记录 API key。用户输入进入模型前也不得混入 Hosta 服务端环境变量。

## 7. 最小数据模型

- `apps`：`id`, `name`, `description`, `draft_version_id`, `published_version_id`, timestamps
- `versions`：`id`, `app_id`, `number`, `prompt`, `spec_json`, `code`, `code_sha256`, `status`, timestamps
- `deployments`：`id`, `app_id`, `version_id`, `status`, `webhook_key_hash`, timestamps
- `runs`：`id`, `app_id`, `version_id`, `deployment_id?`, `trigger`, `status`, `input_json`, `result_json?`, `error_json?`, metrics, timestamps
- `run_logs`：`id`, `run_id`, `sequence`, `level`, `message`, `fields_json?`, timestamp
- `model_calls`：`id`, `version_id`, provider, model, token counts, latency, estimated cost, status

代码和 prompt 在单机 MVP 中存入数据库；对输入、结果和日志设置保留期与大小上限。Webhook key 只存 hash，明文仅在创建或轮换时显示一次。

## 8. 公开 API 草案

- `POST /api/apps`
- `GET /api/apps/:appId`
- `POST /api/apps/:appId/generations`
- `GET /api/generations/:id/events`（SSE）
- `POST /api/versions/:versionId/runs`
- `POST /api/apps/:appId/publish`
- `POST /hooks/:deploymentId`（Bearer key）
- `GET /api/apps/:appId/runs`
- `GET /api/runs/:runId`
- `POST /api/apps/:appId/disable`

所有写操作接收 idempotency key。Webhook 必须限流，错误响应不得泄漏源码、堆栈或内部地址。

## 9. 关键风险

- 沙箱逃逸：通过分层隔离、最小 host API、依赖锁定、模糊测试和安全评审降低风险。
- 生成代码不可靠：结构化输出、静态规则、自动测试、显式发布和版本回滚。
- Prompt injection：外部数据不进入系统提示词；模型无部署权限；工具/能力由服务端政策决定。
- 成本失控：单次 token 上限、超时、有限重试、用户/应用配额和用量可见性。
- 单机队列丢失：启动时扫描非终态记录并标记失败或重试；进入多节点阶段前替换为持久队列。

