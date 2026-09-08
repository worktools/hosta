import { createServer } from "node:http";
import { engineStatus } from "../lib/hoya-client.mjs";
import { withIdempotency } from "./idempotency.js";
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

const dispatch = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );
    const method = req.method!;

    if (url.pathname.startsWith('/api/') && process.env.HOSTA_API_TOKEN && req.headers.authorization !== `Bearer ${process.env.HOSTA_API_TOKEN}`) return error(res,401,'UNAUTHORIZED','A valid management API token is required');
    try {
      if (method === 'GET' && url.pathname === '/api/status') return json(res,200,{service:'hosta',engine:await engineStatus(),generator:process.env.DEEPSEEK_API_KEY?'deepseek':'local-demo',localCompilerEnabled:process.env.HOSTA_ENABLE_LOCAL_COMPILER==='1'});
      if (method === 'GET' && url.pathname === '/api/runs') {
        const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||20);
        if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)return error(res,400,'VALIDATION_ERROR','Invalid pagination');
        const items=store.runs.filter(r=>['appId','versionId','status','trigger'].every(k=>!url.searchParams.has(k)||(r as unknown as Record<string,unknown>)[k]===url.searchParams.get(k))).slice().reverse();
        return json(res,200,{items:items.slice(offset,offset+limit),nextOffset:offset+limit<items.length?offset+limit:null});
      }
      // ── 特殊路由 ──────────────────────────────────────────────────────

      // /llms.txt — LLM 上下文描述
      if (method === "GET" && url.pathname === "/llms.txt") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(`# Hosta API

Hosta creates and hosts short JavaScript or WebAssembly functions.

Current execution: independent Hoya v1 only. Use node bin/hosta.mjs --help.
POST /api/runs/:id/retry with {"confirm":true} creates a new execution of the original version/input; retryOf links its source. GET /api/runs accepts trigger filtering.
GET /api/status reports actual readiness. POST /api/apps/:id/versions accepts UTF-8 JS or base64 WASM with encoding=base64; WASM exports memory and hoya_main().
No Node fallback, ctx.fetch, ctx.call or async host I/O are available in v1. Rebuild legacy WASM artifacts. Local source compilation is opt-in for trusted code.
The legacy APIs below remain for metadata compatibility; runtime contracts follow v1.

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
- POST /api/apps/:id/pages/:pageId/data — execute the page's processScript. body: input JSON. Returns {data: processedResult}. Runs in the independent Hoya v1 engine with bounded execution.
- GET /api/apps/code/:code/pages — public: get pages for display by app code (no auth required).
- POST /api/ai/generate-page — AI generates a PageConfig JSON. body: {name, appName?, appDescription?, instruction?, appId?}. When appId is provided, datasource context is injected into the prompt. The LLM receives a full component catalog (24+ components with Zod-typed props) and 6 common scenario patterns (Dashboard, Data CRUD, Detail, List/Browse, Form/Wizard, Monitoring/Status). Returns {pageConfig: PageConfig}.

## Runtime contracts
- JS: function main(input, ctx) or async function main(input, ctx), JSON result.
- ctx.log(level, message, fields?) and ctx.now(); no fetch/call/timers/Node APIs.
- WASM: hoya-json-v1, memory and hoya_main() -> pointer to NUL-terminated JSON.
- Use precompiled binary upload with encoding=base64. MoonBit is unverified.
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
  };
const server = createServer(withIdempotency(dispatch));

// ── 启动 ──────────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? configPort);
server.listen(port, "127.0.0.1", () => {
  armAllSchedules();
  console.log(`Hosta listening on http://127.0.0.1:${(server.address() as {port:number}).port}`);
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
