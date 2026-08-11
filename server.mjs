import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import vm from "node:vm";

/**
 * Hosta — LLM-first 小程序研发平台
 *
 * 一个参考 Vercel 低门槛研发体验的平台，以 LLM 代码生成为核心，
 * 面向轻量级小程序（mini-app）的完整生命周期管理。
 *
 * 核心概念：
 *   Program（程序）  — 独立的微型服务，含代码、版本、数据源、调用入口
 *   Version（版本）  — 不可变的代码快照，每次生成/编辑产生新版本
 *   DataSource（数据源）— 程序绑定的 JSON 数据，支持快照和迁移脚本
 *   Publish（发布）  — 将版本设为线上版本，生成调用地址和密钥
 *   Invoke（调用）   — 通过 HTTP GET/POST 调用已发布程序
 *
 * 架构：
 *   Browser → Hosta API Server (Node.js) → JSON File Store
 *                    ├── vm.createContext (JS 执行)
 *                    ├── WebAssembly (WASM 执行)
 *                    ├── DeepSeek API (LLM 生成)
 *                    └── spawn (rustc/moon 编译)
 */

// ── 配置 ──────────────────────────────────────────────────────────────────────
const root = resolve(process.cwd());
const staticDir = join(root, "dist");
const dataFile = join(root, "data", "hosta.json");
const port = Number(process.env.PORT || 4173);
const now = () => new Date().toISOString();

// 默认代码模板
const rustStarter = `#![no_std]
#![no_main]

// ── Hosta WASM JSON-Envelope Protocol ──────────────────────────────────────────
// All host function responses use a JSON envelope:
//   {"ok":true,"data":"..."}  — success
//   {"ok":false,"error":{"code":"...","message":"..."}}  — failure
// main() must also return a pointer to a JSON envelope string.

#[link(wasm_import_module = "env")]
extern "C" {
    fn fetch(url_ptr: *const u8, url_len: usize) -> *mut u8;
    fn log(ptr: *const u8, len: usize);
    fn now() -> i64;
    fn get_input(ptr: *mut u8, max_len: usize) -> usize;
    fn get_datasource(ptr: *mut u8, max_len: usize) -> usize;
}

// Simple bump allocator — host uses alloc() to write strings into WASM memory
static mut BUMP: usize = 0;
static mut HEAP: [u8; 65536] = [0; 65536];

#[unsafe(no_mangle)]
pub extern "C" fn alloc(size: usize) -> *mut u8 {
    unsafe {
        let ptr = HEAP.as_mut_ptr().add(BUMP);
        BUMP += size;
        if BUMP >= HEAP.len() { BUMP = 0; }
        ptr
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/// Copy bytes from src to dest (no_std, no libc)
unsafe fn copy_bytes(dest: *mut u8, src: *const u8, len: usize) {
    for i in 0..len {
        unsafe { *dest.add(i) = *src.add(i); }
    }
}

/// Length of a null-terminated string at ptr
unsafe fn strlen(ptr: *const u8) -> usize {
    let mut len = 0;
    while unsafe { *ptr.add(len) } != 0 {
        len += 1;
    }
    len
}

/// Write a byte slice into WASM memory, return pointer to null-terminated copy
unsafe fn write_bytes(data: &[u8]) -> *mut u8 {
    let ptr = alloc(data.len() + 1);
    unsafe {
        copy_bytes(ptr, data.as_ptr(), data.len());
        *ptr.add(data.len()) = 0;
    }
    ptr
}

/// Build a JSON success envelope: {"ok":true,"data":"..."}
fn ok(data: &str) -> *mut u8 {
    // Manual JSON building to avoid alloc/serde in no_std
    let prefix = b"{\\"ok\\":true,\\"data\\":\\"";
    let suffix = b"\\"}";
    let data_bytes = data.as_bytes();
    let total = prefix.len() + data_bytes.len() + suffix.len();
    let ptr = alloc(total + 1);
    unsafe {
        copy_bytes(ptr, prefix.as_ptr(), prefix.len());
        copy_bytes(ptr.add(prefix.len()), data_bytes.as_ptr(), data_bytes.len());
        copy_bytes(ptr.add(prefix.len() + data_bytes.len()), suffix.as_ptr(), suffix.len());
        *ptr.add(total) = 0;
    }
    ptr
}

/// Build a JSON error envelope: {"ok":false,"error":{"code":"CODE","message":"msg"}}
fn err(code: &str, message: &str) -> *mut u8 {
    let parts: &[&[u8]] = &[
        b"{\\"ok\\":false,\\"error\\":{\\"code\\":\\"",
        code.as_bytes(),
        b"\\",\\"message\\":\\"",
        message.as_bytes(),
        b"\\"}}",
    ];
    let mut total = 0;
    for p in parts { total += p.len(); }
    let ptr = alloc(total + 1);
    let mut off = 0;
    unsafe {
        for p in parts {
            copy_bytes(ptr.add(off), p.as_ptr(), p.len());
            off += p.len();
        }
        *ptr.add(total) = 0;
    }
    ptr
}

/// Check if a JSON string starts with {"ok":true
/// This is a fast check — no full JSON parsing needed in no_std
unsafe fn is_ok(json_ptr: *const u8) -> bool {
    let tag = b"{\\"ok\\":true";
    for i in 0..tag.len() {
        if unsafe { *json_ptr.add(i) } != tag[i] { return false; }
    }
    true
}

/// Extract the "data" value from a JSON success envelope.
/// Returns a pointer to the start of the data string value within the JSON.
/// Caller must copy the data out before the next alloc.
unsafe fn envelope_data(json_ptr: *const u8) -> (*const u8, usize) {
    // Look for "data":"
    let needle = b"\\"data\\":\\"";
    let mut i = 0;
    loop {
        let mut matched = true;
        for j in 0..needle.len() {
            if unsafe { *json_ptr.add(i + j) } != needle[j] { matched = false; break; }
        }
        if matched {
            let start = i + needle.len();
            // Find the closing quote
            let mut end = start;
            while unsafe { *json_ptr.add(end) } != b'"' && unsafe { *json_ptr.add(end) } != 0 {
                end += 1;
            }
            return (json_ptr.add(start), end - start);
        }
        i += 1;
        if unsafe { *json_ptr.add(i) } == 0 { break; }
    }
    // Not found — return empty
    (json_ptr, 0)
}

// ── Example main ──────────────────────────────────────────────────────────────

#[unsafe(no_mangle)]
pub extern "C" fn main() -> i32 {
    // Fetch data from an API — looks synchronous but JSPI handles async
    let url = b"https://httpbin.org/json";
    let resp_ptr = unsafe { fetch(url.as_ptr(), url.len()) };

    // Check envelope
    if unsafe { is_ok(resp_ptr) } {
        let (data_ptr, data_len) = unsafe { envelope_data(resp_ptr) };
        // Return the data as the success result
        let result = alloc(data_len + 1);
        unsafe {
            copy_bytes(result, data_ptr, data_len);
            *result.add(data_len) = 0;
        }
        return result as i32;
    } else {
        // Return the error envelope as-is — host will handle it
        return resp_ptr as i32;
    }
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    // Panic = unrecoverable. Write error envelope to a known location.
    // The host captures this by checking if main() returned 0 or a valid pointer.
    loop {}
}
`;
const moonStarter = `pub fn run() -> Int {\n  42\n}\n`;

// ── WASM Memory Bridge ────────────────────────────────────────────────────────

/**
 * Build the imports object for a WASM module, with JSPI-wrapped async functions.
 * Returns { imports, bind(memory, alloc) } — call bind() after instantiation.
 */
function buildWasmImports(logs, input, ds) {
  let memory = null;
  let alloc = null;

  const readStr = (ptr, len) =>
    new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));

  const writeStr = (str) => {
    const encoded = new TextEncoder().encode(str + "\0");
    const ptr = alloc(encoded.length);
    new Uint8Array(memory.buffer).set(encoded, ptr);
    return ptr;
  };

  return {
    imports: {
      env: {
        /**
         * Fetch a URL — JSPI suspends WASM execution until the Promise resolves.
         * Returns a pointer to the response string in WASM memory.
         */
        fetch: new WebAssembly.Suspending(async (urlPtr, urlLen) => {
          const url = readStr(urlPtr, urlLen);
          try {
            const parsed = new URL(url);
            if (!["http:", "https:"].includes(parsed.protocol))
              return writeStr(
                JSON.stringify({
                  ok: false,
                  error: {
                    code: "INVALID_URL",
                    message: "only http/https URLs allowed",
                  },
                }),
              );
            const blocked = ["127.0.0.1", "localhost", "::1", "0.0.0.0"];
            if (blocked.includes(parsed.hostname))
              return writeStr(
                JSON.stringify({
                  ok: false,
                  error: {
                    code: "BLOCKED_HOST",
                    message: "cannot access localhost",
                  },
                }),
              );
            const resp = await fetch(url, {
              method: "GET",
              signal: AbortSignal.timeout(5000),
              redirect: "follow",
            });
            const text = await resp.text();
            if (text.length > 524288)
              return writeStr(
                JSON.stringify({
                  ok: false,
                  error: {
                    code: "RESPONSE_TOO_LARGE",
                    message: "response exceeds 512KB limit",
                  },
                }),
              );
            return writeStr(JSON.stringify({ ok: true, data: text }));
          } catch (err) {
            return writeStr(
              JSON.stringify({
                ok: false,
                error: {
                  code: "FETCH_ERROR",
                  message: String(err.message).slice(0, 2000),
                },
              }),
            );
          }
        }),
        /** Structured log (sync, no JSPI needed) */
        log: (ptr, len) => {
          if (logs.length < 100) {
            const msg = readStr(ptr, len);
            logs.push({
              level: "info",
              message: msg.slice(0, 2000),
              at: Date.now(),
            });
          }
        },
        /** Current timestamp in ms (Rust i64 → BigInt) */
        now: () => BigInt(Date.now()),
        /**
         * Read the invocation input JSON.
         * Writes the JSON string to ptr (up to maxLen bytes), returns actual length.
         */
        get_input: (ptr, maxLen) => {
          const json = JSON.stringify(input ?? {});
          const encoded = new TextEncoder().encode(json);
          const len = Math.min(encoded.length, maxLen);
          new Uint8Array(memory.buffer).set(encoded.subarray(0, len), ptr);
          return len;
        },
        /**
         * Read the datasource snapshot.
         * Writes the JSON string to ptr (up to maxLen bytes), returns actual length.
         */
        get_datasource: (ptr, maxLen) => {
          const json = JSON.stringify(
            ds ? JSON.parse(JSON.stringify(ds.data)) : {},
          );
          const encoded = new TextEncoder().encode(json);
          const len = Math.min(encoded.length, maxLen);
          new Uint8Array(memory.buffer).set(encoded.subarray(0, len), ptr);
          return len;
        },
      },
    },
    /** Bind the WASM module's memory and alloc exports after instantiation. */
    bind(mem, al) {
      memory = mem;
      alloc = al;
    },
  };
}

/** Read a null-terminated string from WASM memory at the given pointer. */
function readWasmStr(memory, ptr) {
  const buf = new Uint8Array(memory.buffer, ptr);
  let end = 0;
  while (end < buf.length && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.subarray(0, end));
}

// ── LLM Prompt 模板配置 ────────────────────────────────────────────────────────
const PROMPTS = {
  /** 代码生成 prompt（基于需求文档） */
  generate: ({ description, sampleInput, requirements, datasourceSchema }) =>
    `You generate a small Hosta JavaScript function for a sandboxed mini-app. Return JSON only with keys summary, code, tests. code must define: async function main(input, ctx). No imports, require, process, eval, Function, network, or markdown. Return JSON-serializable data. tests is an array of {name, input, expectedOutput}.

${
  requirements
    ? `## Requirements Document
${requirements}

## User Description
${description}`
    : `User request: ${description}`
}

Sample input: ${JSON.stringify(sampleInput ?? {})}
${
  datasourceSchema
    ? `
## Internal Data Source (accessible via ctx.datasource)
JSON Schema: ${JSON.stringify(datasourceSchema)}
IMPORTANT: You can access the internal data source through ctx.datasource. The shape of ctx.datasource conforms to the JSON Schema above.`
    : ""
}`,

  /** 需求驱动的迭代 refine prompt */
  refine: ({ app, version, instruction, datasourceSchema }) =>
    `You are refining a Hosta JavaScript mini-app based on the user's requirements and feedback. Regenerate the code, tests, and summary. Return JSON only with keys: summary, code, tests.

## App Name
${app.name}

## Requirements Document
${app.requirements || app.description || "N/A"}

## Current Code
${version?.code || "No code yet"}

## Current Tests
${JSON.stringify(version?.tests || [], null, 2)}
${
  datasourceSchema
    ? `
## Internal Data Source (accessible via ctx.datasource)
JSON Schema: ${JSON.stringify(datasourceSchema)}
IMPORTANT: You can access the internal data source through ctx.datasource. The shape of ctx.datasource conforms to the JSON Schema above.`
    : ""
}

## User Refinement Instruction
${instruction}

Return JSON: {"summary": "what was changed", "code": "async function main(input, ctx) { ... }", "tests": [{"name": "...", "input": {...}, "expectedOutput": {...}}]}`,

  /** 需求文档生成/优化 prompt — 兼容空文档 */
  refineRequirements: ({
    requirements,
    instruction,
    appName,
    appDescription,
  }) =>
    requirements.trim()
      ? `You are refining a requirements document for a lightweight mini-app. The document is in Markdown. Edit it according to the user's instruction, preserving the overall structure. Return JSON only.

## App Name
${appName}

## App Description
${appDescription || "N/A"}

## Current Requirements Document
${requirements}

## User Instruction
${instruction}

Return JSON only: {"summary": "brief description of what was changed in Chinese", "refined": "the full refined requirements document in Markdown"}`
      : `You are writing a requirements document for a lightweight mini-app from scratch. The document should be in Markdown (Chinese or English), structured and actionable for a developer or LLM to implement. Include: functional description, input/output format, edge cases, external dependencies, and examples.

## App Name
${appName}

## App Description
${appDescription || "N/A"}

## User Instruction (what the app should do)
${instruction}

Return JSON only: {"summary": "brief description of what was generated in Chinese", "refined": "the full requirements document in Markdown"}`,

  /** 示例输入生成 prompt */
  sampleInput: ({ description, runtime }) =>
    `You generate a realistic JSON sample input for a small automation program. Return JSON only with the key "input", whose value is the sample object the program would receive at runtime. Program description: ${description}\nRuntime: ${runtime}\nReturn only: {"input": { ... }}`,

  /** 测试用例生成 prompt */
  generateTests: ({ app, version, existingTests }) =>
    `You are a test engineer for a lightweight automation platform. Generate 2-3 additional test cases for the following program. Each test case must have a descriptive name (in Chinese or English), a JSON input object, and a JSON expectedOutput object. The tests should cover edge cases and scenarios not already covered by the existing tests.

App name: ${app.name}
App description: ${app.description || "N/A"}
Runtime: ${version.runtime || "javascript"}
Language: ${version.language || "javascript"}
${version.inputSchema ? `Input JSON Schema: ${JSON.stringify(version.inputSchema)}\nIMPORTANT: All test inputs MUST conform to the JSON Schema above.` : ""}
Existing tests: ${JSON.stringify(existingTests, null, 2)}

Return JSON only in this format: {"tests": [{"name": "...", "input": {...}, "expectedOutput": {...}}]}`,

  /** Schema 生成 prompt */
  generateSchema: ({
    appName,
    appDescription,
    requirements,
    code,
    tests,
    existingSchemas,
    target,
    instruction,
  }) =>
    `You are a data architect for a lightweight mini-app platform. Generate a JSON Schema for the ${target === "input" ? "INPUT" : "OUTPUT"} of a Hosta mini-app.

## App Name
${appName}

## App Description
${appDescription || "N/A"}

## Requirements Document
${requirements || "N/A"}

## Current Code
${code || "No code yet"}

## Test Cases
${JSON.stringify(tests || [], null, 2)}

${existingSchemas?.inputSchema ? `## Current Input Schema\n${JSON.stringify(existingSchemas.inputSchema)}` : "## Current Input Schema\nNone yet"}
${existingSchemas?.outputSchema ? `## Current Output Schema\n${JSON.stringify(existingSchemas.outputSchema)}` : "## Current Output Schema\nNone yet"}

## User Instruction
${instruction || `Generate a comprehensive JSON Schema for the ${target === "input" ? "input parameters" : "expected output"} of this app.`}

## Requirements
- Generate a JSON Schema (draft-04 compatible) for the **${target === "input" ? "INPUT" : "OUTPUT"}** only.
- Include type, properties, required, and descriptions for each field.
- Use "type": "object" at the root.
- Infer field types from the code signature and test cases.
- Mark fields that are always present in tests as required.
- Use Chinese descriptions for fields when the app is in Chinese context.
- Be precise about number vs integer vs string types.

Return JSON only: {"schema": { ... }}`,

  /** LLM 自动修订 prompt */
  revise: ({ version, errorSummary, hint }) =>
    `You are fixing a Hosta JavaScript function that failed tests. Fix the code while keeping the same async function main(input, ctx) signature. No imports, require, process, eval, Function, network, or markdown. Return JSON only with keys: summary, code, tests.
${
  hint
    ? `\n## Correction Hint from User\n${hint}\nPay extra attention to the area described in this hint.`
    : ""
}

Current code:
${version.code}

Failed tests:
${errorSummary || "Unknown error"}

Return JSON: {"summary": "what was fixed", "code": "async function main(input, ctx) { ... }", "tests": [{"name": "...", "input": {...}, "expectedOutput": {...}}]}`,

  /** 页面配置生成 prompt */
  generatePage: ({
    name,
    appName,
    appDescription,
    instruction,
    datasourceContext,
  }) => {
    const dsSection = datasourceContext
      ? `\n## Data Source\nAvailable data for this page: ${datasourceContext}\n\nYou can bind data to components using the "dataSources" field in PageConfig. Each binding maps a regionId to a data field path.`
      : "";
    return `You are a UI designer for a mini-app platform. Generate a PageConfig JSON for a page named "${name}" in the app "${appName}".

The app description: ${appDescription || "N/A"}
${instruction ? `\nUser instruction: ${instruction}` : ""}${dsSection}

Return JSON only with the key "pageConfig". The pageConfig must follow this schema:

interface PageConfig {
  version: "1.0";
  layout: { type: "grid" | "flex" | "tabs" | "free"; config: Record<string, unknown> };
  regions: Array<{
    id: string; // region_xxx
    position: { row: number; col: number; rowSpan?: number; colSpan?: number };
    component: ComponentConfig;
  }>;
  dataSources?: Array<{ id: string; binding: Array<{ regionId: string; field: string }> }>;
}

interface ComponentConfig {
  type: string;
  id?: string;
  props: Record<string, unknown>;
  children?: ComponentConfig[];
}

## Available Components & Their Props

**card** — Container with title and children
  { title?: string, bordered?: boolean, shadow?: "none"|"hover"|"always", padding?: string|number, loading?: boolean, children?: ComponentConfig[] }

**table** — Data table
  { columns: Array<{ field: string, title: string, width?: string|number, sortable?: boolean, align?: "left"|"center"|"right" }>, data?: Array<Record<string, unknown>>, dataSource?: string, bordered?: boolean, striped?: boolean, hoverable?: boolean, pagination?: { pageSize?: number, currentPage?: number }, emptyText?: string, rowKey?: string }

**chart** — ECharts-based chart
  { chartType: "line"|"area"|"bar"|"pie"|"scatter"|"radar"|"funnel"|"gauge"|"bubble", option?: Record<string, unknown>, dataSource?: string, data?: unknown[], xField?: string, yField?: string, nameField?: string, valueField?: string, seriesField?: string, title?: string, height?: string|number }

**form** — Form container
  { layout?: "horizontal"|"vertical"|"inline", labelWidth?: string|number, labelAlign?: "left"|"right"|"top", colon?: boolean, items: ComponentConfig[] }

**button** — Button
  { type?: "primary"|"normal"|"danger"|"text", size?: "small"|"medium"|"large"|"huge", label: string, icon?: string, loading?: boolean, block?: boolean, href?: string, target?: "_blank"|"_self", action?: { type: "submit"|"navigate"|"custom", config?: Record<string, unknown> } }

**input** — Text input
  { name: string, label?: string, type?: "text"|"textarea"|"password", placeholder?: string, value?: string, maxlength?: number, clearable?: boolean, readonly?: boolean, rows?: number, status?: "default"|"success"|"warning"|"error", size?: "small"|"medium"|"large" }

**select** — Dropdown select
  { name: string, label?: string, placeholder?: string, options: Array<{ label: string, value: string|number }>, multiple?: boolean, clearable?: boolean, filterable?: boolean, size?: "small"|"medium"|"large" }

**statistic** — Number/metric display
  { title?: string, value?: number|string, precision?: number, prefix?: string, suffix?: string }

**tag** — Tag/label
  { label?: string, color?: "default"|"primary"|"success"|"warning"|"error"|"info", type?: "solid"|"hollow"|"plain", size?: "small"|"medium"|"large", round?: boolean, closable?: boolean }

**alert** — Alert/notification
  { type?: "info"|"success"|"warning"|"error", title?: string, description?: string, closable?: boolean, showIcon?: boolean }

**progress** — Progress bar
  { type?: "bar"|"circle", percent: number, status?: "default"|"success"|"warning"|"error", showText?: boolean, strokeWidth?: number }

**steps** — Steps indicator
  { current?: number, direction?: "horizontal"|"vertical", type?: "default"|"dot", items: Array<{ title: string, description?: string, status?: "wait"|"process"|"finish"|"error" }> }

**tabs** — Tabbed container
  { tabs?: Array<{ key: string, title: string, children?: ComponentConfig[] }>, tabPosition?: "top"|"bottom"|"left"|"right", type?: "line"|"card", activeKey?: string }

**space** — Flexible spacing wrapper
  { direction?: "horizontal"|"vertical", size?: number|string, wrap?: boolean, align?: "start"|"center"|"end"|"baseline", children?: ComponentConfig[] }

**divider** — Divider line
  { direction?: "horizontal"|"vertical", dashed?: boolean, contentPosition?: "left"|"center"|"right" }

**link** — Hyperlink
  { href?: string, target?: "_blank"|"_self"|"_parent"|"_top", underline?: boolean, prefix?: string, suffix?: string }

**avatar** — User avatar
  { size?: "small"|"medium"|"large"|number, src?: string, alt?: string, shape?: "circle"|"square" }

**badge** — Badge indicator
  { value?: number|string, max?: number, dot?: boolean, color?: "default"|"primary"|"success"|"warning"|"error" }

**skeleton** — Loading placeholder
  { loading?: boolean, rows?: number, title?: boolean, avatar?: boolean, animation?: "pulse"|"wave" }

**empty** — Empty state
  { description?: string, imageSize?: number }

**result** — Result feedback
  { status: "success"|"error"|"info"|"warning", title: string, subtitle?: string }

**descriptions** — Key-value info display
  { title?: string, column?: number, bordered?: boolean, items: Array<{ label: string, value: string|number }> }

**list** — Simple list
  { bordered?: boolean, items: Array<{ title: string, subtitle?: string, description?: string, avatar?: string }> }

**timeline** — Timeline display
  { items: Array<{ title: string, timestamp?: string, desc?: string, color?: string }> }

**breadcrumb** — Breadcrumb navigation
  { separator?: string, items: Array<{ label: string, href?: string }> }

**pagination** — Pagination
  { total: number, defaultCurrent?: number, defaultPageSize?: number, showSizeChanger?: boolean, showJumper?: boolean, size?: "small"|"default" }

**segmented** — Segmented control
  { options: Array<{ label: string, value: string }>, value?: string, defaultValue?: string, block?: boolean, size?: "small"|"medium"|"large" }

**layout** — Nested grid/flex layout
  { type?: "grid"|"flex", direction?: "row"|"column", gap?: number|string, columns?: number, items: ComponentConfig[] }

## Common Scenario Patterns

1. **Dashboard / Analytics** — Use grid layout with statistic cards in row 1, charts in row 2, table in row 3. Chart types: bar for comparisons, pie for distribution, line for trends.
2. **Data CRUD** — Use form for search filters (row 1), space with buttons for actions (row 2), table for data display (row 3). Include pagination on table.
3. **Detail Page** — Use descriptions for key-value data, card with children for sections, timeline for activity log, steps for progress tracking.
4. **List/Browse** — Use segmented for filtering, table with sortable columns, pagination, space for action buttons.
5. **Form/Wizard** — Use steps for progress, form with items array, result for success/error state.
6. **Monitoring/Status** — Use alert for warnings, progress for metrics, statistic for KPIs, chart with chartType "gauge" for real-time status.

## Data Binding Pattern
When data is available, use the "dataSources" field to bind data to regions:
{ "dataSources": [{ "id": "ds1", "binding": [{ "regionId": "region_stats", "field": "summary" }, { "regionId": "region_table", "field": "items" }] }] }

## Layout Guidelines
- Grid layout: use config { columns: 12, gap: 16 } for responsive dashboards
- Statistic cards: rowSpan: 1, colSpan: 3 (4 per row in 12-column grid)
- Full-width charts: colSpan: 12, rowSpan: depends on data
- Tables: colSpan: 12 for full-width data display
- Form items: colSpan: 4 or 6 for inline form fields

Return: {"pageConfig": { ... }}`;
  },
};

// ── 数据持久化 ────────────────────────────────────────────────────────────────

/** 从 JSON 文件加载 store，不存在时返回空 store */
async function loadStore() {
  try {
    return JSON.parse(await readFile(dataFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { apps: [], versions: [], deployments: [], runs: [] };
  }
}
let store = await loadStore();
// 初始化 store 中可能缺失的数组（向后兼容旧数据格式）
store.schedules ??= [];
store.modelCalls ??= [];
store.datasources ??= [];
store.datasourceSnapshots ??= [];
store.externalDatasources ??= [];
store.pages ??= [];

/** 序列化写入：保证并发 save() 调用按顺序执行，避免数据竞争 */
let serial = Promise.resolve();
function save() {
  serial = serial.then(async () => {
    await mkdir(dirname(dataFile), { recursive: true });
    await writeFile(dataFile, JSON.stringify(store, null, 2));
  });
  return serial;
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 生成带前缀的短 ID，如 `app_3f2a1b8c` */
function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/** SHA-256 哈希 */
function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** 发送 JSON 响应 */
function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/** 发送错误响应 */
function error(res, status, code, message) {
  json(res, status, { error: { code, message } });
}

/** 解析请求体为 JSON，限制 1 MiB */
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_048_576) throw new Error("Request body exceeds 1 MiB");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const err = new Error("Body must be valid JSON");
    err.status = 400;
    throw err;
  }
}
function tryParseScalar(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}
async function inputFromRequest(req) {
  if (req.method === "POST") return await body(req);
  const query = new URL(req.url, "http://localhost").searchParams;
  const inputRaw = query.get("input");
  if (inputRaw !== null) {
    try {
      return JSON.parse(inputRaw);
    } catch {
      return { input: inputRaw };
    }
  }
  const input = {};
  for (const [key, value] of query) {
    if (key === "key" || key === "api_key") continue;
    input[key] = tryParseScalar(value);
  }
  return input;
}
function invokeDocsFor(app, deployment, origin) {
  const sample = app.sampleInput ?? {};
  const path = `/invoke/${app.code}`;
  const full = `${origin}${path}`;
  const inputJson = JSON.stringify(sample);
  const browser = `${full}?key=<YOUR_KEY>&input=${encodeURIComponent(inputJson)}`;
  const publishedVersion = deployment
    ? versionById(deployment.versionId)
    : null;
  const pinnedPath = publishedVersion
    ? `/invoke-version/${app.code}/${publishedVersion.number}`
    : null;
  const pinnedFull = pinnedPath ? `${origin}${pinnedPath}` : null;
  return {
    appCode: app.code,
    published: Boolean(deployment),
    publishedVersion: publishedVersion
      ? { number: publishedVersion.number, id: publishedVersion.id }
      : null,
    endpoint: {
      path,
      methods: ["GET", "POST"],
      versionPinned: pinnedPath
        ? {
            path: pinnedPath,
            description:
              "钉选版本调用。始终使用此特定版本，不受后续发布影响。适合需要稳定 API 的业务集成。",
          }
        : null,
    },
    auth: deployment
      ? "GET 通过 ?key= 或 ?api_key= 传入；POST 通过 Authorization: Bearer <key> 请求头。密钥仅展示一次，请妥善保存。"
      : "该应用尚未发布。请先在页面试运行成功并发布，才能获得调用密钥。",
    methods: {
      get: deployment
        ? {
            description:
              "浏览器地址栏或任意 HTTP 客户端直接调用。使用 ?input= 传 JSON，或用扁平键值对（如 ?a=1&b=hello）。",
            url: browser,
            pinnedUrl: pinnedFull
              ? `${pinnedFull}?key=<YOUR_KEY>&input=${encodeURIComponent(inputJson)}`
              : null,
          }
        : null,
      post: deployment
        ? {
            description: "POST 请求，Body 为应用示例输入 JSON。",
            url: full,
            pinnedUrl: pinnedFull || null,
            headers: [
              "Authorization: Bearer <YOUR_KEY>",
              "Content-Type: application/json",
            ],
            body: sample,
          }
        : null,
    },
    examples: deployment
      ? {
          browser,
          curl: `curl -X POST "${full}" -H "Authorization: Bearer <YOUR_KEY>" -H "Content-Type: application/json" -d '${inputJson}'`,
          pinnedCurl: pinnedFull
            ? `curl -X POST "${pinnedFull}" -H "Authorization: Bearer <YOUR_KEY>" -H "Content-Type: application/json" -d '${inputJson}'`
            : null,
        }
      : null,
    sampleInput: sample,
  };
}
/** 从测试用例推断字段 schema（类型、是否必填） */
function inferSchemaFromTests(tests, field) {
  if (!tests || !tests.length) return null;
  const props = {};
  for (const test of tests) {
    const obj = test[field];
    if (!obj || typeof obj !== "object") continue;
    for (const [key, val] of Object.entries(obj)) {
      props[key] = props[key] || {
        type: typeof val,
        examples: [],
        optional: false,
      };
      props[key].examples.push(val);
      if (props[key].examples.length > 5)
        props[key].examples = props[key].examples.slice(0, 5);
    }
  }
  const total = tests.filter(
    (t) => t[field] && typeof t[field] === "object",
  ).length;
  for (const [key, info] of Object.entries(props)) {
    const count = tests.filter(
      (t) => t[field] && typeof t[field] === "object" && key in t[field],
    ).length;
    info.optional = count < total;
  }
  return { type: "object", properties: props, totalTests: total };
}

/** JSON Schema 校验器（轻量实现，支持 draft-04 核心关键字） */
function validateJsonSchema(schema, data, path = "$") {
  if (!schema || typeof schema !== "object") return [];
  const errors = [];
  const t = schema.type;
  // type 校验
  if (t) {
    const actual = Array.isArray(data)
      ? "array"
      : data === null
        ? "null"
        : typeof data;
    const allowed = Array.isArray(t) ? t : [t];
    if (!allowed.includes(actual)) {
      errors.push(`${path}: expected ${allowed.join("|")}, got ${actual}`);
      return errors;
    }
  }
  // enum 校验
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(data))
  ) {
    errors.push(`${path}: value must be one of ${JSON.stringify(schema.enum)}`);
  }
  // string 约束
  if (t === "string" && typeof data === "string") {
    if (typeof schema.minLength === "number" && data.length < schema.minLength)
      errors.push(
        `${path}: length ${data.length} < minLength ${schema.minLength}`,
      );
    if (typeof schema.maxLength === "number" && data.length > schema.maxLength)
      errors.push(
        `${path}: length ${data.length} > maxLength ${schema.maxLength}`,
      );
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(data))
          errors.push(
            `${path}: "${data}" does not match pattern ${schema.pattern}`,
          );
      } catch {
        /* invalid regex, skip */
      }
    }
  }
  // number 约束
  if ((t === "number" || t === "integer") && typeof data === "number") {
    if (t === "integer" && !Number.isInteger(data))
      errors.push(`${path}: expected integer, got ${data}`);
    if (typeof schema.minimum === "number" && data < schema.minimum)
      errors.push(`${path}: ${data} < minimum ${schema.minimum}`);
    if (typeof schema.maximum === "number" && data > schema.maximum)
      errors.push(`${path}: ${data} > maximum ${schema.maximum}`);
  }
  // object properties
  if (
    t === "object" &&
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data)
  ) {
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in data) {
          errors.push(
            ...validateJsonSchema(propSchema, data[key], `${path}.${key}`),
          );
        } else if (
          Array.isArray(schema.required) &&
          schema.required.includes(key)
        ) {
          errors.push(`${path}.${key}: required property missing`);
        }
      }
    }
    // 额外属性警告（非错误，仅提示）
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(data)) {
        if (!(key in schema.properties))
          errors.push(`${path}.${key}: additional property not allowed`);
      }
    }
  }
  // array items
  if (t === "array" && Array.isArray(data)) {
    if (schema.items) {
      for (let i = 0; i < data.length; i++) {
        errors.push(
          ...validateJsonSchema(schema.items, data[i], `${path}[${i}]`),
        );
      }
    }
    if (typeof schema.minItems === "number" && data.length < schema.minItems)
      errors.push(
        `${path}: items count ${data.length} < minItems ${schema.minItems}`,
      );
    if (typeof schema.maxItems === "number" && data.length > schema.maxItems)
      errors.push(
        `${path}: items count ${data.length} > maxItems ${schema.maxItems}`,
      );
  }
  return errors;
}
/** 推断应用能力标签（基于代码特征） */
function inferCapabilities(version) {
  const caps = [];
  const code = version.code || "";
  if (/ctx\.call\s*\(/.test(code)) caps.push("inter-app-call");
  if (/ctx\.fetch\s*\(/.test(code)) caps.push("external-http");
  if (/Date\b|new Date|setTimeout|setInterval/.test(code))
    caps.push("time-aware");
  if (/Math\./.test(code)) caps.push("math");
  if (/(for\s*\(|while\s*\()/.test(code)) caps.push("loops");
  if (/try\s*\{/.test(code)) caps.push("error-handling");
  if (version.runtime === "wasm") caps.push("webassembly");
  return caps.length ? caps : ["basic"];
}
function appById(appId) {
  return store.apps.find((item) => item.id === appId);
}
function appByCode(code) {
  return store.apps.find((item) => item.code === code);
}
function datasourceByAppId(appId) {
  return store.datasources.find((item) => item.appId === appId);
}
function externalDatasourcesByAppId(appId) {
  return store.externalDatasources.filter((item) => item.appId === appId);
}
function datasourceSnapshotById(id) {
  return store.datasourceSnapshots.find((item) => item.id === id);
}
function normalizeSlug(value) {
  return (
    String(value || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36) || "app"
  );
}
function appCode(name, serial) {
  return `${serial}-${normalizeSlug(name)}`;
}
let migratedAppCodes = false;
let nextSerial = 1;
for (const app of store.apps) {
  if (typeof app.serial === "number")
    nextSerial = Math.max(nextSerial, app.serial + 1);
}
for (const app of store.apps) {
  app.runtime ??= "javascript";
  if (typeof app.serial !== "number") {
    let slug = String(app.code || "").trim();
    if (/^\d+-/.test(slug)) slug = slug.replace(/^\d+-/, "");
    else if (/^fn-/.test(slug)) slug = slug.replace(/^fn-/, "");
    app.serial = nextSerial++;
    app.code = `${app.serial}-${normalizeSlug(slug || app.name)}`;
    migratedAppCodes = true;
  }
}
if (migratedAppCodes) await save();
function versionById(versionId) {
  return store.versions.find((item) => item.id === versionId);
}
function deploymentById(deploymentId) {
  return store.deployments.find((item) => item.id === deploymentId);
}
function scheduleById(scheduleId) {
  return store.schedules.find((item) => item.id === scheduleId);
}
function publicApp(app) {
  const draft = app.draftVersionId ? versionById(app.draftVersionId) : null;
  const published = app.publishedVersionId
    ? versionById(app.publishedVersionId)
    : null;
  const versions = store.versions
    .filter((v) => v.appId === app.id)
    .sort((a, b) => b.number - a.number);
  const ds = datasourceByAppId(app.id);
  const extDs = externalDatasourcesByAppId(app.id);
  return {
    ...app,
    draftVersion: draft,
    publishedVersion: published,
    versions,
    datasource: ds
      ? { data: ds.data, schema: ds.schema || null, updatedAt: ds.updatedAt }
      : { data: {}, schema: null, updatedAt: null },
    externalDatasources: extDs.map((eds) => ({
      id: eds.id,
      name: eds.name,
      url: eds.url,
      method: eds.method,
      headers: eds.headers,
      inputSchema: eds.inputSchema,
      outputSchema: eds.outputSchema,
      createdAt: eds.createdAt,
      updatedAt: eds.updatedAt,
    })),
    deployments: store.deployments.filter((d) => d.appId === app.id),
    schedules: store.schedules.filter((s) => s.appId === app.id),
    modelCalls: store.modelCalls
      .filter((call) => call.appId === app.id)
      .slice(-10)
      .reverse(),
    runs: store.runs
      .filter((r) => r.appId === app.id)
      .slice(-20)
      .reverse(),
    pages: (store.pages || [])
      .filter((p) => p.appId === app.id)
      .map((p) => ({
        id: p.id,
        name: p.name,
        pageConfig: p.pageConfig,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        processScript: p.processScript,
      })),
  };
}
function validateCode(code, runtime = "javascript") {
  if (typeof code !== "string" || code.length === 0 || code.length > 131072)
    return "Code must be between 1 and 131072 characters";
  if (runtime === "wasm") {
    try {
      new WebAssembly.Module(Buffer.from(code, "base64"));
      return null;
    } catch {
      return "WASM mode expects a valid base64-encoded WebAssembly module";
    }
  }
  if (!/async\s+function\s+main\s*\(/.test(code))
    return "Code must define async function main(input, ctx)";
  if (
    /\b(require|process|globalThis|import\s*\(|child_process|fs|eval|Function)\b/.test(
      code,
    )
  )
    return "Code contains a forbidden host capability";
  return null;
}
/**
 * 代码质量诊断：检查语法、禁用 API、代码风格等
 * @param {string} code - 源代码
 * @param {string} runtime - 运行时类型
 * @returns {Array} 诊断结果数组
 */
function diagnosticsFor(code, runtime = "javascript") {
  const diagnostics = [];
  const policyError = validateCode(code, runtime);
  if (policyError) {
    diagnostics.push({
      severity: "error",
      code: "POLICY_REJECTED",
      message: policyError,
    });
  } else {
    try {
      new vm.Script(`"use strict"; ${code}`);
    } catch (err) {
      diagnostics.push({
        severity: "error",
        code: "SYNTAX_ERROR",
        message: String(err.message),
      });
    }
    if (runtime === "wasm") {
      diagnostics.push({
        severity: "info",
        code: "WASM_ISOLATION",
        message:
          "WASM 运行于 JSPI 异步环境；可调用 fetch/log/now/get_input/get_datasource 等 host 函数。",
      });
    } else {
      // JS 代码质量规则
      if (!/ctx\.log\s*\(/.test(code))
        diagnostics.push({
          severity: "info",
          code: "NO_STRUCTURED_LOGS",
          message: "建议在关键分支调用 ctx.log，便于定位线上输入问题。",
        });
      if (!/return\s+/.test(code))
        diagnostics.push({
          severity: "warning",
          code: "NO_EXPLICIT_RETURN",
          message: "未发现显式 return，Webhook 可能只返回 null。",
        });
      if (code.length > 4096)
        diagnostics.push({
          severity: "warning",
          code: "CODE_SIZE",
          message: `代码长度 ${code.length} 字符，建议控制在 4096 以内。`,
        });
      if (!/try\s*\{/.test(code) && !/catch\s*\(/.test(code))
        diagnostics.push({
          severity: "info",
          code: "NO_ERROR_HANDLING",
          message: "建议添加 try-catch 处理异常输入。",
        });
      if (!/input\.\w+/.test(code) && !/input\[/.test(code))
        diagnostics.push({
          severity: "info",
          code: "NO_INPUT_VALIDATION",
          message: "建议验证输入字段是否存在。",
        });
      // 嵌套循环检测
      const loopCount = (code.match(/\b(for|while)\b/g) || []).length;
      if (loopCount > 3)
        diagnostics.push({
          severity: "warning",
          code: "TOO_MANY_LOOPS",
          message: `发现 ${loopCount} 个循环，建议检查时间复杂度。`,
        });
    }
  }
  return diagnostics;
}

/**
 * 计算代码质量评分（0-5 分）
 * @param {Array} diagnostics - 诊断结果数组
 * @returns {object} { score, maxScore, details }
 */
function codeQualityScore(diagnostics, code = "") {
  let score = 5;
  const details = [];
  for (const d of diagnostics) {
    if (d.severity === "error") {
      score -= 2;
      details.push(`❌ ${d.code}: ${d.message}`);
    }
    if (d.severity === "warning") {
      score -= 0.5;
      details.push(`⚠️ ${d.code}: ${d.message}`);
    }
    if (d.severity === "info" && d.code !== "EXECUTION_SUCCEEDED") {
      details.push(`💡 ${d.message}`);
    }
  }
  return { score: Math.max(0, score), maxScore: 5, details };
}
function sampleCode(description = "") {
  const lower = description.toLowerCase();
  if (
    lower.includes("汇总") ||
    lower.includes("sum") ||
    lower.includes("total")
  ) {
    return `async function main(input, ctx) {\n  const items = Array.isArray(input.items) ? input.items : [];\n  const total = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);\n  ctx.log('info', 'Calculated item total', { count: items.length });\n  return { total, count: items.length };\n}`;
  }
  return `async function main(input, ctx) {\n  ctx.log('info', 'Hosta function started');\n  return { ok: true, received: input };\n}`;
}
const sampleWasm = "AGFzbQEAAAABBQFgAAF/AwIBAAcIAQRtYWluAAAKBgEEAEEqCw==";
function safeJson(value) {
  JSON.stringify(value);
  return value;
}
function runCommand(command, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        rejectRun,
        new Error(`${command} exceeded the 15 second compilation limit`),
      );
    }, 15000);
    child.on("error", (err) => finish(rejectRun, err));
    child.on("close", (code) =>
      finish(
        code === 0 ? resolveRun : rejectRun,
        code === 0
          ? output
          : new Error(output.slice(-6000) || `${command} exited with ${code}`),
      ),
    );
  });
}
async function compileWasm(language, source) {
  const workdir = await mkdtemp(join(tmpdir(), "hosta-compile-"));
  try {
    let outputFile;
    if (language === "moonbit") {
      await writeFile(
        join(workdir, "moon.mod.json"),
        JSON.stringify({ name: "hosta/runner", version: "0.1.0" }),
      );
      await writeFile(
        join(workdir, "moon.pkg.json"),
        JSON.stringify({
          name: "hosta/runner",
          link: { wasm: { exports: ["run:main"] } },
        }),
      );
      await writeFile(join(workdir, "main.mbt"), source);
      await runCommand(
        "moon",
        ["build", "--target", "wasm", "--release"],
        workdir,
      );
      outputFile = join(workdir, "_build/wasm/release/build/runner.wasm");
    } else {
      outputFile = join(workdir, "module.wasm");
      await writeFile(join(workdir, "main.rs"), source);
      await runCommand(
        "rustc",
        [
          "+stable",
          "--target",
          "wasm32-unknown-unknown",
          "-O",
          "--crate-type",
          "cdylib",
          "main.rs",
          "-o",
          "module.wasm",
        ],
        workdir,
      );
    }
    const wasm = await readFile(outputFile);
    new WebAssembly.Module(wasm);
    return { binary: wasm.toString("base64"), size: wasm.length };
  } catch (error) {
    const wrapped = new Error(
      `Compilation failed: ${String(error.message).slice(0, 6000)}`,
    );
    wrapped.status = 400;
    throw wrapped;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
async function formatCode({ code, runtime, language }) {
  if (!code) return { formatted: code, formatter: null };
  const workdir = await mkdtemp(join(tmpdir(), "hosta-format-"));
  try {
    let fileName, formatter, args;
    if (runtime === "wasm" && language === "moonbit") {
      fileName = "main.mbt";
      formatter = "moonfmt";
      args = ["-w", fileName];
    } else if (runtime === "wasm" && language === "rust") {
      fileName = "main.rs";
      formatter = "rustfmt";
      args = [fileName];
    } else {
      fileName = "index.js";
      formatter = join(root, "node_modules", ".bin", "prettier");
      args = ["--write", fileName];
    }
    await writeFile(join(workdir, fileName), code);
    await runCommand(formatter, args, workdir);
    const formatted = await readFile(join(workdir, fileName), "utf8");
    return { formatted, formatter: fileName };
  } catch (error) {
    const wrapped = new Error(
      `Formatting failed: ${String(error.message).slice(0, 6000)}`,
    );
    wrapped.status = 400;
    throw wrapped;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
async function deepSeekGenerate({
  description,
  sampleInput,
  requirements,
  runtime = "javascript",
  datasourceSchema = null,
}) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (runtime === "wasm")
    return {
      source: "local-demo",
      summary:
        "WASM 示例已生成。编辑区保存 Rust 或 MoonBit 源码，发布前会由系统编译。",
      code: null,
      tests: [
        {
          name: "默认测试",
          input: sampleInput ?? {},
          expectedOutput: undefined,
        },
      ],
      usage: null,
      model: null,
    };
  if (!apiKey)
    return {
      source: "local-demo",
      summary:
        "本地演示生成器：已生成可试运行的 JavaScript。配置 DEEPSEEK_API_KEY 后将调用 DeepSeek。",
      code: sampleCode(description),
      tests: [
        {
          name: "默认测试",
          input: sampleInput ?? {},
          expectedOutput: undefined,
        },
      ],
      usage: null,
      model: null,
    };
  const base = (
    process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
  ).replace(/\/$/, "");
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  const prompt = PROMPTS.generate({
    description,
    sampleInput,
    requirements,
    datasourceSchema,
  });
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new Error(`DeepSeek returned HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned no content");
  const cleaned = content.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  const generated = JSON.parse(cleaned);
  if (
    typeof generated.summary !== "string" ||
    typeof generated.code !== "string"
  )
    throw new Error(
      "DeepSeek response does not match the Hosta generation schema",
    );
  return {
    source: "deepseek",
    summary: generated.summary,
    code: generated.code,
    tests:
      Array.isArray(generated.tests) && generated.tests.length
        ? generated.tests.slice(0, 3).map((t) => ({
            name: String(t.name || "默认测试").slice(0, 200),
            input: t.input && typeof t.input === "object" ? t.input : {},
            expectedOutput:
              t.expectedOutput && typeof t.expectedOutput === "object"
                ? t.expectedOutput
                : undefined,
          }))
        : [
            {
              name: "默认测试",
              input: sampleInput ?? {},
              expectedOutput: undefined,
            },
          ],
    usage: payload.usage ?? null,
    model,
  };
}
async function deepSeekSample({ description, runtime = "javascript" }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey)
    return { source: "local-demo", model: null, input: { value: 1 } };
  const base = (
    process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
  ).replace(/\/$/, "");
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  const prompt = PROMPTS.sampleInput({ description, runtime });
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new Error(`DeepSeek returned HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned no content");
  const cleaned = content.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned);
  const input = parsed?.input ?? parsed;
  if (!input || typeof input !== "object")
    throw new Error("DeepSeek response does not contain a sample input object");
  return { source: "deepseek", model, input };
}
async function deepSeekRefine({
  app,
  version,
  instruction,
  datasourceSchema = null,
}) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not configured");
  const base = (
    process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
  ).replace(/\/$/, "");
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  const prompt = PROMPTS.refine({
    app,
    version,
    instruction,
    datasourceSchema,
  });
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new Error(`DeepSeek returned HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned no content");
  const cleaned = content.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  const generated = JSON.parse(cleaned);
  if (
    typeof generated.summary !== "string" ||
    typeof generated.code !== "string"
  )
    throw new Error(
      "DeepSeek response does not match the Hosta refinement schema",
    );
  return {
    source: "deepseek",
    summary: generated.summary,
    code: generated.code,
    tests:
      Array.isArray(generated.tests) && generated.tests.length
        ? generated.tests.slice(0, 5).map((t) => ({
            name: String(t.name || "测试").slice(0, 200),
            input: t.input && typeof t.input === "object" ? t.input : {},
            expectedOutput:
              t.expectedOutput && typeof t.expectedOutput === "object"
                ? t.expectedOutput
                : undefined,
          }))
        : [],
    usage: payload.usage ?? null,
    model,
  };
}
async function deepSeekRefineRequirements({
  requirements,
  instruction,
  appName,
  appDescription,
}) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not configured");
  const base = (
    process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
  ).replace(/\/$/, "");
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  const prompt = PROMPTS.refineRequirements({
    requirements,
    instruction,
    appName,
    appDescription,
  });
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new Error(`DeepSeek returned HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned no content");
  const cleaned = content.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  const generated = JSON.parse(cleaned);
  if (
    typeof generated.summary !== "string" ||
    typeof generated.refined !== "string"
  )
    throw new Error(
      "DeepSeek response does not match the requirements refinement schema",
    );
  return {
    source: "deepseek",
    summary: generated.summary,
    refined: generated.refined,
    usage: payload.usage ?? null,
    model,
  };
}
async function deepSeekGeneratePage({
  name,
  appName,
  appDescription,
  instruction,
  datasourceContext,
}) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not configured");
  const base = (
    process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
  ).replace(/\/$/, "");
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  const prompt = PROMPTS.generatePage({
    name,
    appName,
    appDescription,
    instruction,
    datasourceContext,
  });
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new Error(`DeepSeek returned HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned no content");
  const cleaned = content.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  const generated = JSON.parse(cleaned);
  if (!generated.pageConfig || typeof generated.pageConfig !== "object")
    throw new Error("DeepSeek response missing pageConfig");
  return { pageConfig: generated.pageConfig };
}
async function deepSeekGenerateTests({ app, version }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not configured");
  const base = (
    process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
  ).replace(/\/$/, "");
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  const existingTests = (version.tests || []).map((t) => ({
    name: t.name,
    input: t.input,
    expectedOutput: t.expectedOutput,
  }));
  const prompt = PROMPTS.generateTests({ app, version, existingTests });
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new Error(`DeepSeek returned HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned no content");
  const cleaned = content.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  const generated = JSON.parse(cleaned);
  if (!Array.isArray(generated.tests))
    throw new Error("DeepSeek response missing tests array");
  return generated.tests.map((t) => ({
    name: String(t.name || "Generated test").slice(0, 200),
    input: t.input && typeof t.input === "object" ? t.input : {},
    expectedOutput:
      t.expectedOutput && typeof t.expectedOutput === "object"
        ? t.expectedOutput
        : undefined,
  }));
}

/**
 * LLM 生成 Schema：根据需求文档、代码、测试用例生成 input/output JSON Schema
 */
async function deepSeekGenerateSchema({ app, version, target, instruction }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not configured");
  const base = (
    process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
  ).replace(/\/$/, "");
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  const prompt = PROMPTS.generateSchema({
    appName: app.name,
    appDescription: app.description,
    requirements: app.requirements,
    code: version.code,
    tests: (version.tests || []).map((t) => ({
      name: t.name,
      input: t.input,
      expectedOutput: t.expectedOutput,
    })),
    existingSchemas: {
      inputSchema: version.inputSchema,
      outputSchema: version.outputSchema,
    },
    target,
    instruction,
  });
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new Error(`DeepSeek returned HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned no content");
  const cleaned = content.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  const generated = JSON.parse(cleaned);
  if (!generated.schema || typeof generated.schema !== "object")
    throw new Error("DeepSeek response missing schema");
  return { schema: generated.schema };
}

/**
 * LLM 自动修订：将错误信息反馈给 DeepSeek，生成修订版本
 * @param {object} app - 应用对象
 * @param {object} version - 当前版本（含 code, tests, runtime 等）
 * @param {object} prevResult - 上一次运行的结果（含 testResults, runErrors 等）
 * @returns {Promise<object>} { code, summary, tests }
 */
async function deepSeekRevise({ app, version, prevResult, hint }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not configured");
  const base = (
    process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
  ).replace(/\/$/, "");
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";

  const errors =
    prevResult.testResults?.filter((r) => r.actualStatus !== "succeeded") || [];
  const errorSummary = errors
    .map(
      (e) =>
        `Test "${e.name || "unnamed"}": input=${JSON.stringify(e.input ?? {})}, expected=${JSON.stringify(e.expectedOutput ?? null)}, actual=${e.actualStatus}, error=${JSON.stringify(e.error?.message || "none")}`,
    )
    .join("\n");

  const prompt = PROMPTS.revise({ version, errorSummary, hint });

  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new Error(`DeepSeek returned HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned no content");
  // 容错解析：模型常输出带 ```json 包裹、尾部多余文本或 JS 风格 undefined 的响应
  let generated;
  try {
    const cleaned = content
      .replace(/^```json\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    generated = JSON.parse(cleaned);
  } catch {
    // 二次尝试：替换 JS 风格 undefined 为 null，并截取首个 JSON 对象范围
    const cleaned = content
      .replace(/^```json\s*/i, "")
      .replace(/\s*```$/, "")
      .replace(/\bundefined\b/g, "null");
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start)
      throw new Error("DeepSeek response is not valid JSON");
    generated = JSON.parse(cleaned.slice(start, end + 1));
  }
  if (typeof generated.code !== "string")
    throw new Error("DeepSeek response missing code");
  return {
    source: "deepseek-revise",
    summary: generated.summary || "LLM 修订版本",
    code: generated.code,
    tests:
      Array.isArray(generated.tests) && generated.tests.length
        ? generated.tests.slice(0, 3).map((t) => ({
            name: String(t.name || "修订测试").slice(0, 200),
            input: t.input && typeof t.input === "object" ? t.input : {},
            expectedOutput:
              t.expectedOutput && typeof t.expectedOutput === "object"
                ? t.expectedOutput
                : undefined,
          }))
        : version.tests || [],
    usage: payload.usage ?? null,
    model,
  };
}
/**
 * 执行一个版本的代码，创建运行记录并返回结果。
 *
 * @param {object} version - 版本对象（含 code, runtime, appId）
 * @param {object} input - 输入 JSON 对象
 * @param {string} trigger - 触发来源：manual | diagnostic | test | generated_test | webhook | invoke | schedule | inter_app_call
 * @param {object} [options] - 可选参数
 * @param {string} [options.parentRunId] - 父运行记录 ID（用于小程序间调用链追踪）
 * @param {string} [options.callerAppId] - 调用者程序 ID
 * @param {number} [options.callDepth] - 当前调用深度（防止无限递归，默认 0，最大 3）
 * @returns {Promise<object>} 运行记录对象
 */
async function execute(version, input, trigger, options = {}) {
  const ds = datasourceByAppId(version.appId);
  const latestSnapshot = ds
    ? store.datasourceSnapshots
        .filter((s) => s.appId === version.appId && s.status === "applied")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null
    : null;
  const run = {
    id: id("run"),
    appId: version.appId,
    versionId: version.id,
    versionNumber: version.number,
    datasourceSnapshotId: latestSnapshot?.id || null,
    trigger,
    status: "running",
    input,
    logs: [],
    createdAt: now(),
    startedAt: now(),
    parentRunId: options.parentRunId || null,
    callerAppId: options.callerAppId || null,
    callDepth: options.callDepth || 0,
  };
  store.runs.push(run);
  await save();
  const start = performance.now();
  try {
    const runtime = version.runtime || "javascript";
    const policyError = validateCode(version.code, runtime);
    if (policyError) {
      run.status = "rejected";
      run.error = { code: "POLICY_REJECTED", message: policyError };
      return run;
    }

    // 输入 schema 校验
    if (
      version.inputSchema &&
      typeof version.inputSchema === "object" &&
      version.inputSchema.type
    ) {
      const schemaErrors = validateJsonSchema(version.inputSchema, input);
      if (schemaErrors.length > 0) {
        run.status = "rejected";
        run.error = {
          code: "SCHEMA_VALIDATION_FAILED",
          message: `Input does not match the defined schema: ${schemaErrors.join("; ")}`,
          schemaErrors,
        };
        run.logs = [
          {
            level: "error",
            message: run.error.message,
            at: now(),
            fields: { schemaErrors },
          },
        ];
        await save();
        return run;
      }
    }

    const logs = [];
    if (runtime === "wasm") {
      // JSPI-powered WASM execution: async host functions, WASM code looks synchronous
      const { imports, bind } = buildWasmImports(logs, input, ds);
      const module = await WebAssembly.instantiate(
        Buffer.from(version.code, "base64"),
        imports,
      );
      const mem = module.instance.exports.memory;
      const al = module.instance.exports.alloc;
      const fn = module.instance.exports.main;
      if (typeof fn !== "function")
        throw new Error("WASM module must export a main function");
      if (mem) bind(mem, al);

      // Wrap the export so JSPI can suspend/resume across async imports
      const wrappedFn = WebAssembly.promising(fn);
      const resultPtr = await Promise.race([
        wrappedFn(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Execution exceeded 3000 ms")),
            3000,
          ),
        ),
      ]);
      // Decode the returned pointer as a null-terminated string, parse the Hosta envelope
      const resultStr = readWasmStr(mem, resultPtr);
      let envelope;
      try {
        envelope = JSON.parse(resultStr);
      } catch {
        run.status = "failed";
        run.error = {
          code: "INVALID_RESULT",
          message: "WASM returned invalid JSON",
        };
        run.logs = logs;
        return run;
      }

      if (envelope && envelope.ok === true) {
        run.status = "succeeded";
        run.result = { value: envelope.data, runtime: "wasm" };
      } else {
        run.status = "failed";
        run.error = {
          code: envelope?.error?.code || "WASM_ERROR",
          message: envelope?.error?.message || "Unknown WASM error",
        };
      }
      run.logs = logs;
      return run;
    }

    // JavaScript 执行：在 vm.createContext 沙箱中运行
    const context = vm.createContext({
      JSON,
      Math,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Date,
      Promise,
      setTimeout: undefined,
      console: undefined,
    });
    vm.runInContext(
      `"use strict"; ${version.code}; globalThis.__hostaMain = main;`,
      context,
      { timeout: 1000 },
    );
    const fn = context.__hostaMain;

    /** ctx 对象：暴露给小程序的安全 API */
    const ctx = {
      /** 内部数据源（只读快照），可通过 ctx.datasource 访问 */
      datasource: ds ? JSON.parse(JSON.stringify(ds.data)) : {},
      /** 结构化日志，最多 100 条 */
      log(level, message, fields) {
        if (logs.length < 100)
          logs.push({
            level: ["debug", "info", "warn", "error"].includes(level)
              ? level
              : "info",
            message: String(message).slice(0, 2000),
            fields: fields ?? null,
            at: now(),
          });
      },
      /** 获取当前时间戳 */
      now: () => Date.now(),
      /**
       * 调用另一个已发布的小程序（小程序互联）
       * 平台内部代理，不经过 HTTP 栈，性能更好
       */
      call: async (appCode, callInput, callOptions = {}) => {
        const depth = (options.callDepth || 0) + 1;
        if (depth > 3) throw new Error("Inter-app call depth exceeded (max 3)");
        const target = appByCode(appCode);
        if (!target) throw new Error(`App not found: ${appCode}`);
        const deployment = store.deployments.find(
          (d) => d.appId === target.id && d.status === "active",
        );
        if (!deployment) throw new Error(`App not published: ${appCode}`);
        const targetVersion = versionById(deployment.versionId);
        const callRun = await execute(
          targetVersion,
          callInput,
          "inter_app_call",
          {
            parentRunId: run.id,
            callerAppId: version.appId,
            callDepth: depth,
          },
        );
        if (callRun.status !== "succeeded") {
          throw new Error(
            callRun.error?.message || `Inter-app call to '${appCode}' failed`,
          );
        }
        return callRun.result;
      },
      /**
       * 从外部 HTTP 端点获取数据（受限）
       * 仅允许 GET 请求，限制响应大小 512KB，限制超时 5s
       */
      fetch: async (url, fetchOptions = {}) => {
        const method = (fetchOptions.method || "GET").toUpperCase();
        if (method !== "GET")
          throw new Error("ctx.fetch only supports GET requests");
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol))
          throw new Error("ctx.fetch only supports http/https URLs");
        const blocked = ["127.0.0.1", "localhost", "::1", "0.0.0.0"];
        if (blocked.includes(parsed.hostname))
          throw new Error("ctx.fetch cannot access localhost");
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        try {
          const resp = await fetch(url, {
            method: "GET",
            headers: fetchOptions.headers || {},
            signal: ctrl.signal,
            redirect: "follow",
          });
          const text = await resp.text();
          if (text.length > 524288)
            throw new Error("ctx.fetch response exceeds 512KB limit");
          const contentType = resp.headers.get("content-type") || "";
          if (contentType.includes("json")) {
            try {
              return JSON.parse(text);
            } catch {
              return text;
            }
          }
          return text;
        } finally {
          clearTimeout(timer);
        }
      },
    };

    const result = await Promise.race([
      Promise.resolve(fn(input, ctx)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Execution exceeded 3000 ms")), 3000),
      ),
    ]);
    const encoded = JSON.stringify(result);
    if (encoded.length > 1_048_576) throw new Error("Result exceeds 1 MiB");
    run.status = "succeeded";
    run.result = safeJson(result);
    run.logs = logs;
  } catch (err) {
    run.status = /exceeded 3000/.test(String(err.message))
      ? "timed_out"
      : "failed";
    run.error = {
      code:
        run.status === "timed_out" ? "EXECUTION_TIMEOUT" : "USER_CODE_ERROR",
      message: String(err.message).slice(0, 2000),
    };
  } finally {
    run.finishedAt = now();
    run.durationMs = Math.round(performance.now() - start);
    await save();
  }
  return run;
}
const scheduleTimers = new Map();
function armSchedule(schedule) {
  const old = scheduleTimers.get(schedule.id);
  if (old) clearTimeout(old);
  if (schedule.status !== "active") return;
  const due = Date.parse(schedule.nextRunAt || now());
  const delay = Math.max(0, Math.min(2_147_000_000, due - Date.now()));
  scheduleTimers.set(
    schedule.id,
    setTimeout(async () => {
      const latest = scheduleById(schedule.id);
      const version = latest && versionById(latest.versionId);
      if (!latest || latest.status !== "active" || !version) return;
      const run = await execute(version, latest.input, "schedule");
      latest.lastRunId = run.id;
      latest.lastRunAt = now();
      latest.nextRunAt = new Date(
        Date.now() + latest.intervalSeconds * 1000,
      ).toISOString();
      await save();
      armSchedule(latest);
    }, delay),
  );
}
function armAllSchedules() {
  for (const schedule of store.schedules) armSchedule(schedule);
}
async function runMigration(app, migrationScript) {
  const ds = datasourceByAppId(app.id);
  const currentData = ds ? ds.data : {};
  const logs = [];
  const context = vm.createContext({
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Date,
    data: JSON.parse(JSON.stringify(currentData)),
    console: {
      log: (...args) => {
        logs.push(
          args
            .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
            .join(" "),
        );
      },
    },
  });
  try {
    vm.runInContext(`"use strict"; ${migrationScript}`, context, {
      timeout: 5000,
    });
    const migrated = JSON.parse(JSON.stringify(context.data));
    if (
      typeof migrated !== "object" ||
      migrated === null ||
      Array.isArray(migrated)
    )
      throw new Error("Migration must produce a plain object");
    return { success: true, before: currentData, after: migrated, logs };
  } catch (err) {
    return { success: false, error: String(err.message).slice(0, 2000), logs };
  }
}
function contentType(file) {
  return extname(file) === ".css"
    ? "text/css; charset=utf-8"
    : extname(file) === ".js"
      ? "text/javascript; charset=utf-8"
      : "text/html; charset=utf-8";
}
async function staticFile(res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = resolve(staticDir, requested);
  if (
    !file.startsWith(`${staticDir}/`) &&
    file !== join(staticDir, "index.html")
  )
    return false;
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": contentType(file) });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/llms.txt") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(`# Hosta API

Hosta creates and hosts short JavaScript or WebAssembly functions.

## Discovery
- GET /api/apps lists applications, versions, deployments and recent runs.
- GET /api/discover lists all published applications with their invoke documentation (public catalog).
- GET /api/apps/:id retrieves an application.
- GET /api/apps/:id/invoke-docs returns call documentation and examples for a specific app.
- GET /health reports service health.

## Create and run
- POST /api/apps body: {name, description, sampleInput, runtime: "javascript" | "wasm", language?: "rust" | "moonbit"}. code is auto-generated as "{serial}-{slug}" (serial is a unique backend counter, slug is URL-safe).
- PATCH /api/apps/:id body: {code} updates the semantic slug (URL-safe a-z/0-9/-, duplicates allowed, serial is fixed).
- POST /api/sample-input body: {description, runtime} generates a sample input from the description.
- POST /api/format body: {code, runtime, language} formats code with prettier, rustfmt or moonfmt.
- POST /api/apps/:id/generate creates a source version and compiles WASM programs.
- POST /api/versions/:id/run body: JSON input.
- POST /api/versions/:id/diagnose body: JSON input. Returns diagnostics plus a 0-5 code quality score.
- POST /api/versions/:id/revise feeds failed test results to the LLM and creates a revised version (new version is linked via revisedFrom).
- POST /api/versions/:id/tests body: {name?, input, expectedOutput?} adds a test case to a version.
- GET|DELETE /api/versions/:id/tests/:idx lists/removes a test case.
- POST /api/versions/:id/tests/generate asks the LLM to generate extra test cases.
- POST /api/versions/:id/tests/run-all runs every test case and reports passed/total.

## Publish and invoke
- POST /api/apps/:id/publish after a successful manual run.
- GET /api/apps/:id/invoke-docs returns call documentation and examples for an app.
- GET|POST /invoke/:appCode invokes the published version. GET accepts ?key= (or ?api_key=) plus ?input={json} or flat query pairs; POST requires Authorization: Bearer <deployment key>.
- POST /hooks/:id with Authorization: Bearer <deployment key> invokes a deployment by id.
- DELETE /api/apps/:id deletes an application, versions, deployments, schedules and runs.

## Pages & UI (Generative UI)
- GET /api/apps/:id/pages — list all pages for an app.
- POST /api/apps/:id/pages — create a page. body: {name, pageConfig?, processScript?}. pageConfig is a version "1.0" PageConfig JSON (layout + regions + optional dataSources). processScript is a JavaScript function body: (input, datasource) => processedData.
- PUT /api/apps/:id/pages/:pageId — update a page's name, pageConfig, or processScript.
- DELETE /api/apps/:id/pages/:pageId — delete a page.
- POST /api/apps/:id/pages/:pageId/data — execute the page's processScript. body: input JSON. Returns {data: processedResult}. Uses vm.createContext sandbox with 10s timeout.
- GET /api/apps/code/:code/pages — public: get pages for display by app code (no auth required).
- POST /api/ai/generate-page — AI generates a PageConfig JSON. body: {name, appName?, appDescription?, instruction?, appId?}. When appId is provided, datasource context is injected into the prompt. The LLM receives a full component catalog (24+ components with Zod-typed props) and 6 common scenario patterns (Dashboard, Data CRUD, Detail, List/Browse, Form/Wizard, Monitoring/Status). Returns {pageConfig: PageConfig}.

## Runtime contracts (JavaScript ctx object)
- define async function main(input, ctx).
- ctx.log(level, message, fields?) writes a structured log (level: debug|info|warn|error, capped at 100 entries).
- ctx.now() returns the current epoch millisecond timestamp.
- ctx.call(appCode, input, options?) invokes another PUBLISHED app's current version and returns its result. Depth is capped at 3. Requires the target to be published (active deployment). Usage: const result = await ctx.call('order-summary', input);
- ctx.fetch(url, options?) fetches data from an external HTTP/HTTPS endpoint. Only GET requests are allowed. Response size is capped at 512KB, timeout at 5s. Localhost URLs are blocked. Returns parsed JSON if content-type contains 'json', otherwise returns text. Usage: const data = await ctx.fetch('https://api.example.com/data');
- wasm/rust: Rust source for #![no_std] #![no_main] WASM. Exports: alloc(size) -> *mut u8, main() -> i32 (pointer to JSON envelope string). Imports via #[link(wasm_import_module = "env")]: fetch(url_ptr, url_len) -> *mut u8, log(ptr, len), now() -> i64, get_input(ptr, max_len) -> usize, get_datasource(ptr, max_len) -> usize. Hosta compiles with rustc --target wasm32-unknown-unknown. JSPI enables async fetch to look synchronous.
- JSON envelope protocol: All host function returns & main() return use {"ok":true,"data":"..."} for success, {"ok":false,"error":{"code":"CODE","message":"..."}} for error. Use the helpers: ok(data), err(code, msg), is_ok(ptr), envelope_data(ptr).
- wasm/moonbit: submit MoonBit source defining pub fn run() -> Int. Hosta compiles with moon build --target wasm. (JSPI async not yet supported for MoonBit)
- The compiled WASM binary is stored server-side; agents must submit source, not base64 modules.
`);
    }
    if (req.method === "GET" && url.pathname === "/health")
      return json(res, 200, {
        status: "healthy",
        service: "hosta",
        generator: process.env.DEEPSEEK_API_KEY ? "deepseek" : "local-demo",
      });
    if (req.method === "GET" && url.pathname === "/api/apps")
      return json(res, 200, store.apps.map(publicApp));
    if (req.method === "GET" && url.pathname === "/api/discover") {
      const origin = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host || "127.0.0.1:4173"}`;
      const published = store.apps
        .filter((app) =>
          store.deployments.some(
            (d) => d.appId === app.id && d.status === "active",
          ),
        )
        .map((app) => {
          const deployment = store.deployments.find(
            (d) => d.appId === app.id && d.status === "active",
          );
          const publishedVersion = app.publishedVersionId
            ? versionById(app.publishedVersionId)
            : null;
          // 从已发布版本的测试用例推断输入/输出 schema
          const tests = publishedVersion?.tests || [];
          const inputSchema = inferSchemaFromTests(tests, "input");
          const outputSchema = inferSchemaFromTests(tests, "expectedOutput");
          const capabilities = inferCapabilities(publishedVersion || {});
          const callExample = app.code
            ? `const result = await ctx.call('${app.code}', { /* input */ });`
            : null;
          return {
            code: app.code,
            name: app.name,
            description: app.description,
            runtime: app.runtime,
            ...invokeDocsFor(app, deployment, origin),
            inputSchema,
            outputSchema,
            capabilities,
            callExample,
          };
        });
      return json(res, 200, {
        published,
        count: published.length,
        generator: process.env.DEEPSEEK_API_KEY ? "deepseek" : "local-demo",
      });
    }
    if (req.method === "POST" && url.pathname === "/api/apps") {
      const input = await body(req);
      if (
        !String(input.name || "").trim() ||
        !String(input.description || "").trim()
      )
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "Name and description are required",
        );
      const runtime = input.runtime === "wasm" ? "wasm" : "javascript";
      const language =
        runtime === "wasm" && input.language === "moonbit"
          ? "moonbit"
          : runtime === "wasm"
            ? "rust"
            : "javascript";
      const name = String(input.name).trim().slice(0, 120);
      const serial = nextSerial++;
      const app = {
        id: id("app"),
        serial,
        code: appCode(name, serial),
        name,
        description: String(input.description).trim().slice(0, 4000),
        requirements: String(input.requirements || "")
          .trim()
          .slice(0, 20000),
        runtime,
        language,
        sampleInput: input.sampleInput ?? {},
        draftVersionId: null,
        publishedVersionId: null,
        createdAt: now(),
        updatedAt: now(),
      };
      store.apps.push(app);
      await save();
      return json(res, 201, publicApp(app));
    }
    if (req.method === "POST" && url.pathname === "/api/sample-input") {
      const input = await body(req);
      const description = String(input.description || "").trim();
      if (!description)
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "Description is required to generate a sample input",
        );
      const runtime = input.runtime === "wasm" ? "wasm" : "javascript";
      try {
        return json(res, 200, await deepSeekSample({ description, runtime }));
      } catch (e) {
        return error(
          res,
          502,
          "MODEL_ERROR",
          `Sample generation failed: ${e.message}`,
        );
      }
    }
    if (req.method === "POST" && url.pathname === "/api/format") {
      const input = await body(req);
      const code = String(input.code || "");
      const runtime = input.runtime === "wasm" ? "wasm" : "javascript";
      const language =
        runtime === "wasm" && input.language === "moonbit"
          ? "moonbit"
          : runtime === "wasm"
            ? "rust"
            : "javascript";
      if (!code)
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "Code is required to format",
        );
      try {
        return json(res, 200, await formatCode({ code, runtime, language }));
      } catch (e) {
        return error(res, 400, "FORMAT_ERROR", e.message);
      }
    }
    const versionCreateMatch = url.pathname.match(
      /^\/api\/apps\/([^/]+)\/versions$/,
    );
    if (req.method === "POST" && versionCreateMatch) {
      const app = appById(versionCreateMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      const code = String(payload.code || "");
      const runtime =
        payload.runtime === "wasm" ? "wasm" : app.runtime || "javascript";
      const language =
        runtime === "wasm" && payload.language === "moonbit"
          ? "moonbit"
          : runtime === "wasm"
            ? "rust"
            : "javascript";
      const compiled =
        runtime === "wasm"
          ? await compileWasm(language, code)
          : { binary: code, size: Buffer.byteLength(code) };
      const diagnostics = diagnosticsFor(compiled.binary, runtime);
      const hasError = diagnostics.some((item) => item.severity === "error");
      const prevVersion = versionById(app.draftVersionId);
      const inputSchema =
        payload.inputSchema && typeof payload.inputSchema === "object"
          ? payload.inputSchema
          : prevVersion?.inputSchema || null;
      const outputSchema =
        payload.outputSchema && typeof payload.outputSchema === "object"
          ? payload.outputSchema
          : prevVersion?.outputSchema || null;
      const version = {
        id: id("ver"),
        appId: app.id,
        runtime,
        language,
        sourceCode: runtime === "wasm" ? code : undefined,
        wasmSize: runtime === "wasm" ? compiled.size : undefined,
        number: store.versions.filter((v) => v.appId === app.id).length + 1,
        status: hasError ? "needs_revision" : "ready",
        source: "manual-edit",
        summary: String(payload.summary || "用户编辑的程序版本").slice(0, 500),
        code: compiled.binary,
        codeSha256: sha(compiled.binary),
        inputSchema,
        outputSchema,
        tests:
          prevVersion && prevVersion.tests && prevVersion.tests.length
            ? prevVersion.tests.map((t) => ({
                name: t.name,
                input: t.input,
                expectedOutput: t.expectedOutput,
              }))
            : [],
        validationError:
          diagnostics.find((item) => item.severity === "error")?.message ||
          null,
        diagnostics,
        createdAt: now(),
      };
      store.versions.push(version);
      app.draftVersionId = version.id;
      app.updatedAt = now();
      await save();
      return json(res, 201, version);
    }
    const generateMatch = url.pathname.match(
      /^\/api\/apps\/([^/]+)\/generate$/,
    );
    if (req.method === "POST" && generateMatch) {
      const app = appById(generateMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const runtime = app.runtime || "javascript";
      const language = app.language || "javascript";
      const generated = await deepSeekGenerate({
        description: app.description,
        sampleInput: app.sampleInput,
        requirements: app.requirements,
        runtime,
        datasourceSchema: (datasourceByAppId(app.id) || {}).schema || null,
      });
      const sourceCode =
        runtime === "wasm"
          ? language === "moonbit"
            ? moonStarter
            : rustStarter
          : generated.code;
      const compiled =
        runtime === "wasm"
          ? await compileWasm(language, sourceCode)
          : { binary: generated.code, size: Buffer.byteLength(generated.code) };
      const problem = validateCode(compiled.binary, runtime);
      const version = {
        id: id("ver"),
        appId: app.id,
        runtime,
        language,
        sourceCode: runtime === "wasm" ? sourceCode : undefined,
        wasmSize: runtime === "wasm" ? compiled.size : undefined,
        number: store.versions.filter((v) => v.appId === app.id).length + 1,
        status: problem ? "needs_revision" : "ready",
        source: generated.source,
        summary: generated.summary,
        code: compiled.binary,
        codeSha256: sha(compiled.binary),
        inputSchema: null,
        tests: generated.tests,
        validationError: problem || null,
        createdAt: now(),
      };
      store.versions.push(version);
      app.draftVersionId = version.id;
      app.updatedAt = now();
      await save();
      store.modelCalls.push({
        id: id("model"),
        appId: app.id,
        versionId: version.id,
        provider: generated.source,
        model: generated.model,
        usage: generated.usage,
        estimatedCost: null,
        createdAt: now(),
      });
      await save();
      if (!problem) {
        for (const test of generated.tests)
          await execute(version, test.input ?? {}, "generated_test");
      }
      return json(res, 201, version);
    }
    const refineMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/refine$/);
    if (req.method === "POST" && refineMatch) {
      const app = appById(refineMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const version = versionById(app.draftVersionId);
      const payload = await body(req);
      const instruction = String(payload.instruction || "").trim();
      if (!instruction)
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "refine instruction is required",
        );
      const runtime = app.runtime || "javascript";
      const language = app.language || "javascript";
      try {
        const generated = await deepSeekRefine({
          app,
          version,
          instruction,
          datasourceSchema: (datasourceByAppId(app.id) || {}).schema || null,
        });
        const compiled = {
          binary: generated.code,
          size: Buffer.byteLength(generated.code),
        };
        const diagnostics = diagnosticsFor(compiled.binary, runtime);
        const hasError = diagnostics.some((item) => item.severity === "error");
        const newVersion = {
          id: id("ver"),
          appId: app.id,
          runtime,
          language,
          number: store.versions.filter((v) => v.appId === app.id).length + 1,
          status: hasError ? "needs_revision" : "ready",
          source: generated.source,
          summary: generated.summary,
          code: compiled.binary,
          codeSha256: sha(compiled.binary),
          inputSchema: version?.inputSchema || null,
          tests: generated.tests,
          validationError: hasError
            ? diagnostics.find((d) => d.severity === "error")?.message || null
            : null,
          diagnostics,
          createdAt: now(),
          revisedFrom: version?.id || null,
        };
        store.versions.push(newVersion);
        app.draftVersionId = newVersion.id;
        app.updatedAt = now();
        await save();
        store.modelCalls.push({
          id: id("model"),
          appId: app.id,
          versionId: newVersion.id,
          provider: generated.source,
          model: generated.model,
          usage: generated.usage,
          estimatedCost: null,
          createdAt: now(),
        });
        await save();
        if (!hasError) {
          for (const test of generated.tests)
            await execute(newVersion, test.input ?? {}, "generated_test");
        }
        return json(res, 201, newVersion);
      } catch (e) {
        return error(
          res,
          502,
          "MODEL_ERROR",
          `Refinement failed: ${e.message}`,
        );
      }
    }
    const refineReqMatch = url.pathname.match(
      /^\/api\/apps\/([^/]+)\/refine-requirements$/,
    );
    if (req.method === "POST" && refineReqMatch) {
      const app = appById(refineReqMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      const instruction = String(payload.instruction || "").trim();
      if (!instruction)
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "refine instruction is required",
        );
      try {
        const result = await deepSeekRefineRequirements({
          requirements: app.requirements || "",
          instruction,
          appName: app.name,
          appDescription: app.description || "",
        });
        return json(res, 200, {
          summary: result.summary,
          refined: result.refined,
        });
      } catch (e) {
        return error(
          res,
          502,
          "MODEL_ERROR",
          `Requirements refinement failed: ${e.message}`,
        );
      }
    }
    const testsMatch = url.pathname.match(/^\/api\/versions\/([^\/]+)\/tests$/);
    if (req.method === "GET" && testsMatch) {
      const version = versionById(testsMatch[1]);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const tests = (version.tests || []).map((t, i) => ({ index: i, ...t }));
      return json(res, 200, { versionId: version.id, tests });
    }
    if (req.method === "POST" && testsMatch) {
      const version = versionById(testsMatch[1]);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const payload = await body(req);
      if (!payload.input || typeof payload.input !== "object")
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "Test input must be a JSON object",
        );
      // 如果有 inputSchema，校验测试输入
      if (
        version.inputSchema &&
        typeof version.inputSchema === "object" &&
        version.inputSchema.type
      ) {
        const schemaErrors = validateJsonSchema(
          version.inputSchema,
          payload.input,
        );
        if (schemaErrors.length > 0) {
          return error(
            res,
            400,
            "SCHEMA_VALIDATION_FAILED",
            `Test input does not match the defined schema: ${schemaErrors.join("; ")}`,
          );
        }
      }
      version.tests = version.tests || [];
      version.tests.push({
        name:
          String(payload.name || "")
            .trim()
            .slice(0, 200) || `Test ${version.tests.length + 1}`,
        input: payload.input,
        expectedOutput:
          payload.expectedOutput && typeof payload.expectedOutput === "object"
            ? payload.expectedOutput
            : undefined,
      });
      await save();
      return json(res, 201, {
        index: version.tests.length - 1,
        name: version.tests[version.tests.length - 1].name,
        input: payload.input,
        expectedOutput: version.tests[version.tests.length - 1].expectedOutput,
      });
    }
    const testRunAllMatch = url.pathname.match(
      /^\/api\/versions\/([^\/]+)\/tests\/run-all$/,
    );
    if (req.method === "POST" && testRunAllMatch) {
      const version = versionById(testRunAllMatch[1]);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const tests = version.tests || [];
      const results = [];
      for (const test of tests) {
        const run = await execute(version, test.input ?? {}, "test");
        const matched = test.expectedOutput
          ? JSON.stringify(run.result) === JSON.stringify(test.expectedOutput)
          : undefined;
        results.push({
          name: test.name,
          input: test.input,
          expectedOutput: test.expectedOutput,
          actualStatus: run.status,
          matched,
          runId: run.id,
          durationMs: run.durationMs,
          result: run.result,
          error: run.error,
        });
      }
      return json(res, 200, {
        versionId: version.id,
        passed: results.filter((r) => r.actualStatus === "succeeded").length,
        total: results.length,
        results,
      });
    }
    const testGenerateMatch = url.pathname.match(
      /^\/api\/versions\/([^\/]+)\/tests\/generate$/,
    );
    if (req.method === "POST" && testGenerateMatch) {
      const version = versionById(testGenerateMatch[1]);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const app = appById(version.appId);
      try {
        const generated = await deepSeekGenerateTests({ app, version });
        version.tests = version.tests || [];
        let added = 0;
        for (const t of generated) {
          // 如果已定义 inputSchema，只保留符合 schema 的测试
          if (
            version.inputSchema &&
            typeof version.inputSchema === "object" &&
            version.inputSchema.type
          ) {
            const schemaErrors = validateJsonSchema(
              version.inputSchema,
              t.input,
            );
            if (schemaErrors.length > 0) {
              console.warn(
                `[tests] skipping generated test "${t.name}": input does not match schema: ${schemaErrors.join("; ")}`,
              );
              continue;
            }
          }
          version.tests.push(t);
          added++;
        }
        await save();
        return json(res, 200, {
          generated: added,
          tests: version.tests.map((t, i) => ({
            index: i,
            name: t.name,
            input: t.input,
            expectedOutput: t.expectedOutput,
          })),
        });
      } catch (e) {
        return error(
          res,
          502,
          "MODEL_ERROR",
          `Test generation failed: ${e.message}`,
        );
      }
    }
    const testDeleteMatch = url.pathname.match(
      /^\/api\/versions\/([^\/]+)\/tests\/(\d+)$/,
    );
    if (req.method === "DELETE" && testDeleteMatch) {
      const version = versionById(testDeleteMatch[1]);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const idx = Number(testDeleteMatch[2]);
      if (!version.tests || idx < 0 || idx >= version.tests.length)
        return error(res, 404, "NOT_FOUND", "Test not found");
      version.tests.splice(idx, 1);
      await save();
      return json(res, 200, { deleted: idx });
    }
    // Schema 生成
    const schemaGenerateMatch = url.pathname.match(
      /^\/api\/versions\/([^\/]+)\/schema\/generate$/,
    );
    if (req.method === "POST" && schemaGenerateMatch) {
      const version = versionById(schemaGenerateMatch[1]);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const app = appById(version.appId);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      const target = payload.target === "output" ? "output" : "input";
      const instruction = String(payload.instruction || "").trim();
      try {
        const { schema } = await deepSeekGenerateSchema({
          app,
          version,
          target,
          instruction,
        });
        return json(res, 200, { schema, target });
      } catch (e) {
        return error(
          res,
          502,
          "MODEL_ERROR",
          `Schema generation failed: ${e.message}`,
        );
      }
    }
    // 输入 schema 更新
    const schemaMatch = url.pathname.match(
      /^\/api\/versions\/([^\/]+)\/schema$/,
    );
    if (req.method === "PUT" && schemaMatch) {
      const version = versionById(schemaMatch[1]);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const payload = await body(req);
      if (
        !payload.inputSchema ||
        typeof payload.inputSchema !== "object" ||
        !payload.inputSchema.type
      )
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "inputSchema must be a valid JSON Schema object with a type",
        );
      version.inputSchema = payload.inputSchema;
      if (payload.outputSchema !== undefined) {
        version.outputSchema =
          payload.outputSchema &&
          typeof payload.outputSchema === "object" &&
          payload.outputSchema.type
            ? payload.outputSchema
            : null;
      }
      await save();
      return json(res, 200, {
        versionId: version.id,
        inputSchema: version.inputSchema,
        outputSchema: version.outputSchema || null,
      });
    }
    // 自动修订：将测试失败/运行错误反馈给 LLM，生成修复版本
    const reviseMatch = url.pathname.match(
      /^\/api\/versions\/([^\/]+)\/revise$/,
    );
    if (req.method === "POST" && reviseMatch) {
      const version = versionById(reviseMatch[1]);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const app = appById(version.appId);
      const payload = await body(req);
      const hint = String(payload.hint || "").trim();
      // 收集上次运行的失败信息
      const testResults = [];
      const tests = version.tests || [];
      for (const test of tests) {
        const run = await execute(version, test.input ?? {}, "test");
        const matched = test.expectedOutput
          ? JSON.stringify(run.result) === JSON.stringify(test.expectedOutput)
          : undefined;
        testResults.push({
          name: test.name,
          input: test.input,
          expectedOutput: test.expectedOutput,
          actualStatus: run.status,
          matched,
          runId: run.id,
          durationMs: run.durationMs,
          error: run.error,
        });
      }
      try {
        const revised = await deepSeekRevise({
          app,
          version,
          prevResult: { testResults },
          hint,
        });
        const compiled = {
          binary: revised.code,
          size: Buffer.byteLength(revised.code),
        };
        const problem = validateCode(
          compiled.binary,
          version.runtime || "javascript",
        );
        const newVersion = {
          id: id("ver"),
          appId: app.id,
          runtime: version.runtime || "javascript",
          language: version.language || "javascript",
          sourceCode: undefined,
          wasmSize: undefined,
          number: store.versions.filter((v) => v.appId === app.id).length + 1,
          status: problem ? "needs_revision" : "ready",
          source: revised.source,
          summary: revised.summary,
          code: compiled.binary,
          codeSha256: sha(compiled.binary),
          tests: revised.tests,
          validationError: problem || null,
          revisedFrom: version.id,
          createdAt: now(),
        };
        store.versions.push(newVersion);
        app.draftVersionId = newVersion.id;
        app.updatedAt = now();
        store.modelCalls.push({
          id: id("model"),
          appId: app.id,
          versionId: newVersion.id,
          provider: revised.source,
          model: revised.model,
          usage: revised.usage,
          estimatedCost: null,
          createdAt: now(),
        });
        await save();
        if (!problem) {
          for (const test of revised.tests)
            await execute(newVersion, test.input ?? {}, "generated_test");
        }
        return json(res, 201, {
          version: newVersion,
          prevTestResults: testResults,
        });
      } catch (e) {
        return error(res, 502, "MODEL_ERROR", `Revision failed: ${e.message}`);
      }
    }
    const versionListMatch = url.pathname.match(
      /^\/api\/apps\/([^\/]+)\/versions$/,
    );
    if (req.method === "GET" && versionListMatch) {
      const app = appById(versionListMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const versions = store.versions
        .filter((v) => v.appId === app.id)
        .sort((a, b) => b.number - a.number);
      return json(res, 200, {
        appId: app.id,
        publishedVersionId: app.publishedVersionId,
        draftVersionId: app.draftVersionId,
        versions,
      });
    }
    const setDefaultVersionMatch = url.pathname.match(
      /^\/api\/apps\/([^\/]+)\/set-default-version$/,
    );
    if (req.method === "POST" && setDefaultVersionMatch) {
      const app = appById(setDefaultVersionMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      const version = versionById(payload.versionId);
      if (!version || version.appId !== app.id)
        return error(res, 404, "NOT_FOUND", "Version not found");
      if (version.status !== "ready")
        return error(
          res,
          400,
          "NOT_PUBLISHABLE",
          "Version must be in ready status",
        );
      const deployment = store.deployments.find((d) => d.appId === app.id);
      if (deployment) {
        deployment.versionId = version.id;
        deployment.updatedAt = now();
      }
      app.publishedVersionId = version.id;
      app.updatedAt = now();
      await save();
      return json(res, 200, {
        appId: app.id,
        publishedVersionId: version.id,
        versionNumber: version.number,
      });
    }
    const runMatch = url.pathname.match(/^\/api\/versions\/([^/]+)\/run$/);
    if (req.method === "POST" && runMatch) {
      const version = versionById(runMatch[1]);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const input = await body(req);
      return json(res, 201, await execute(version, input, "manual"));
    }
    const diagnoseMatch = url.pathname.match(
      /^\/api\/versions\/([^/]+)\/diagnose$/,
    );
    if (req.method === "POST" && diagnoseMatch) {
      const version = versionById(diagnoseMatch[1]);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const input = await body(req);
      const diagnostics = diagnosticsFor(
        version.code,
        version.runtime || "javascript",
      );
      const run = diagnostics.some((item) => item.severity === "error")
        ? null
        : await execute(version, input, "diagnostic");
      if (run?.status !== "succeeded")
        diagnostics.push({
          severity: "error",
          code: run?.error?.code || "EXECUTION_FAILED",
          message: run?.error?.message || "Execution did not complete",
          runId: run?.id,
        });
      else
        diagnostics.push({
          severity: "info",
          code: "EXECUTION_SUCCEEDED",
          message: `样例执行成功，耗时 ${run.durationMs} ms。`,
          runId: run.id,
        });
      const quality = codeQualityScore(diagnostics, version.code);
      return json(res, 200, {
        versionId: version.id,
        diagnostics,
        run,
        quality,
      });
    }
    const publishMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/publish$/);
    if (req.method === "POST" && publishMatch) {
      const app = appById(publishMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      const version = versionById(payload.versionId || app.draftVersionId);
      if (!version || version.appId !== app.id || version.status !== "ready")
        return error(
          res,
          400,
          "NOT_PUBLISHABLE",
          "A ready version is required",
        );
      if (
        !store.runs.some(
          (run) =>
            run.versionId === version.id &&
            run.trigger === "manual" &&
            run.status === "succeeded",
        )
      )
        return error(
          res,
          400,
          "TRIAL_REQUIRED",
          "Run this version successfully from the page before publishing",
        );
      let deployment = store.deployments.find((d) => d.appId === app.id);
      const webhookKey = randomBytes(24).toString("base64url");
      if (!deployment) {
        deployment = { id: id("dep"), appId: app.id, createdAt: now() };
        store.deployments.push(deployment);
      }
      Object.assign(deployment, {
        versionId: version.id,
        status: "active",
        keyHash: sha(webhookKey),
        updatedAt: now(),
      });
      app.publishedVersionId = version.id;
      app.updatedAt = now();
      await save();
      return json(res, 200, {
        deployment: { ...deployment, keyHash: undefined },
        webhookKey,
        webhookUrl: `/hooks/${deployment.id}`,
      });
    }
    const scheduleMatch = url.pathname.match(
      /^\/api\/apps\/([^/]+)\/schedules$/,
    );
    if (req.method === "POST" && scheduleMatch) {
      const app = appById(scheduleMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      const version = versionById(
        payload.versionId || app.publishedVersionId || app.draftVersionId,
      );
      const intervalSeconds = Number(payload.intervalSeconds);
      if (!version || version.appId !== app.id || version.status !== "ready")
        return error(
          res,
          400,
          "NOT_SCHEDULABLE",
          "A ready version is required",
        );
      if (
        !Number.isInteger(intervalSeconds) ||
        intervalSeconds < 60 ||
        intervalSeconds > 86400
      )
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "Interval must be between 60 and 86400 seconds",
        );
      const schedule = {
        id: id("sch"),
        appId: app.id,
        versionId: version.id,
        input: payload.input ?? app.sampleInput ?? {},
        intervalSeconds,
        status: "active",
        createdAt: now(),
        nextRunAt: new Date(Date.now() + intervalSeconds * 1000).toISOString(),
        lastRunAt: null,
        lastRunId: null,
      };
      store.schedules.push(schedule);
      await save();
      armSchedule(schedule);
      return json(res, 201, schedule);
    }
    const scheduleDeleteMatch = url.pathname.match(
      /^\/api\/schedules\/([^/]+)$/,
    );
    if (req.method === "DELETE" && scheduleDeleteMatch) {
      const schedule = scheduleById(scheduleDeleteMatch[1]);
      if (!schedule) return error(res, 404, "NOT_FOUND", "Schedule not found");
      schedule.status = "disabled";
      const timer = scheduleTimers.get(schedule.id);
      if (timer) clearTimeout(timer);
      scheduleTimers.delete(schedule.id);
      await save();
      return json(res, 200, schedule);
    }
    const hookMatch = url.pathname.match(/^\/hooks\/([^/]+)$/);
    if (req.method === "POST" && hookMatch) {
      const deployment = deploymentById(hookMatch[1]);
      if (!deployment || deployment.status !== "active")
        return error(res, 404, "NOT_FOUND", "Deployment not found");
      const token = String(req.headers.authorization || "").replace(
        /^Bearer\s+/i,
        "",
      );
      if (!token || sha(token) !== deployment.keyHash)
        return error(
          res,
          401,
          "UNAUTHORIZED",
          "A valid Bearer key is required",
        );
      const version = versionById(deployment.versionId);
      return json(res, 200, await execute(version, await body(req), "webhook"));
    }
    // ── 版本钉选调用：/invoke-version/:appCode/:version ──
    const invokePinnedMatch = url.pathname.match(
      /^\/invoke-version\/([a-z0-9-]+)\/(\d+)$/,
    );
    if (invokePinnedMatch && (req.method === "GET" || req.method === "POST")) {
      const app = appByCode(invokePinnedMatch[1]);
      const versionNumber = parseInt(invokePinnedMatch[2], 10);
      if (!app) return error(res, 404, "NOT_FOUND", "Application not found");
      const deployment = store.deployments.find(
        (item) => item.appId === app.id && item.status === "active",
      );
      if (!deployment)
        return error(
          res,
          404,
          "NOT_FOUND",
          "No active deployment for this application",
        );
      const version = store.versions.find(
        (v) => v.appId === app.id && v.number === versionNumber,
      );
      if (!version)
        return error(
          res,
          404,
          "NOT_FOUND",
          `Version v${versionNumber} not found`,
        );
      if (version.status !== "ready")
        return error(
          res,
          400,
          "VERSION_NOT_READY",
          `Version v${versionNumber} is not ready (status: ${version.status})`,
        );
      const token =
        req.method === "GET"
          ? String(
              url.searchParams.get("key") ||
                url.searchParams.get("api_key") ||
                "",
            )
          : String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!token || sha(token) !== deployment.keyHash)
        return error(
          res,
          401,
          "UNAUTHORIZED",
          "A valid Bearer key is required",
        );
      return json(
        res,
        200,
        await execute(version, await inputFromRequest(req), "invoke-pinned"),
      );
    }
    // ── 浮动版本调用：/invoke/:appCode（始终调用最新发布版本）──
    const invokeMatch = url.pathname.match(/^\/invoke\/([a-z0-9-]+)$/);
    if (invokeMatch && (req.method === "GET" || req.method === "POST")) {
      const app = appByCode(invokeMatch[1]);
      const deployment =
        app &&
        store.deployments.find(
          (item) => item.appId === app.id && item.status === "active",
        );
      if (!deployment)
        return error(res, 404, "NOT_FOUND", "Published application not found");
      const token =
        req.method === "GET"
          ? String(
              url.searchParams.get("key") ||
                url.searchParams.get("api_key") ||
                "",
            )
          : String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!token || sha(token) !== deployment.keyHash)
        return error(
          res,
          401,
          "UNAUTHORIZED",
          "A valid Bearer key is required",
        );
      return json(
        res,
        200,
        await execute(
          versionById(deployment.versionId),
          await inputFromRequest(req),
          "invoke",
        ),
      );
    }
    const invokeDocsMatch = url.pathname.match(
      /^\/api\/apps\/([^\/]+)\/invoke-docs$/,
    );
    if (req.method === "GET" && invokeDocsMatch) {
      const app = appById(invokeDocsMatch[1]) || appByCode(invokeDocsMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const deployment = store.deployments.find(
        (d) => d.appId === app.id && d.status === "active",
      );
      const origin = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host || "127.0.0.1:4173"}`;
      return json(res, 200, invokeDocsFor(app, deployment, origin));
    }
    const appEditMatch = url.pathname.match(/^\/api\/apps\/([^\/]+)$/);
    const datasourceMatch = url.pathname.match(
      /^\/api\/apps\/([^\/]+)\/datasource$/,
    );
    if (req.method === "GET" && datasourceMatch) {
      const app = appById(datasourceMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const ds = datasourceByAppId(app.id);
      return json(res, 200, {
        appId: app.id,
        data: ds ? ds.data : {},
        schema: ds ? ds.schema || null : null,
        updatedAt: ds ? ds.updatedAt : null,
        snapshotCount: store.datasourceSnapshots.filter(
          (s) => s.appId === app.id,
        ).length,
      });
    }
    if (req.method === "PUT" && datasourceMatch) {
      const app = appById(datasourceMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      if (
        typeof payload.data !== "object" ||
        payload.data === null ||
        Array.isArray(payload.data)
      )
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "Data must be a JSON object",
        );
      // 可选的 schema 字段
      if (
        payload.schema !== undefined &&
        payload.schema !== null &&
        (typeof payload.schema !== "object" || Array.isArray(payload.schema))
      )
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "Schema must be a JSON Schema object or null",
        );
      let ds = datasourceByAppId(app.id);
      if (!ds) {
        ds = { id: id("ds"), appId: app.id, data: {}, createdAt: now() };
        store.datasources.push(ds);
      }
      // 如果设置了 schema，校验数据
      const effectiveSchema =
        payload.schema !== undefined ? payload.schema : ds.schema;
      if (
        effectiveSchema &&
        typeof effectiveSchema === "object" &&
        effectiveSchema.type
      ) {
        const schemaErrors = validateJsonSchema(effectiveSchema, payload.data);
        if (schemaErrors.length > 0)
          return error(
            res,
            400,
            "SCHEMA_VALIDATION_FAILED",
            `Data does not match the defined schema: ${schemaErrors.join("; ")}`,
          );
      }
      const snapshot = {
        id: id("dss"),
        appId: app.id,
        data: JSON.parse(JSON.stringify(ds.data)),
        createdAt: now(),
      };
      store.datasourceSnapshots.push(snapshot);
      ds.data = payload.data;
      if (payload.schema !== undefined) {
        ds.schema = payload.schema;
      }
      ds.updatedAt = now();
      if (
        store.datasourceSnapshots.filter((s) => s.appId === app.id).length > 50
      ) {
        const oldest = store.datasourceSnapshots
          .filter((s) => s.appId === app.id)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        store.datasourceSnapshots = store.datasourceSnapshots.filter(
          (s) => s.id !== oldest.id,
        );
      }
      await save();
      return json(res, 200, {
        appId: app.id,
        data: ds.data,
        schema: ds.schema || null,
        updatedAt: ds.updatedAt,
        snapshotCount: store.datasourceSnapshots.filter(
          (s) => s.appId === app.id,
        ).length,
      });
    }
    const dsSnapshotsMatch = url.pathname.match(
      /^\/api\/apps\/([^\/]+)\/datasource\/snapshots$/,
    );
    if (req.method === "GET" && dsSnapshotsMatch) {
      const app = appById(dsSnapshotsMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const snapshots = store.datasourceSnapshots
        .filter((s) => s.appId === app.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json(res, 200, {
        appId: app.id,
        snapshots: snapshots.map((s) => ({
          id: s.id,
          createdAt: s.createdAt,
          data: s.data,
          status: s.status || null,
          type: s.type || null,
        })),
      });
    }
    const dsRestoreMatch = url.pathname.match(
      /^\/api\/apps\/([^\/]+)\/datasource\/restore\/([^\/]+)$/,
    );
    if (req.method === "POST" && dsRestoreMatch) {
      const app = appById(dsRestoreMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const snapshot = datasourceSnapshotById(dsRestoreMatch[2]);
      if (!snapshot || snapshot.appId !== app.id)
        return error(res, 404, "NOT_FOUND", "Snapshot not found");
      let ds = datasourceByAppId(app.id);
      if (!ds) {
        ds = { id: id("ds"), appId: app.id, data: {}, createdAt: now() };
        store.datasources.push(ds);
      }
      const before = JSON.parse(JSON.stringify(ds.data));
      ds.data = JSON.parse(JSON.stringify(snapshot.data));
      ds.updatedAt = now();
      await save();
      return json(res, 200, {
        appId: app.id,
        before,
        after: ds.data,
        restoredFrom: snapshot.id,
      });
    }
    const dsMigrateMatch = url.pathname.match(
      /^\/api\/apps\/([^\/]+)\/datasource\/migrate$/,
    );
    if (req.method === "POST" && dsMigrateMatch) {
      const app = appById(dsMigrateMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      const script = String(payload.script || "").trim();
      if (!script)
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "Migration script is required",
        );
      if (script.length > 65536)
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "Migration script too large",
        );
      const result = await runMigration(app, script);
      if (!result.success) return json(res, 400, result);
      const snapshot = {
        id: id("dss"),
        appId: app.id,
        data: JSON.parse(JSON.stringify(result.after)),
        createdAt: now(),
        status: "pending",
        type: "migration",
        before: JSON.parse(JSON.stringify(result.before)),
      };
      store.datasourceSnapshots.push(snapshot);
      if (
        store.datasourceSnapshots.filter((s) => s.appId === app.id).length > 50
      ) {
        const oldest = store.datasourceSnapshots
          .filter((s) => s.appId === app.id)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        store.datasourceSnapshots = store.datasourceSnapshots.filter(
          (s) => s.id !== oldest.id,
        );
      }
      await save();
      return json(res, 200, {
        success: true,
        appId: app.id,
        snapshotId: snapshot.id,
        before: result.before,
        after: result.after,
        logs: result.logs,
      });
    }
    const dsPromoteMatch = url.pathname.match(
      /^\/api\/apps\/([^\/]+)\/datasource\/promote\/([^\/]+)$/,
    );
    if (req.method === "POST" && dsPromoteMatch) {
      const app = appById(dsPromoteMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const snapshot = datasourceSnapshotById(dsPromoteMatch[2]);
      if (!snapshot || snapshot.appId !== app.id)
        return error(res, 404, "NOT_FOUND", "Snapshot not found");
      if (snapshot.status !== "pending")
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "Only pending snapshots can be promoted",
        );
      let ds = datasourceByAppId(app.id);
      if (!ds) {
        ds = { id: id("ds"), appId: app.id, data: {}, createdAt: now() };
        store.datasources.push(ds);
      }
      const before = JSON.parse(JSON.stringify(ds.data));
      ds.data = JSON.parse(JSON.stringify(snapshot.data));
      ds.updatedAt = now();
      snapshot.status = "applied";
      snapshot.appliedAt = now();
      await save();
      return json(res, 200, {
        appId: app.id,
        before,
        after: ds.data,
        snapshotId: snapshot.id,
      });
    }
    // ── External Datasources ──────────────────────────────────────
    const extDsListMatch = url.pathname.match(
      /^\/api\/apps\/([^\/]+)\/external-datasources$/,
    );
    if (req.method === "GET" && extDsListMatch) {
      const app = appById(extDsListMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const items = externalDatasourcesByAppId(app.id);
      return json(res, 200, { appId: app.id, datasources: items });
    }
    if (req.method === "POST" && extDsListMatch) {
      const app = appById(extDsListMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      if (!payload.name || !payload.url)
        return error(res, 400, "VALIDATION_ERROR", "name and url are required");
      const eds = {
        id: id("eds"),
        appId: app.id,
        name: String(payload.name).slice(0, 100),
        url: String(payload.url).slice(0, 2000),
        method: (payload.method || "GET").toUpperCase(),
        headers:
          payload.headers && typeof payload.headers === "object"
            ? payload.headers
            : {},
        inputSchema:
          payload.inputSchema && typeof payload.inputSchema === "object"
            ? payload.inputSchema
            : null,
        outputSchema:
          payload.outputSchema && typeof payload.outputSchema === "object"
            ? payload.outputSchema
            : null,
        createdAt: now(),
        updatedAt: now(),
      };
      store.externalDatasources.push(eds);
      await save();
      return json(res, 201, eds);
    }
    const extDsMatch = url.pathname.match(
      /^\/api\/apps\/([^\/]+)\/external-datasources\/([^\/]+)$/,
    );
    if (req.method === "PUT" && extDsMatch) {
      const app = appById(extDsMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const eds = store.externalDatasources.find(
        (e) => e.id === extDsMatch[2] && e.appId === app.id,
      );
      if (!eds)
        return error(res, 404, "NOT_FOUND", "External datasource not found");
      const payload = await body(req);
      if (payload.name !== undefined)
        eds.name = String(payload.name).slice(0, 100);
      if (payload.url !== undefined)
        eds.url = String(payload.url).slice(0, 2000);
      if (payload.method !== undefined)
        eds.method = payload.method.toUpperCase();
      if (payload.headers !== undefined) eds.headers = payload.headers;
      if (payload.inputSchema !== undefined)
        eds.inputSchema = payload.inputSchema;
      if (payload.outputSchema !== undefined)
        eds.outputSchema = payload.outputSchema;
      eds.updatedAt = now();
      await save();
      return json(res, 200, eds);
    }
    if (req.method === "DELETE" && extDsMatch) {
      const app = appById(extDsMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const idx = store.externalDatasources.findIndex(
        (e) => e.id === extDsMatch[2] && e.appId === app.id,
      );
      if (idx === -1)
        return error(res, 404, "NOT_FOUND", "External datasource not found");
      store.externalDatasources.splice(idx, 1);
      await save();
      return json(res, 200, { deleted: extDsMatch[2] });
    }
    // ── External Datasource Test ──────────────────────────────────
    const extDsTestMatch = url.pathname.match(
      /^\/api\/apps\/([^\/]+)\/external-datasources\/([^\/]+)\/test$/,
    );
    if (req.method === "POST" && extDsTestMatch) {
      const app = appById(extDsTestMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const eds = store.externalDatasources.find(
        (e) => e.id === extDsTestMatch[2] && e.appId === app.id,
      );
      if (!eds)
        return error(res, 404, "NOT_FOUND", "External datasource not found");
      try {
        const fetchOpts = { method: eds.method, headers: { ...eds.headers } };
        if (eds.method !== "GET" && eds.method !== "HEAD") {
          const payload = await body(req);
          fetchOpts.body = JSON.stringify(payload);
          fetchOpts.headers["content-type"] = "application/json";
        }
        const start = Date.now();
        const upstream = await fetch(eds.url, fetchOpts);
        const bodyText = await upstream.text();
        let data;
        try {
          data = JSON.parse(bodyText);
        } catch {
          data = bodyText;
        }
        return json(res, 200, {
          status: upstream.status,
          headers: Object.fromEntries(upstream.headers.entries()),
          data,
          durationMs: Date.now() - start,
        });
      } catch (err) {
        return json(res, 502, { error: err.message });
      }
    }
    if (req.method === "PATCH" && appEditMatch) {
      const app = appById(appEditMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      if (payload.code !== undefined) {
        if (!/^[a-z0-9-]+$/.test(String(payload.code)))
          return error(
            res,
            400,
            "VALIDATION_ERROR",
            "Code must contain URL-safe characters only (a-z, 0-9, -)",
          );
        app.code = `${app.serial}-${normalizeSlug(payload.code)}`;
        app.updatedAt = now();
      }
      if (payload.requirements !== undefined) {
        app.requirements = String(payload.requirements).trim().slice(0, 20000);
        app.updatedAt = now();
      }
      if (payload.description !== undefined) {
        app.description = String(payload.description).trim().slice(0, 4000);
        app.updatedAt = now();
      }
      await save();
      return json(res, 200, publicApp(app));
    }
    const appMatch = url.pathname.match(/^\/api\/apps\/([^/]+)$/);
    if (req.method === "GET" && appMatch) {
      const app = appById(appMatch[1]);
      return app
        ? json(res, 200, publicApp(app))
        : error(res, 404, "NOT_FOUND", "App not found");
    }
    if (req.method === "DELETE" && appMatch) {
      const app = appById(appMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      for (const schedule of store.schedules.filter(
        (item) => item.appId === app.id,
      )) {
        const timer = scheduleTimers.get(schedule.id);
        if (timer) clearTimeout(timer);
        scheduleTimers.delete(schedule.id);
      }
      store.apps = store.apps.filter((item) => item.id !== app.id);
      store.versions = store.versions.filter((item) => item.appId !== app.id);
      store.deployments = store.deployments.filter(
        (item) => item.appId !== app.id,
      );
      store.schedules = store.schedules.filter((item) => item.appId !== app.id);
      store.runs = store.runs.filter((item) => item.appId !== app.id);
      store.modelCalls = store.modelCalls.filter(
        (item) => item.appId !== app.id,
      );
      store.datasources = store.datasources.filter(
        (item) => item.appId !== app.id,
      );
      store.datasourceSnapshots = store.datasourceSnapshots.filter(
        (item) => item.appId !== app.id,
      );
      store.pages = (store.pages || []).filter((item) => item.appId !== app.id);
      await save();
      return json(res, 200, { deleted: app.id });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/runs/")) {
      const runId = url.pathname.split("/").pop();
      if (url.pathname.endsWith("/chain")) {
        const chainRunId = url.pathname.split("/")[3];
        const run = store.runs.find((r) => r.id === chainRunId);
        if (!run) return error(res, 404, "NOT_FOUND", "Run not found");
        const nodes = [];
        const visited = new Set();
        let current = run;
        let depth = 0;
        while (current && !visited.has(current.id) && depth < 5) {
          visited.add(current.id);
          const app = appById(current.appId);
          nodes.push({
            appId: current.appId,
            appName: app?.name || "",
            appCode: app?.code || "",
            runId: current.id,
            status: current.status,
            durationMs: current.durationMs,
            depth,
            trigger: current.trigger,
          });
          if (current.parentRunId) {
            current = store.runs.find((r) => r.id === current.parentRunId);
            depth++;
          } else {
            break;
          }
        }
        nodes.reverse();
        return json(res, 200, { nodes, rootRunId: nodes[0]?.runId });
      }
      if (url.pathname.endsWith("/logs")) {
        const logsRunId = url.pathname.split("/")[3];
        const run = store.runs.find((r) => r.id === logsRunId);
        if (!run) return error(res, 404, "NOT_FOUND", "Run not found");
        return json(res, 200, {
          runId: run.id,
          logs: run.logs || [],
          status: run.status,
          error: run.error || null,
        });
      }
      const run = store.runs.find((r) => r.id === runId);
      return run
        ? json(res, 200, run)
        : error(res, 404, "NOT_FOUND", "Run not found");
    }
    if (req.method === "GET" && url.pathname === "/api/stats") {
      const allRuns = store.runs;
      const byStatus = {};
      for (const r of allRuns) {
        byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      }
      const recent = allRuns.slice(-50).reverse();
      const recentLogs = [];
      for (const r of recent) {
        if (r.logs && r.logs.length) {
          for (const l of r.logs.slice(-5)) {
            recentLogs.push({
              runId: r.id,
              appId: r.appId,
              appName: (appById(r.appId) || {}).name || "",
              versionNumber: r.versionNumber,
              level: l.level,
              message: l.message,
              fields: l.fields,
              at: l.at,
            });
          }
        }
      }
      const perApp = {};
      for (const r of allRuns) {
        const app = appById(r.appId);
        const key = app ? app.name : r.appId;
        if (!perApp[key])
          perApp[key] = {
            total: 0,
            succeeded: 0,
            failed: 0,
            timed_out: 0,
            rejected: 0,
          };
        perApp[key].total++;
        perApp[key][r.status] = (perApp[key][r.status] || 0) + 1;
      }
      // 按版本统计（每个 app 的最近版本成功/失败率，用于版本切换参考）
      const perVersion = {};
      for (const r of allRuns) {
        const app = appById(r.appId);
        const key = `${app?.name || r.appId} / v${r.versionNumber || "?"}`;
        if (!perVersion[key])
          perVersion[key] = {
            appId: r.appId,
            versionNumber: r.versionNumber || 0,
            total: 0,
            succeeded: 0,
            failed: 0,
            timed_out: 0,
          };
        perVersion[key].total++;
        perVersion[key][r.status] = (perVersion[key][r.status] || 0) + 1;
      }
      return json(res, 200, {
        totalRuns: allRuns.length,
        byStatus,
        recentLogs: recentLogs.slice(-100),
        perApp: Object.entries(perApp).map(([name, s]) => ({ name, ...s })),
        perVersion: Object.entries(perVersion)
          .map(([name, s]) => ({
            name,
            ...s,
            successRate:
              s.total > 0 ? Math.round((s.succeeded / s.total) * 100) : 0,
          }))
          .sort((a, b) => b.total - a.total),
        totalApps: store.apps.length,
        totalPublished: store.apps.filter((a) => a.publishedVersionId).length,
      });
    }
    if (req.method === "GET" && (await staticFile(res, url.pathname))) return;
    // ── Pages API ──────────────────────────────────────────────────────
    const pagesListMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/pages$/);
    const pagesItemMatch = url.pathname.match(
      /^\/api\/apps\/([^/]+)\/pages\/([^/]+)$/,
    );
    const pagesDataMatch = url.pathname.match(
      /^\/api\/apps\/([^/]+)\/pages\/([^/]+)\/data$/,
    );
    // GET /api/apps/:id/pages — list pages
    if (req.method === "GET" && pagesListMatch) {
      const app = appById(pagesListMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const appPages = (store.pages || [])
        .filter((p) => p.appId === app.id)
        .map((p) => ({
          id: p.id,
          name: p.name,
          pageConfig: p.pageConfig,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          processScript: p.processScript,
        }));
      return json(res, 200, appPages);
    }
    // POST /api/apps/:id/pages — create page
    if (req.method === "POST" && pagesListMatch) {
      const app = appById(pagesListMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      if (!String(payload.name || "").trim())
        return error(res, 400, "VALIDATION_ERROR", "Page name is required");
      const page = {
        id: id("page"),
        appId: app.id,
        name: String(payload.name).trim().slice(0, 200),
        pageConfig: payload.pageConfig || {
          version: "1.0",
          layout: { type: "grid", config: {} },
          regions: [],
        },
        processScript: String(payload.processScript || ""),
        createdAt: now(),
        updatedAt: now(),
      };
      (store.pages || (store.pages = [])).push(page);
      await save();
      return json(res, 201, page);
    }
    // PUT /api/apps/:id/pages/:pageId — update page
    if (req.method === "PUT" && pagesItemMatch) {
      const app = appById(pagesItemMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const page = (store.pages || []).find(
        (p) => p.id === pagesItemMatch[2] && p.appId === app.id,
      );
      if (!page) return error(res, 404, "NOT_FOUND", "Page not found");
      const payload = await body(req);
      if (payload.name !== undefined)
        page.name = String(payload.name).trim().slice(0, 200);
      if (payload.pageConfig !== undefined)
        page.pageConfig = payload.pageConfig;
      if (payload.processScript !== undefined)
        page.processScript = String(payload.processScript);
      page.updatedAt = now();
      await save();
      return json(res, 200, page);
    }
    // DELETE /api/apps/:id/pages/:pageId — delete page
    if (req.method === "DELETE" && pagesItemMatch) {
      const app = appById(pagesItemMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const idx = (store.pages || []).findIndex(
        (p) => p.id === pagesItemMatch[2] && p.appId === app.id,
      );
      if (idx === -1) return error(res, 404, "NOT_FOUND", "Page not found");
      store.pages.splice(idx, 1);
      await save();
      return json(res, 200, { deleted: pagesItemMatch[2] });
    }
    // POST /api/apps/:id/pages/:pageId/data — execute processScript and return processed data
    if (req.method === "POST" && pagesDataMatch) {
      const app = appById(pagesDataMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const page = (store.pages || []).find(
        (p) => p.id === pagesDataMatch[2] && p.appId === app.id,
      );
      if (!page) return error(res, 404, "NOT_FOUND", "Page not found");
      const payload = await body(req);
      const input = payload || {};
      const ds = datasourceByAppId(app.id);
      const datasource = ds ? JSON.parse(JSON.stringify(ds.data)) : {};
      try {
        let result;
        if (page.processScript && page.processScript.trim()) {
          // Execute the processing script in a sandboxed VM
          const sandbox = {
            input,
            datasource,
            result: null,
            console: { log: (...args) => args },
            JSON,
          };
          const code = `
            (async () => {
              const process = ${page.processScript.trim()};
              result = await process(input, datasource);
            })();
          `;
          const ctx = vm.createContext(sandbox);
          await vm.runInContext(code, ctx, { timeout: 10000 });
          result = sandbox.result;
        } else {
          result = { input, datasource };
        }
        return json(res, 200, { data: result });
      } catch (e) {
        return json(res, 200, {
          data: { error: e.message, input, datasource },
        });
      }
    }
    // GET /api/apps/:code/pages — public: get pages for display by app code
    const publicPagesMatch = url.pathname.match(
      /^\/api\/apps\/code\/([^/]+)\/pages$/,
    );
    if (req.method === "GET" && publicPagesMatch) {
      const app = store.apps.find((a) => a.code === publicPagesMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const appPages = (store.pages || [])
        .filter((p) => p.appId === app.id)
        .map((p) => ({
          id: p.id,
          appId: p.appId,
          name: p.name,
          pageConfig: p.pageConfig,
        }));
      return json(res, 200, appPages);
    }
    // POST /api/ai/generate-page — AI generate page config
    if (req.method === "POST" && url.pathname === "/api/ai/generate-page") {
      const input = await body(req);
      const name = String(input.name || "").trim();
      if (!name)
        return error(res, 400, "VALIDATION_ERROR", "Page name is required");
      try {
        // Build datasource context if appId is provided
        let datasourceContext = null;
        if (input.appId) {
          const ds = datasourceByAppId(input.appId);
          if (ds) {
            const dataKeys = Object.keys(ds.data || {});
            const schemaDesc = ds.schema
              ? `Schema: ${JSON.stringify(ds.schema).slice(0, 500)}`
              : "";
            datasourceContext = dataKeys.length
              ? `Top-level data fields: ${dataKeys.join(", ")}. ${schemaDesc}`
              : "No data populated yet, but a datasource exists. " + schemaDesc;
          } else {
            datasourceContext = "No datasource configured for this app.";
          }
        }
        const result = await deepSeekGeneratePage({
          name,
          appName: String(input.appName || ""),
          appDescription: String(input.appDescription || ""),
          instruction: String(input.description || ""),
          datasourceContext,
        });
        return json(res, 200, result);
      } catch (e) {
        return error(
          res,
          502,
          "MODEL_ERROR",
          `Page generation failed: ${e.message}`,
        );
      }
    }
    // SPA fallback: serve index.html for non-API GET routes
    if (req.method === "GET" && (await staticFile(res, "/"))) return;
    error(res, 404, "NOT_FOUND", "Route not found");
  } catch (err) {
    console.error(err);
    error(
      res,
      err.status || 500,
      "INTERNAL_ERROR",
      err.message || "Unexpected error",
    );
  }
});
server.listen(port, "127.0.0.1", () => {
  armAllSchedules();
  console.log(`Hosta listening on http://127.0.0.1:${port}`);
});
