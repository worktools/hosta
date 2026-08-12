import vm from "node:vm";
import {
  buildWasmImports,
  readWasmStr,
  parseWasmEnvelope,
} from "./wasm-bridge.js";
import { validateCode, validateJsonSchema } from "./validator.js";
import { store, save } from "./store.js";
import {
  datasourceByAppId,
  appByCode,
  versionById,
  id,
  safeJson,
  now,
} from "./utils.js";
import type { Version, Run, ExecuteOptions } from "./types.js";

// ── hoya 沙箱执行引擎集成 ─────────────────────────────────────────────────────

/**
 * 是否使用 hoya 执行 JS 代码（替代 vm.createContext）。
 * 设置为 true 时，JS 执行走 hoya 的 rquickjs 引擎（② 级沙箱），
 * 而非 Node.js 的 vm.createContext（① 级）。
 *
 * 环境变量：HOYA_ENABLED=true（启动时读取）
 * 二进制路径：HOYA_BINARY（默认 "hoya"）
 * 端口：HOYA_PORT（默认 4300）
 *
 * 运行时可通过 getHoyaEnabled() / setHoyaEnabled() 查询和切换。
 */
let hoyaEnabled = process.env.HOYA_ENABLED === "true";

/** 查询当前沙箱级别 */
export function getHoyaEnabled(): boolean {
  return hoyaEnabled;
}

/** 运行时切换沙箱级别（不持久化，重启后失效） */
export function setHoyaEnabled(value: boolean): void {
  hoyaEnabled = value;
  if (!value) {
    // 关闭 hoya 时停止子进程以释放资源
    import("./hoya-client.js").then((c) => c.stopHoya?.()).catch(() => {});
  }
}
let hoyaClient: typeof import("./hoya-client.js") | null = null;
let hoyaStartPromise: Promise<typeof import("./hoya-client.js")> | null = null;

async function ensureHoyaClient() {
  if (hoyaClient) return hoyaClient;
  // Guard against concurrent callers each spawning their own hoya process:
  // the first caller creates the start promise, everyone else awaits it.
  if (!hoyaStartPromise) {
    hoyaStartPromise = (async () => {
      const client = await import("./hoya-client.js");
      await client.startHoya({
        binaryPath: process.env.HOYA_BINARY || "hoya",
        port: Number(process.env.HOYA_PORT) || 4300,
      });
      hoyaClient = client;
      return client;
    })().catch((err) => {
      hoyaStartPromise = null; // allow retry on next call
      throw err;
    });
  }
  return hoyaStartPromise;
}

/**
 * 通过 hoya 沙箱执行 JavaScript 代码。
 * 兼容 Hosta 的 `main(input, ctx)` 约定。
 */
async function executeWithHoya(
  code: string,
  input: Record<string, unknown>,
  datasource: Record<string, unknown>,
  logs: Array<{ level: string; message: string; at: string }>,
  _options: ExecuteOptions,
): Promise<{
  status: string;
  result?: unknown;
  error?: { code: string; message: string };
}> {
  const client = await ensureHoyaClient();
  const response = await client.executeJs({
    code,
    input,
    datasource,
  });

  // 转换 hoya 响应为 Hosta 格式
  if (response.status === "success") {
    // 解析 output 中的 JSON 结果
    let result: unknown;
    if (response.output) {
      try {
        const parsed = JSON.parse(response.output);
        // 兼容 __result 包装
        result = parsed.__result !== undefined ? parsed.__result : parsed;
      } catch {
        result = response.output;
      }
    } else {
      result = null;
    }

    // 将 hoya 的 stdout 日志合并到 Hosta 的日志格式
    if (response.stdout) {
      for (const line of response.stdout.split("\n").filter(Boolean)) {
        if (logs.length < 100) {
          logs.push({
            level: "info",
            message: line.slice(0, 2000),
            at: now(),
          });
        }
      }
    }

    return { status: "succeeded", result };
  } else {
    const message = response.error?.message || "Unknown hoya execution error";
    return {
      status: "failed",
      error: {
        code: response.error?.code || "HOYA_EXECUTION_ERROR",
        message,
      },
    };
  }
}

/**
 * 通过 hoya 沙箱执行 WebAssembly 代码。
 * 使用 wasmtime 引擎（③ 级），带 fuel/内存限额。
 */
async function executeWasmWithHoya(
  code: string,
  input: Record<string, unknown>,
  datasource: Record<string, unknown>,
  _logs: Array<{ level: string; message: string; at: string }>,
): Promise<{
  status: string;
  result?: unknown;
  error?: { code: string; message: string };
}> {
  const client = await ensureHoyaClient();
  const response = await client.executeWasm({
    code, // base64 编码的 WASM 二进制
    input_json: JSON.stringify(input),
    datasource_json: JSON.stringify(datasource),
  });

  if (response.status === "success") {
    return {
      status: "succeeded",
      result: { runtime: "wasm", output: response.output },
    };
  } else {
    return {
      status: "failed",
      error: {
        code: response.error?.code || "HOYA_WASM_ERROR",
        message: response.error?.message || "Unknown WASM execution error",
      },
    };
  }
}

// ── 执行器 ──────────────────────────────────────────────────────────────────────

/**
 * 执行一个版本的代码，创建运行记录并返回结果。
 */
export async function execute(
  version: Version,
  input: Record<string, unknown>,
  trigger: string,
  options: ExecuteOptions = {},
): Promise<Run> {
  const ds = datasourceByAppId(version.appId);
  const latestSnapshot = ds
    ? store.datasourceSnapshots
        .filter((s) => s.appId === version.appId && s.status === "applied")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] || null
    : null;
  const run: Run = {
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
      (version.inputSchema as any).type
    ) {
      const schemaErrors = validateJsonSchema(
        version.inputSchema as Record<string, unknown>,
        input,
      );
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

    const logs: Array<{ level: string; message: string; at: string }> = [];
    if (runtime === "wasm") {
      if (hoyaEnabled) {
        // 使用 hoya 沙箱（wasmtime 引擎，③ 级，带 fuel/内存限额）
        const datasourceData = ds ? JSON.parse(JSON.stringify(ds.data)) : {};
        const hoyaResult = await executeWasmWithHoya(
          version.code,
          input,
          datasourceData,
          logs as any,
        );
        if (hoyaResult.status === "succeeded") {
          run.status = "succeeded";
          run.result = hoyaResult.result;
        } else {
          run.status = "failed";
          run.error = hoyaResult.error;
        }
        run.logs = logs as any;
        return run;
      }

      // 回退：使用 Node.js JSPI 执行
      const { imports, bind } = buildWasmImports(logs, input, ds);
      const module = await WebAssembly.instantiate(
        Buffer.from(version.code, "base64"),
        imports,
      );
      const mem = (module.instance.exports as any).memory;
      const al = (module.instance.exports as any).alloc;
      const fn = (module.instance.exports as any).main;
      if (typeof fn !== "function")
        throw new Error("WASM module must export a main function");
      if (mem) bind(mem, al);

      const wrappedFn = (WebAssembly as any).promising(fn);
      const resultPtr = await Promise.race([
        wrappedFn(),
        new Promise<number>((_, reject) =>
          setTimeout(
            () => reject(new Error("Execution exceeded 3000 ms")),
            3000,
          ),
        ),
      ]);
      const resultStr = readWasmStr(mem, resultPtr);
      const envelope = parseWasmEnvelope(resultStr);

      if (envelope.ok === true) {
        run.status = "succeeded";
        run.result = { value: envelope.data, runtime: "wasm" };
      } else {
        run.status = "failed";
        run.error = {
          code: envelope?.error?.code || "WASM_ERROR",
          message: envelope?.error?.message || "Unknown WASM error",
        };
      }
      run.logs = logs as any;
      return run;
    }

    // JavaScript 执行
    if (hoyaEnabled) {
      // 使用 hoya 沙箱（rquickjs 引擎，② 级）
      const datasourceData = ds ? JSON.parse(JSON.stringify(ds.data)) : {};
      const hoyaResult = await executeWithHoya(
        version.code,
        input,
        datasourceData,
        logs as any,
        options,
      );
      if (hoyaResult.status === "succeeded") {
        run.status = "succeeded";
        run.result = safeJson(hoyaResult.result);
      } else {
        run.status = "failed";
        run.error = hoyaResult.error;
      }
      run.logs = logs as any;
    } else {
      // 使用 vm.createContext（① 级，回退方案）
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
        setTimeout: undefined as any,
        console: undefined as any,
      });
      vm.runInContext(
        `"use strict"; ${version.code}; globalThis.__hostaMain = main;`,
        context,
        { timeout: 1000 },
      );
      const fn = context.__hostaMain as Function;

      const ctx = {
        datasource: ds ? JSON.parse(JSON.stringify(ds.data)) : {},
        log(level: string, message: string, fields?: Record<string, unknown>) {
          if ((logs as any[]).length < 100)
            (logs as any[]).push({
              level: ["debug", "info", "warn", "error"].includes(level)
                ? level
                : "info",
              message: String(message).slice(0, 2000),
              fields: fields ?? null,
              at: now(),
            });
        },
        now: () => Date.now(),
        call: async (
          appCode: string,
          callInput: Record<string, unknown>,
          callOptions: Record<string, unknown> = {},
        ) => {
          const depth = (options.callDepth || 0) + 1;
          if (depth > 3)
            throw new Error("Inter-app call depth exceeded (max 3)");
          const target = appByCode(appCode);
          if (!target) throw new Error(`App not found: ${appCode}`);
          const deployment = store.deployments.find(
            (d) => d.appId === target.id && d.status === "active",
          );
          if (!deployment) throw new Error(`App not published: ${appCode}`);
          const targetVersion = versionById(deployment.versionId);
          if (!targetVersion)
            throw new Error(`Version not found for app: ${appCode}`);
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
        fetch: async (
          url: string,
          fetchOptions: Record<string, unknown> = {},
        ) => {
          const method = (
            (fetchOptions.method as string) || "GET"
          ).toUpperCase();
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
              headers: (fetchOptions.headers as Record<string, string>) || {},
              signal: ctrl.signal,
              redirect: "follow",
            } as any);
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
          setTimeout(
            () => reject(new Error("Execution exceeded 3000 ms")),
            3000,
          ),
        ),
      ]);
      const encoded = JSON.stringify(result);
      if (encoded.length > 1_048_576) throw new Error("Result exceeds 1 MiB");
      run.status = "succeeded";
      run.result = safeJson(result);
      run.logs = logs as any;
    }
  } catch (err: any) {
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

// ── 数据迁移 ──────────────────────────────────────────────────────────────────

/**
 * 在沙箱中执行数据迁移脚本。
 */
export async function runMigration(
  app: { id: string },
  migrationScript: string,
): Promise<{
  success: boolean;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  logs: string[];
  error?: string;
}> {
  const vm = await import("node:vm");
  const ds = datasourceByAppId(app.id);
  const currentData = ds ? ds.data : {};
  const logs: string[] = [];
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
      log: (...args: unknown[]) => {
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
    const migrated = JSON.parse(JSON.stringify((context as any).data));
    if (
      typeof migrated !== "object" ||
      migrated === null ||
      Array.isArray(migrated)
    )
      throw new Error("Migration must produce a plain object");
    return { success: true, before: currentData, after: migrated, logs };
  } catch (err: any) {
    return {
      success: false,
      before: currentData,
      after: currentData,
      error: String(err.message).slice(0, 2000),
      logs,
    };
  }
}
