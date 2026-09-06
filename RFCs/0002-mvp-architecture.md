# RFC 0002：MVP 架构与技术选型

> 2026-09-06：CLI 优先、独立 Hoya v1 与双运行时方向见 [RFC 0013](0013-independent-engine-platform.md)；本文保留历史架构记录。

- 状态：Accepted (updated 2026-08-11)
- 日期：2026-08-04

## 1. 决策摘要

Hosta 采用单进程 Node.js 架构，JavaScript 执行使用 `vm.createContext` 沙箱，WASM 执行使用 Node.js 内置 `WebAssembly` API + JSPI（`--experimental-wasm-jspi`）。数据采用 JSON 文件存储，无需外部数据库。

| 层 | MVP 选择 | 原因 |
| --- | --- | --- |
| Web/API | Node.js 22+、纯 JS（无框架） | 零依赖，单文件服务器 |
| Web UI | React + Vite（rolldown） | SPA 构建生成、试运行、日志等交互界面 |
| 数据存储 | JSON 文件 (`data/hosta.json`) | 本地启动零配置，适合单用户 MVP |
| AI adapter | DeepSeek Chat Completions API | 兼容 OpenAI 协议的边界，便于替换 |
| JS 执行 | Node.js `vm.createContext` | 轻量沙箱，拒绝宿主 API |
| WASM 执行 | Node.js `WebAssembly` + JSPI | 进程内执行，`WebAssembly.Suspending` 包装异步 host 函数 |
| 编译 | `rustc --target wasm32-unknown-unknown` | 系统自带，无需额外工具链 |
| 部署 | 单进程 `node server.mjs` | 极简部署 |

## 2. 实际架构

```text
Browser
  │ HTTP
  ▼
Hosta Node.js Server (server.mjs)
  ├── App / Version / Deployment / Run / Page API
  ├── Generation orchestrator ──► DeepSeek API
  ├── Policy and validation
  ├── JS execution: vm.createContext sandbox
  ├── WASM execution: WebAssembly.instantiate + JSPI
  ├── JSON envelope protocol: {ok:true,data:"..."} / {ok:false,error:{code,message}}
  └── data/hosta.json (file-based store)
```

单进程架构，无外部 Runner。JS 在 `vm.createContext` 沙箱中执行，WASM 通过 `WebAssembly.instantiate` 进程内执行，JSPI 让 async host 函数对 WASM 代码呈现为同步调用。

## 3. WASM 执行与 JSPI 架构

### 3.1 JSPI（JavaScript Promise Integration）

Node.js v24.6.0+ 需要 `--experimental-wasm-jspi` 标志。核心机制：

- **Host → WASM**：`new WebAssembly.Suspending(asyncFn)` 包装异步 host 函数，对 WASM 代码呈现为同步函数
- **WASM → Host**：`WebAssembly.promising(wasmFn)` 包装 WASM 导出函数，对 JS 呈现为返回 Promise 的函数

### 3.2 Memory Bridge

`buildWasmImports()` 构建 WASM 导入对象，提供内存读写桥：

- `readStr(ptr, len)` — 从 WASM 内存读取字符串
- `writeStr(str)` — 将字符串写入 WASM 内存（通过 `alloc()` 分配）
- `bind(memory, alloc)` — 绑定 WASM 模块的 memory 和 alloc 导出

### 3.3 Rust 编译

```bash
rustc +stable --target wasm32-unknown-unknown -O --crate-type cdylib \
  -C link-arg=-zstack-size=65536 -o main.wasm main.rs
```

- `#![no_std]` + `#![no_main]` — 无标准库，极简 WASM
- Bump allocator：64KB 静态堆，`alloc(size)` 返回指针
- `#[link(wasm_import_module = "env")]` — 声明 host 导入
- `#[unsafe(no_mangle)] pub extern "C" fn main() -> i32` — 入口，返回 JSON 信封指针

### 3.4 JSON 信封协议

所有 host 函数返回值和 `main()` 返回值均使用统一 JSON 信封：

```
成功: {"ok":true,"data":"..."}
失败: {"ok":false,"error":{"code":"CODE","message":"..."}}
```

Rust 侧提供 no_std 辅助函数：
- `ok(data: &str)` — 手动构建成功信封
- `err(code: &str, message: &str)` — 手动构建失败信封
- `is_ok(ptr)` — 快速检查 `{"ok":true` 前缀
- `envelope_data(ptr)` — 提取 `"data"` 字段

错误码：`INVALID_URL`, `BLOCKED_HOST`, `RESPONSE_TOO_LARGE`, `FETCH_ERROR`

### 3.5 导入函数

| 函数 | 签名 | 说明 |
| --- | --- | --- |
| `fetch` | `(url_ptr, url_len) -> *mut u8` | JSPI 包装的 HTTP GET，返回 JSON 信封 |
| `log` | `(ptr, len)` | 结构化日志 |
| `now` | `() -> i64` | 当前毫秒时间戳 |
| `get_input` | `(ptr, max_len) -> usize` | 读取调用输入 JSON |
| `get_datasource` | `(ptr, max_len) -> usize` | 读取数据源快照 |

## 4. 代码契约

### 4.1 JavaScript

```js
export async function main(input, ctx) {
  ctx.log("info", "started");
  return { ok: true, value: input.value };
}
```

`input` 必须为 JSON。`ctx` 暴露：
- `ctx.log(level, message, fields?)` — 结构化日志
- `ctx.now()` — 当前时间戳
- `ctx.call(appCode, input, options?)` — 调用其他已发布应用
- `ctx.fetch(url, options?)` — 受限 HTTP GET（仅 https/http，禁止 localhost，512KB 上限，5s 超时）
- `ctx.datasource` — 数据源只读快照

禁止：`import`、`require`、`eval`、`Function`、Node.js builtin、npm 包、全局状态。

### 4.2 Rust/WASM

```rust
#![no_std]
#![no_main]

#[link(wasm_import_module = "env")]
extern "C" {
    fn fetch(url_ptr: *const u8, url_len: usize) -> *mut u8;
    fn log(ptr: *const u8, len: usize);
    fn now() -> i64;
    fn get_input(ptr: *mut u8, max_len: usize) -> usize;
    fn get_datasource(ptr: *mut u8, max_len: usize) -> usize;
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(size: usize) -> *mut u8 { /* bump allocator */ }

#[unsafe(no_mangle)]
pub extern "C" fn main() -> i32 {
    // 返回 JSON 信封指针
    ok("hello")
}
```

## 5. 执行流程

```
POST /api/versions/:id/run { input }
  ├── 策略检查（validateCode）
  ├── Input schema 校验（validateJsonSchema）
  ├── [JS] vm.createContext → vm.runInContext → main(input, ctx)
  ├── [WASM] WebAssembly.instantiate → WebAssembly.promising(main) → resultPtr
  │         └── 解析 JSON 信封 → ok:true → succeeded / ok:false → failed
  └── 返回 { status, result, logs, error, durationMs }
```

## 6. Generative UI 页面生成

### 6.1 PageConfig 格式

```json
{
  "version": "1.0",
  "layout": { "type": "grid", "config": {} },
  "regions": [
    {
      "id": "region_xxx",
      "position": { "row": 0, "col": 0, "rowSpan": 1, "colSpan": 12 },
      "component": {
        "type": "statistic",
        "props": { "title": "总订单", "value": 1234 }
      }
    }
  ],
  "dataSources": [
    { "id": "ds_1", "binding": [{ "regionId": "region_xxx", "field": "orders" }] }
  ]
}
```

### 6.2 AI 页面生成

`POST /api/ai/generate-page` 使用 LLM 生成 PageConfig。提示词包含：
- 24+ 组件的完整 Zod Schema（类型、props、可选值）
- 6 种常见场景模式：Dashboard/Analytics、Data CRUD、Detail Page、List/Browse、Form/Wizard、Monitoring/Status
- 数据源绑定指南（`dataSources` 字段）
- 12 列网格布局指南

当提供 `appId` 时，数据源 schema 和数据字段会被注入到提示词中。

### 6.3 processScript

每个页面可附带一个 `processScript`（JavaScript 函数体），用于在渲染前处理数据：

```js
(input, datasource) => {
  return {
    stats: datasource.orders.reduce((acc, o) => acc + o.amount, 0),
    items: datasource.orders.slice(0, 20)
  };
}
```

通过 `POST /api/apps/:id/pages/:pageId/data` 在 vm 沙箱中执行。

## 7. 数据模型

当前使用 JSON 文件存储（`data/hosta.json`），结构：

- `apps`：`id`, `name`, `description`, `code`, `runtime`, `language`, `requirements`, `publishedVersionId`, timestamps
- `versions`：`id`, `appId`, `code`, `sourceCode`, `wasmSize`, `inputSchema`, `outputSchema`, `tests`, `status`, timestamps
- `deployments`：`id`, `appId`, `versionId`, `status`, `keyHash`, `apiKey`, timestamps
- `runs`：`id`, `appId`, `versionId`, `deploymentId`, `trigger`, `status`, `input`, `result`, `error`, `logs`, `durationMs`, timestamps
- `pages`：`id`, `appId`, `name`, `pageConfig`, `processScript`, timestamps
- `datasources`：`id`, `appId`, `schema`, `data`, timestamps
- `schedules`：`id`, `appId`, `deploymentId`, `cron`, `input`, timestamps

## 8. 公开 API

### 应用与版本
- `POST /api/apps` — 创建应用
- `GET /api/apps` — 列出应用
- `GET /api/apps/:id` — 获取应用
- `PATCH /api/apps/:id` — 更新应用
- `DELETE /api/apps/:id` — 删除应用
- `POST /api/apps/:id/generate` — LLM 生成版本
- `POST /api/versions/:id/run` — 执行版本
- `POST /api/versions/:id/diagnose` — 诊断执行
- `POST /api/versions/:id/revise` — LLM 修复版本
- `POST /api/versions/:id/tests` — 添加测试用例
- `POST /api/versions/:id/tests/run-all` — 运行全部测试

### 发布与调用
- `POST /api/apps/:id/publish` — 发布应用
- `GET|POST /invoke/:appCode` — 调用已发布应用
- `POST /hooks/:id` — 通过 deployment ID 调用

### Generative UI 页面
- `GET /api/apps/:id/pages` — 列出页面
- `POST /api/apps/:id/pages` — 创建页面
- `PUT /api/apps/:id/pages/:pageId` — 更新页面
- `DELETE /api/apps/:id/pages/:pageId` — 删除页面
- `POST /api/apps/:id/pages/:pageId/data` — 执行 processScript 获取页面数据
- `GET /api/apps/code/:code/pages` — 公开获取页面
- `POST /api/ai/generate-page` — AI 生成 PageConfig

### 其他
- `GET /health` — 健康检查
- `GET /llms.txt` — LLM 可读的 API 文档
- `POST /api/format` — 代码格式化
- `POST /api/sample-input` — 生成示例输入

## 9. 关键风险

- 沙箱逃逸：`vm.createContext` 和 WASM 均非完整安全边界，需后续加固
- 生成代码不可靠：结构化输出、静态规则、自动测试、显式发布和版本回滚
- Prompt injection：外部数据不进入系统提示词；模型无部署权限
- 成本失控：单次 token 上限、超时、有限重试
- JSON 文件存储：单用户场景足够，多用户需迁移到数据库
