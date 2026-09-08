import {
  createHash,
  randomUUID,
  randomBytes as cryptoRandomBytes,
} from "node:crypto";
import type { ServerResponse, IncomingMessage } from "node:http";
import type {
  Store,
  App,
  Version,
  Deployment,
  Datasource,
  ExternalDatasource,
  DatasourceSnapshot,
  InvokeDocs,
  PublicApp,
  Schedule,
} from "./types.js";
import { store } from "./store.js";
import { now } from "./config.js";
export { now };

// ── ID 生成 ──────────────────────────────────────────────────────────────────

/** 生成带前缀的短 ID */
export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/** SHA-256 哈希 */
export function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ── HTTP 响应 ────────────────────────────────────────────────────────────────

/** 发送 JSON 响应 */
export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/** 发送错误响应 */
export function error(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  json(res, status, { error: { code, message } });
}

// ── 请求解析 ─────────────────────────────────────────────────────────────────

/** 解析请求体为 JSON，限制 2 MiB */
export async function body(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (Object.hasOwn(req, "parsedBody")) return (req as IncomingMessage & { parsedBody: Record<string, unknown> }).parsedBody;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += (chunk as Buffer).length;
    if (size > 2_097_152) {
      const err = new Error("Request body exceeds 2 MiB");
      (err as any).status = 413;
      throw err;
    }
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const err = new Error("Body must be valid JSON");
    (err as any).status = 400;
    throw err;
  }
}

function tryParseScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}

/** 从 GET/POST 请求中提取输入 */
export async function inputFromRequest(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (req.method === "POST") return await body(req);
  const urlStr = req.url || "/";
  const query = new URL(urlStr, "http://localhost").searchParams;
  const inputRaw = query.get("input");
  if (inputRaw !== null) {
    try {
      return JSON.parse(inputRaw);
    } catch {
      return { input: inputRaw };
    }
  }
  const input: Record<string, unknown> = {};
  for (const [key, value] of query) {
    if (key === "key" || key === "api_key") continue;
    input[key] = tryParseScalar(value);
  }
  return input;
}

// ── Store 查询 ────────────────────────────────────────────────────────────────

export function appById(appId: string): App | undefined {
  return store.apps.find((item) => item.id === appId);
}

export function appByCode(code: string): App | undefined {
  return store.apps.find((item) => item.code === code);
}

export function datasourceByAppId(appId: string): Datasource | undefined {
  return store.datasources.find((item) => item.appId === appId);
}

export function externalDatasourcesByAppId(
  appId: string,
): ExternalDatasource[] {
  return store.externalDatasources.filter((item) => item.appId === appId);
}

export function datasourceSnapshotById(
  id: string,
): DatasourceSnapshot | undefined {
  return store.datasourceSnapshots.find((item) => item.id === id);
}

export function versionById(versionId: string): Version | undefined {
  return store.versions.find((item) => item.id === versionId);
}

export function deploymentById(deploymentId: string): Deployment | undefined {
  return store.deployments.find((item) => item.id === deploymentId);
}

export function scheduleById(scheduleId: string): Schedule | undefined {
  return store.schedules.find((item) => item.id === scheduleId);
}

// ── Slug & Code 生成 ─────────────────────────────────────────────────────────

export function normalizeSlug(value: string): string {
  return (
    String(value || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36) || "app"
  );
}

export function appCode(name: string, serial: number): string {
  return `${serial}-${normalizeSlug(name)}`;
}

// ── 推断 ──────────────────────────────────────────────────────────────────────

/** 从测试用例推断字段 schema */
export function inferSchemaFromTests(
  tests: Array<Record<string, unknown>>,
  field: string,
): Record<string, unknown> | null {
  if (!tests || !tests.length) return null;
  const props: Record<
    string,
    { type: string; examples: unknown[]; optional: boolean }
  > = {};
  for (const test of tests) {
    const obj = test[field] as Record<string, unknown> | undefined;
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
      (t) =>
        t[field] &&
        typeof t[field] === "object" &&
        key in (t[field] as Record<string, unknown>),
    ).length;
    info.optional = count < total;
  }
  return { type: "object", properties: props, totalTests: total };
}

/** 推断应用能力标签 */
export function inferCapabilities(version: {
  code?: string;
  runtime?: string;
}): string[] {
  const caps: string[] = [];
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

// ── Invoke Docs ──────────────────────────────────────────────────────────────

export function invokeDocsFor(
  app: App,
  deployment: Deployment | undefined,
  origin: string,
): InvokeDocs {
  const sample = app.sampleInput ?? {};
  const path = `/invoke/${app.code}`;
  const full = `${origin}${path}`;
  const inputJson = JSON.stringify(sample);
  const browser = `${full}?key=<YOUR_KEY>&input=${encodeURIComponent(inputJson)}`;
  const publishedVersion = deployment
    ? versionById(deployment.versionId)
    : undefined;
  const pinnedPath = publishedVersion
    ? `/invoke-version/${app.code}/${publishedVersion.number}`
    : null;
  const pinnedFull = pinnedPath ? `${origin}${pinnedPath}` : null;
  return {
    path,
    full,
    get: deployment
      ? {
          description: "GET 请求，输入通过 query 参数传递。",
          url: full,
          pinnedUrl: pinnedFull || null,
          parameters: {
            key: "部署密钥",
            input: "JSON 格式的输入参数",
          },
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

// ── PublicApp Builder ─────────────────────────────────────────────────────────

export function publicApp(app: App): PublicApp {
  const draft = app.draftVersionId ? versionById(app.draftVersionId) : null;
  const published = app.publishedVersionId
    ? versionById(app.publishedVersionId)
    : null;
  const versions = store.versions
    .filter((v) => v.appId === app.id)
    .sort((a, b) => b.number - a.number);
  const ds = datasourceByAppId(app.id);
  const extDs = externalDatasourcesByAppId(app.id);
  const dsObj = ds
    ? { data: ds.data, schema: ds.schema || null, updatedAt: ds.updatedAt }
    : { data: {}, schema: null, updatedAt: null };
  return {
    ...app,
    draftVersion: draft ?? null,
    publishedVersion: published ?? null,
    versions,
    datasource: dsObj,
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
    deployments: store.deployments.filter((d) => d.appId === app.id).map(({ keyHash, ...d }) => d),
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
        appId: p.appId,
        name: p.name,
        pageConfig: p.pageConfig,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        processScript: p.processScript,
      })),
  };
}

// ── 安全 JSON ────────────────────────────────────────────────────────────────

export function safeJson(value: unknown): unknown {
  JSON.stringify(value);
  return value;
}

// ── 随机字节 ──────────────────────────────────────────────────────────────────

export function randomBytes(size: number): Buffer {
  return cryptoRandomBytes(size);
}

// ── 示例代码 ──────────────────────────────────────────────────────────────────

export function sampleCode(description = ""): string {
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

export const sampleWasm =
  "AGFzbQEAAAABBQFgAAF/AwIBAAcIAQRtYWluAAAKBgEEAEEqCw==";

/** Preserve parser errors in handlers that must select a deployment before reading input. */
export function requestError(res: ServerResponse, cause: {status?: number; message?: string}): void {
  const status = cause.status;
  error(res, status === 413 ? 413 : status === 400 ? 400 : 500,
    status === 413 ? "PAYLOAD_TOO_LARGE" : status === 400 ? "INVALID_JSON" : "INTERNAL_ERROR",
    status === 413 ? "Request body exceeds 2 MiB" : status === 400 ? "Body must be valid JSON" : "Unexpected request failure");
}
