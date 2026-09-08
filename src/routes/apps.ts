import type { IncomingMessage, ServerResponse } from "node:http";
import { store, save, consumeSerial } from "../store.js";
import {
  json,
  error,
  body,
  publicApp,
  id,
  appCode,
  now,
  appById,
  appByCode,
  sha,
  versionById,
  normalizeSlug,
  inferSchemaFromTests,
  inferCapabilities,
  invokeDocsFor,
} from "../utils.js";
import { generateVersion } from "../llm.js";

// ── App CRUD ──────────────────────────────────────────────────────────────────

export function registerAppRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  const method = req.method!;

  // GET /api/apps
  if (method === "GET" && url.pathname === "/api/apps") {
    if (url.searchParams.get("view") === "summary") {
      const versions = new Map(store.versions.map(v => [v.id, v]));
      const briefVersion = (id: string | null) => {
        const v = id && versions.get(id);
        return v ? { id: v.id, number: v.number, status: v.status, codeSha256: v.codeSha256 } : null;
      };
      json(res, 200, store.apps.map(a => ({
        id: a.id, name: a.name, description: a.description, runtime: a.runtime, code: a.code,
        draftVersion: briefVersion(a.draftVersionId), publishedVersion: briefVersion(a.publishedVersionId),
      })));
    } else json(res, 200, store.apps.map(publicApp));
    return true;
  }

  // GET /api/discover
  if (method === "GET" && url.pathname === "/api/discover") {
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
        const tests = publishedVersion?.tests || [];
        const inputSchema = inferSchemaFromTests(
          tests as unknown as Record<string, unknown>[],
          "input",
        );
        const outputSchema = inferSchemaFromTests(
          tests as unknown as Record<string, unknown>[],
          "expectedOutput",
        );
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
    json(res, 200, {
      published,
      count: published.length,
      generator: process.env.DEEPSEEK_API_KEY ? "deepseek" : "local-demo",
    });
    return true;
  }

  // POST /api/apps
  if (method === "POST" && url.pathname === "/api/apps") {
    (async () => {
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
      const runtime: "javascript" | "wasm" =
        input.runtime === "wasm" ? "wasm" : "javascript";
      const language: "javascript" | "rust" | "moonbit" =
        runtime === "wasm" && input.language === "moonbit"
          ? "moonbit"
          : runtime === "wasm"
            ? "rust"
            : "javascript";
      const name = String(input.name).trim().slice(0, 120);
      const serial = consumeSerial();
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
        sampleInput: (input.sampleInput ?? {}) as Record<string, unknown>,
        draftVersionId: null,
        publishedVersionId: null,
        createdAt: now(),
        updatedAt: now(),
      };
      store.apps.push(app);
      await save();
      json(res, 201, publicApp(app));
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // PATCH /api/apps/:id
  const appEditMatch = url.pathname.match(/^\/api\/apps\/([^/]+)$/);
  if (method === "PATCH" && appEditMatch) {
    (async () => {
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
        app.code = `${app.serial}-${normalizeSlug(payload.code as string)}`;
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
      json(res, 200, publicApp(app));
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // GET /api/apps/:id
  if (method === "GET" && appEditMatch) {
    const app = appById(appEditMatch[1]);
    return app
      ? (json(res, 200, publicApp(app)), true)
      : (error(res, 404, "NOT_FOUND", "App not found"), true);
  }

  // DELETE /api/apps/:id
  if (method === "DELETE" && appEditMatch) {
    (async () => {
      const app = appById(appEditMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      // Clean up schedules
      for (const schedule of store.schedules.filter(
        (item) => item.appId === app.id,
      )) {
        // Timer cleanup handled in index.ts
      }
      store.apps = store.apps.filter((item) => item.id !== app.id);
      store.versions = store.versions.filter((item) => item.appId !== app.id);
      store.deploymentEvents = store.deploymentEvents.filter(e => e.appId !== app.id);
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
      json(res, 200, { deleted: app.id });
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // GET /api/apps/:id/invoke-docs
  const invokeDocsMatch = url.pathname.match(
    /^\/api\/apps\/([^/]+)\/invoke-docs$/,
  );
  if (method === "GET" && invokeDocsMatch) {
    const app = appById(invokeDocsMatch[1]) || appByCode(invokeDocsMatch[1]);
    if (!app) return (error(res, 404, "NOT_FOUND", "App not found"), true);
    const deployment = store.deployments.find(
      (d) => d.appId === app.id && d.status === "active",
    );
    const origin = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host || "127.0.0.1:4173"}`;
    json(res, 200, invokeDocsFor(app, deployment, origin));
    return true;
  }

  // POST /api/apps/:id/generate
  const generateMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/generate$/);
  if (method === "POST" && generateMatch) {
    (async () => {
      const app = appById(generateMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const version = await generateVersion(app);
      await save();
      // Run tests if no errors
      if (version.status === "ready") {
        for (const test of version.tests) {
          const { execute } = await import("../executor.js");
          await execute(version, test.input ?? {}, "generated_test");
        }
      }
      json(res, 201, version);
    })().catch((e) =>
      error(res, 502, "MODEL_ERROR", `Generation failed: ${e.message}`),
    );
    return true;
  }

  return false;
}
