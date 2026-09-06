import type { IncomingMessage, ServerResponse } from "node:http";
import { store, save } from "../store.js";
import { json, error, body, now } from "../utils.js";
import { engineStatus } from "../../lib/hoya-client.mjs";

export function registerAdminRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  const method = req.method!;

  // GET /api/admin/status
  if (method === "GET" && url.pathname === "/api/admin/status") {
    (async () => {
    const engine = await engineStatus();
    json(res, 200, {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      pid: process.pid,
      version: process.version,
      platform: process.platform,
      arch: process.arch,
      store: {
        apps: store.apps.length,
        versions: store.versions.length,
        deployments: store.deployments.length,
        runs: store.runs.length,
        schedules: store.schedules.length,
        modelCalls: store.modelCalls.length,
        datasources: store.datasources.length,
        datasourceSnapshots: store.datasourceSnapshots.length,
        pages: (store.pages || []).length,
        externalDatasources: store.externalDatasources.length,
      },
      sandbox: {
        level: "hoya",
        label: "Hoya v1 (QuickJS + Wasmtime)",
        hoyaRunning: engine.status === "ready",
        engine,
      },
      uptimeSeconds: Math.floor(process.uptime()),
    });
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // POST /api/admin/sandbox — toggle sandbox level
  if (method === "POST" && url.pathname === "/api/admin/sandbox") {
    error(res, 409, "ENGINE_REQUIRED", "Hoya v1 is required; configure HOYA_URL and HOYA_AUTH_TOKEN, then inspect /api/status");
    return true;
  }

  // GET /api/admin/health
  if (method === "GET" && url.pathname === "/api/admin/health") {
    json(res, 200, { status: "ok", timestamp: now() });
    return true;
  }

  // POST /api/admin/reset
  if (method === "POST" && url.pathname === "/api/admin/reset") {
    (async () => {
      const input = await body(req);
      const confirm = String(input.confirm || "");
      if (confirm !== "RESET")
        return error(
          res,
          400,
          "CONFIRMATION_REQUIRED",
          'Send {"confirm":"RESET"} to confirm',
        );
      // Clear all application data
      store.apps = [];
      store.versions = [];
      store.deployments = [];
      store.schedules = [];
      store.runs = [];
      store.modelCalls = [];
      store.datasources = [];
      store.datasourceSnapshots = [];
      store.externalDatasources = [];
      store.pages = [];
      store.externalDatasources = [];
      await save();
      json(res, 200, {
        status: "ok",
        message: "All application data has been reset",
      });
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // POST /api/admin/gc
  if (method === "POST" && url.pathname === "/api/admin/gc") {
    if (global.gc) {
      global.gc();
      json(res, 200, { status: "ok", timestamp: now(), action: "forced_gc" });
    } else {
      json(res, 200, {
        status: "ok",
        timestamp: now(),
        action: "no_gc_flag",
        hint: "Run with --expose-gc",
      });
    }
    return true;
  }

  return false;
}
