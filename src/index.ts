import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { store, save } from "./store.js";
import { json, error, body, now } from "./utils.js";
import { staticDir, port as configPort } from "./config.js";
import { registerAppRoutes } from "./routes/apps.js";
import { registerVersionRoutes } from "./routes/versions.js";
import { registerExecutionRoutes } from "./routes/execution.js";
import { registerDatasourceRoutes } from "./routes/datasource.js";
import { registerPageRoutes } from "./routes/pages.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerDeploymentRoutes } from "./routes/deployment.js";
import { registerPublishRoutes, armAllSchedules } from "./routes/publish.js";
import { stopHoya, isHoyaRunning } from "./hoya-client.js";

// ── 静态文件服务 ──────────────────────────────────────────────────────────────

function contentType(file: string): string {
  return file.endsWith(".css")
    ? "text/css; charset=utf-8"
    : file.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : "text/html; charset=utf-8";
}

async function staticFile(
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = resolve(staticDir, requested);
  if (!file.startsWith(`${staticDir}/`) && file !== `${staticDir}/index.html`) {
    return false;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": contentType(file) });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

// ── 路由注册 ──────────────────────────────────────────────────────────────────

const routeRegistrars = [
  registerAdminRoutes,
  registerStatsRoutes,
  registerAppRoutes,
  registerVersionRoutes,
  registerExecutionRoutes,
  registerDatasourceRoutes,
  registerPageRoutes,
  registerDeploymentRoutes,
  registerPublishRoutes,
];

// ── 服务器 ────────────────────────────────────────────────────────────────────

const server = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );
    const method = req.method!;

    try {
      // ── 特殊路由 ──────────────────────────────────────────────────────

      // /llms.txt — LLM 上下文描述
      if (method === "GET" && url.pathname === "/llms.txt") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(`# Hosta API

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

## Schedules
- GET /api/apps/:id/schedules lists all schedules for an app.
- POST /api/apps/:id/schedules creates a schedule. body: {scheduleType: "interval"|"daily"|"cron", versionId?, input?, intervalSeconds?, dailyAt?, cronExpression?}. interval: min 600s (10min), max 86400s. daily: dailyAt in HH:mm format (e.g. 08:30). cron: standard 5-field cron expression (e.g. "0 * * * *" for every hour).
- DELETE /api/schedules/:id disables a schedule.

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
        return;
      }

      // /health
      if (method === "GET" && url.pathname === "/health") {
        json(res, 200, {
          status: "healthy",
          service: "hosta",
          generator: process.env.DEEPSEEK_API_KEY ? "deepseek" : "local-demo",
        });
        return;
      }

      // POST /api/sample-input
      if (method === "POST" && url.pathname === "/api/sample-input") {
        (async () => {
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
          const { deepSeekSample } = await import("./llm.js");
          json(res, 200, await deepSeekSample({ description, runtime }));
        })().catch((e) =>
          error(
            res,
            502,
            "MODEL_ERROR",
            `Sample generation failed: ${e.message}`,
          ),
        );
        return;
      }

      // POST /api/format
      if (method === "POST" && url.pathname === "/api/format") {
        (async () => {
          const input = await body(req);
          const code = String(input.code || "");
          if (!code)
            return error(
              res,
              400,
              "VALIDATION_ERROR",
              "Code is required to format",
            );
          const runtime = input.runtime === "wasm" ? "wasm" : "javascript";
          const language =
            runtime === "wasm" && input.language === "moonbit"
              ? "moonbit"
              : runtime === "wasm"
                ? "rust"
                : "javascript";
          const { formatCode } = await import("./compiler.js");
          try {
            json(res, 200, await formatCode({ code, runtime, language }));
          } catch (e: any) {
            error(res, 400, "FORMAT_ERROR", e.message);
          }
        })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
        return;
      }

      // ── 模块化路由 ────────────────────────────────────────────────────
      for (const register of routeRegistrars) {
        if (register(req, res, url)) return;
      }

      // ── 静态文件 ──────────────────────────────────────────────────────
      if (method === "GET" && (await staticFile(res, url.pathname))) return;

      // SPA fallback
      if (method === "GET" && (await staticFile(res, "/"))) return;

      // 404
      error(res, 404, "NOT_FOUND", "Route not found");
    } catch (err: any) {
      console.error(err);
      error(
        res,
        err.status || 500,
        "INTERNAL_ERROR",
        err.message || "Unexpected error",
      );
    }
  },
);

// ── 启动 ──────────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT) || configPort;
server.listen(port, "127.0.0.1", () => {
  armAllSchedules();
  console.log(`Hosta listening on http://127.0.0.1:${port}`);
});

// ── 优雅退出 — 确保 hoya sidecar 子进程不会变成孤儿进程 ──────────────────────────

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Hosta received ${signal}, shutting down...`);
  if (isHoyaRunning()) {
    await stopHoya().catch((err) => console.error("Error stopping hoya:", err));
  }
  server.close(() => process.exit(0));
  // Force exit if server.close() hangs (e.g. keep-alive connections)
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
