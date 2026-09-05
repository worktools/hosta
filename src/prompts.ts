// ── Rust WASM Starter Template ────────────────────────────────────────────────
export const rustStarter = `#![no_std]
#![no_main]

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn get_input(ptr: *mut u8, capacity: u32) -> u32;
}
static mut OUTPUT: [u8; 1048577] = [0; 1048577];
#[unsafe(no_mangle)]
pub extern "C" fn hoya_main() -> i32 {
    unsafe {
        let ptr = core::ptr::addr_of_mut!(OUTPUT).cast::<u8>();
        let len = get_input(ptr, 1048576);
        *ptr.add(len as usize) = 0;
        ptr as i32
    }
}
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { loop {} }
`;

// ── MoonBit Starter Template ──────────────────────────────────────────────────
export const moonStarter = `// MoonBit starter for Hosta WASM
// Compile: moon build --target wasm --release
//
// Experimental: adapt build exports to memory and hoya_main() -> i32.
// This scaffold is not a validated v1 module.
//          Returns pointer to JSON envelope string

pub fn run() -> Int {
  // TODO: implement your logic
  0
}
`;

// ── LLM Prompt 模板配置 ────────────────────────────────────────────────────────

export const PROMPTS = {
  /** 代码生成 prompt */
  generate: ({
    description,
    sampleInput,
    requirements,
    datasourceSchema,
  }: {
    description: string;
    sampleInput: unknown;
    requirements?: string;
    datasourceSchema?: unknown;
  }) =>
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
  refine: ({
    app,
    version,
    instruction,
    datasourceSchema,
  }: {
    app: { name: string; requirements?: string; description?: string };
    version?: { code?: string; tests?: unknown[] };
    instruction: string;
    datasourceSchema?: unknown;
  }) =>
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

  /** 需求文档生成/优化 prompt */
  refineRequirements: ({
    requirements,
    instruction,
    appName,
    appDescription,
  }: {
    requirements: string;
    instruction: string;
    appName: string;
    appDescription: string;
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
  sampleInput: ({
    description,
    runtime,
  }: {
    description: string;
    runtime: string;
  }) =>
    `You generate a realistic JSON sample input for a small automation program. Return JSON only with the key "input", whose value is the sample object the program would receive at runtime. Program description: ${description}\nRuntime: ${runtime}\nReturn only: {"input": { ... }}`,

  /** 测试用例生成 prompt */
  generateTests: ({
    app,
    version,
    existingTests,
  }: {
    app: { name: string; description?: string };
    version: { runtime?: string; language?: string; inputSchema?: unknown };
    existingTests: unknown[];
  }) =>
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
  }: {
    appName: string;
    appDescription: string;
    requirements: string;
    code: string;
    tests: unknown[];
    existingSchemas: { inputSchema?: unknown; outputSchema?: unknown };
    target: string;
    instruction: string;
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
  revise: ({
    version,
    errorSummary,
    hint,
  }: {
    version: { code: string; tests?: unknown[] };
    errorSummary: string;
    hint: string;
  }) =>
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
  }: {
    name: string;
    appName: string;
    appDescription: string;
    instruction: string;
    datasourceContext: string | null;
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
