import type {
  LLMResult,
  LLMSampleResult,
  LLMRefineResult,
  LLMRefineRequirementsResult,
  LLMGeneratePageResult,
  LLMGenerateSchemaResult,
  Version,
  App,
  TestCase,
} from "./types.js";
import { PROMPTS, rustStarter, moonStarter } from "./prompts.js";
import { compileWasm } from "./compiler.js";
import { store } from "./store.js";
import { sampleCode, sha, id } from "./utils.js";
import { diagnosticsFor } from "./validator.js";
import { execute } from "./executor.js";

// ── LLM API 调用辅助 ──────────────────────────────────────────────────────────

function getApiConfig() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const base = (
    process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
  ).replace(/\/$/, "");
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  return { apiKey, base, model };
}

async function callDeepSeek(
  prompt: string,
  temperature: number,
  maxTokens: number,
  timeout = 60000,
) {
  const { apiKey, base, model } = getApiConfig();
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not configured");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok)
    throw new Error(`DeepSeek returned HTTP ${response.status}`);
  const payload: any = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned no content");
  const cleaned = content.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned);
  return { parsed, usage: payload.usage ?? null, model };
}

function cleanJsonContent(content: string): string {
  return content
    .replace(/^```json\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

// ── LLM 功能函数 ───────────────────────────────────────────────────────────────

export async function deepSeekGenerate({
  description,
  sampleInput,
  requirements,
  runtime = "javascript",
  datasourceSchema = null,
}: {
  description: string;
  sampleInput?: unknown;
  requirements?: string;
  runtime?: string;
  datasourceSchema?: unknown;
}): Promise<LLMResult> {
  const { apiKey } = getApiConfig();
  if (runtime === "wasm")
    return {
      source: "local-demo",
      summary:
        "WASM 示例已生成。编辑区保存 Rust 或 MoonBit 源码，发布前会由系统编译。",
      code: null,
      tests: [
        {
          name: "默认测试",
          input: (sampleInput ?? {}) as Record<string, unknown>,
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
          input: (sampleInput ?? {}) as Record<string, unknown>,
          expectedOutput: undefined,
        },
      ],
      usage: null,
      model: null,
    };
  const prompt = PROMPTS.generate({
    description,
    sampleInput: sampleInput ?? {},
    requirements,
    datasourceSchema,
  });
  const {
    parsed: generated,
    usage,
    model,
  } = await callDeepSeek(prompt, 0.2, 1200);
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
        ? generated.tests.slice(0, 3).map((t: any) => ({
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
              input: sampleInput ?? ({} as Record<string, unknown>),
              expectedOutput: undefined,
            },
          ],
    usage,
    model,
  };
}

export async function deepSeekSample({
  description,
  runtime = "javascript",
}: {
  description: string;
  runtime?: string;
}): Promise<LLMSampleResult> {
  const { apiKey } = getApiConfig();
  if (!apiKey)
    return { source: "local-demo", model: null, input: { value: 1 } };
  const prompt = PROMPTS.sampleInput({ description, runtime });
  const { parsed, model } = await callDeepSeek(prompt, 0.4, 500);
  const input = parsed?.input ?? parsed;
  if (!input || typeof input !== "object")
    throw new Error("DeepSeek response does not contain a sample input object");
  return { source: "deepseek", model, input };
}

export async function deepSeekRefine({
  app,
  version,
  instruction,
  datasourceSchema = null,
}: {
  app: App;
  version: Version;
  instruction: string;
  datasourceSchema?: unknown;
}): Promise<LLMRefineResult> {
  const prompt = PROMPTS.refine({
    app,
    version,
    instruction,
    datasourceSchema,
  });
  const {
    parsed: generated,
    usage,
    model,
  } = await callDeepSeek(prompt, 0.2, 2000);
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
        ? generated.tests.slice(0, 5).map((t: any) => ({
            name: String(t.name || "测试").slice(0, 200),
            input: t.input && typeof t.input === "object" ? t.input : {},
            expectedOutput:
              t.expectedOutput && typeof t.expectedOutput === "object"
                ? t.expectedOutput
                : undefined,
          }))
        : [],
    usage,
    model,
  };
}

export async function deepSeekRefineRequirements({
  requirements,
  instruction,
  appName,
  appDescription,
}: {
  requirements: string;
  instruction: string;
  appName: string;
  appDescription: string;
}): Promise<LLMRefineRequirementsResult> {
  const prompt = PROMPTS.refineRequirements({
    requirements,
    instruction,
    appName,
    appDescription,
  });
  const {
    parsed: generated,
    usage,
    model,
  } = await callDeepSeek(prompt, 0.7, 4000);
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
    usage,
    model,
  };
}

export async function deepSeekGeneratePage({
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
}): Promise<LLMGeneratePageResult> {
  const prompt = PROMPTS.generatePage({
    name,
    appName,
    appDescription,
    instruction,
    datasourceContext,
  });
  const { parsed: generated } = await callDeepSeek(prompt, 0.3, 4000);
  if (!generated.pageConfig || typeof generated.pageConfig !== "object")
    throw new Error("DeepSeek response missing pageConfig");
  return { pageConfig: generated.pageConfig };
}

export async function deepSeekGenerateTests({
  app,
  version,
}: {
  app: App;
  version: Version;
}): Promise<TestCase[]> {
  const existingTests = (version.tests || []).map((t) => ({
    name: t.name,
    input: t.input,
    expectedOutput: t.expectedOutput,
  }));
  const prompt = PROMPTS.generateTests({ app, version, existingTests });
  const { parsed: generated } = await callDeepSeek(prompt, 0.3, 1500);
  if (!Array.isArray(generated.tests))
    throw new Error("DeepSeek response missing tests array");
  return generated.tests.map((t: any) => ({
    name: String(t.name || "Generated test").slice(0, 200),
    input: t.input && typeof t.input === "object" ? t.input : {},
    expectedOutput:
      t.expectedOutput && typeof t.expectedOutput === "object"
        ? t.expectedOutput
        : undefined,
  }));
}

export async function deepSeekGenerateSchema({
  app,
  version,
  target,
  instruction,
}: {
  app: App;
  version: Version;
  target: string;
  instruction: string;
}): Promise<LLMGenerateSchemaResult> {
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
  const { parsed: generated } = await callDeepSeek(prompt, 0.3, 2000);
  if (!generated.schema || typeof generated.schema !== "object")
    throw new Error("DeepSeek response missing schema");
  return { schema: generated.schema };
}

export async function deepSeekRevise({
  app,
  version,
  prevResult,
  hint,
}: {
  app: App;
  version: Version;
  prevResult: {
    testResults: Array<{
      name: string;
      input: unknown;
      expectedOutput: unknown;
      actualStatus: string;
      error?: { message?: string };
    }>;
  };
  hint: string;
}): Promise<LLMRefineResult> {
  const errors =
    prevResult.testResults?.filter((r) => r.actualStatus !== "succeeded") || [];
  const errorSummary = errors
    .map(
      (e) =>
        `Test "${e.name || "unnamed"}": input=${JSON.stringify(e.input ?? {})}, expected=${JSON.stringify(e.expectedOutput ?? null)}, actual=${e.actualStatus}, error=${JSON.stringify(e.error?.message || "none")}`,
    )
    .join("\n");
  const prompt = PROMPTS.revise({ version, errorSummary, hint });
  const {
    parsed: generated,
    usage,
    model,
  } = await callDeepSeek(prompt, 0.2, 1500, 60000);
  if (typeof generated.code !== "string")
    throw new Error("DeepSeek response missing code");
  return {
    source: "deepseek-revise",
    summary: generated.summary || "LLM 修订版本",
    code: generated.code,
    tests:
      Array.isArray(generated.tests) && generated.tests.length
        ? generated.tests.slice(0, 3).map((t: any) => ({
            name: String(t.name || "修订测试").slice(0, 200),
            input: t.input && typeof t.input === "object" ? t.input : {},
            expectedOutput:
              t.expectedOutput && typeof t.expectedOutput === "object"
                ? t.expectedOutput
                : undefined,
          }))
        : version.tests || [],
    usage,
    model,
  };
}

// ── 生成端点辅助函数 ───────────────────────────────────────────────────────────

export async function generateVersion(app: App) {
  const runtime = app.runtime || "javascript";
  const language = app.language || "javascript";
  const generated = await deepSeekGenerate({
    description: app.description,
    sampleInput: app.sampleInput,
    requirements: app.requirements,
    runtime,
    datasourceSchema:
      (store.datasources.find((d) => d.appId === app.id) || {}).schema || null,
  });
  const sourceCode =
    runtime === "wasm"
      ? language === "moonbit"
        ? moonStarter
        : rustStarter
      : generated.code;
  const compiled =
    runtime === "wasm"
      ? await compileWasm(language, sourceCode!)
      : { binary: generated.code!, size: Buffer.byteLength(generated.code!) };
  const { validateCode } = await import("./validator.js");
  const problem = validateCode(compiled.binary, runtime);
  const version: Version = {
    id: id("ver"),
    appId: app.id,
    runtime,
    language,
    sourceCode: runtime === "wasm" ? (sourceCode ?? undefined) : undefined,
    wasmSize: runtime === "wasm" ? compiled.size : undefined,
    number: store.versions.filter((v) => v.appId === app.id).length + 1,
    status: problem ? "needs_revision" : "ready",
    source: generated.source,
    summary: generated.summary,
    code: compiled.binary,
    codeSha256: sha(compiled.binary),
    inputSchema: null,
    outputSchema: null,
    tests: generated.tests,
    validationError: problem || null,
    createdAt: new Date().toISOString(),
  };
  store.versions.push(version);
  app.draftVersionId = version.id;
  app.updatedAt = new Date().toISOString();
  store.modelCalls.push({
    id: id("model"),
    appId: app.id,
    versionId: version.id,
    provider: generated.source,
    model: generated.model,
    usage: generated.usage as Record<string, unknown> | null,
    estimatedCost: null,
    createdAt: new Date().toISOString(),
  });
  return version;
}
