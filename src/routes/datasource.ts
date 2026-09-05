import type { IncomingMessage, ServerResponse } from "node:http";
import { store, save } from "../store.js";
import {
  json,
  error,
  body,
  id,
  now,
  appById,
  datasourceByAppId,
  datasourceSnapshotById,
  externalDatasourcesByAppId,
} from "../utils.js";
import { validateJsonSchema } from "../validator.js";
import { runMigration } from "../executor.js";

export function registerDatasourceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  const method = req.method!;

  // GET /api/apps/:id/datasource
  const datasourceMatch = url.pathname.match(
    /^\/api\/apps\/([^/]+)\/datasource$/,
  );
  if (method === "GET" && datasourceMatch) {
    const app = appById(datasourceMatch[1]);
    if (!app) return (error(res, 404, "NOT_FOUND", "App not found"), true);
    const ds = datasourceByAppId(app.id);
    json(res, 200, {
      appId: app.id,
      data: ds ? ds.data : {},
      schema: ds ? ds.schema || null : null,
      updatedAt: ds ? ds.updatedAt : null,
      snapshotCount: store.datasourceSnapshots.filter((s) => s.appId === app.id)
        .length,
    });
    return true;
  }

  // PUT /api/apps/:id/datasource
  if (method === "PUT" && datasourceMatch) {
    (async () => {
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
        ds = {
          id: id("ds"),
          appId: app.id,
          data: {},
          createdAt: now(),
          schema: null,
          updatedAt: now(),
        };
        store.datasources.push(ds);
      }
      const effectiveSchema =
        payload.schema !== undefined ? payload.schema : ds.schema;
      if (
        effectiveSchema &&
        typeof effectiveSchema === "object" &&
        (effectiveSchema as any).type
      ) {
        const schemaErrors = validateJsonSchema(
          effectiveSchema as Record<string, unknown>,
          payload.data,
        );
        if (schemaErrors.length > 0)
          return error(
            res,
            400,
            "SCHEMA_VALIDATION_FAILED",
            `Data does not match schema: ${schemaErrors.join("; ")}`,
          );
      }
      const snapshot = {
        id: id("dss"),
        appId: app.id,
        data: JSON.parse(JSON.stringify(ds.data)),
        createdAt: now(),
      };
      store.datasourceSnapshots.push(snapshot);
      ds.data = payload.data as Record<string, unknown>;
      if (payload.schema !== undefined)
        ds.schema = payload.schema as Record<string, unknown> | null;
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
      json(res, 200, {
        appId: app.id,
        data: ds.data,
        schema: ds.schema || null,
        updatedAt: ds.updatedAt,
        snapshotCount: store.datasourceSnapshots.filter(
          (s) => s.appId === app.id,
        ).length,
      });
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // GET /api/apps/:id/datasource/snapshots
  const dsSnapshotsMatch = url.pathname.match(
    /^\/api\/apps\/([^/]+)\/datasource\/snapshots$/,
  );
  if (method === "GET" && dsSnapshotsMatch) {
    const app = appById(dsSnapshotsMatch[1]);
    if (!app) return (error(res, 404, "NOT_FOUND", "App not found"), true);
    const snapshots = store.datasourceSnapshots
      .filter((s) => s.appId === app.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    json(res, 200, {
      appId: app.id,
      snapshots: snapshots.map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        data: s.data,
        status: s.status || null,
        type: s.type || null,
      })),
    });
    return true;
  }

  // POST /api/apps/:id/datasource/restore/:snapshotId
  const dsRestoreMatch = url.pathname.match(
    /^\/api\/apps\/([^/]+)\/datasource\/restore\/([^/]+)$/,
  );
  if (method === "POST" && dsRestoreMatch) {
    (async () => {
      const app = appById(dsRestoreMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const snapshot = datasourceSnapshotById(dsRestoreMatch[2]);
      if (!snapshot || snapshot.appId !== app.id)
        return error(res, 404, "NOT_FOUND", "Snapshot not found");
      let ds = datasourceByAppId(app.id);
      if (!ds) {
        ds = {
          id: id("ds"),
          appId: app.id,
          data: {},
          createdAt: now(),
          schema: null,
          updatedAt: now(),
        };
        store.datasources.push(ds);
      }
      const before = JSON.parse(JSON.stringify(ds.data));
      ds.data = JSON.parse(JSON.stringify(snapshot.data));
      ds.updatedAt = now();
      await save();
      json(res, 200, {
        appId: app.id,
        before,
        after: ds.data,
        restoredFrom: snapshot.id,
      });
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // POST /api/apps/:id/datasource/migrate
  const dsMigrateMatch = url.pathname.match(
    /^\/api\/apps\/([^/]+)\/datasource\/migrate$/,
  );
  if (method === "POST" && dsMigrateMatch) {
    (async () => {
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
        status: "pending" as const,
        type: "migration" as const,
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
      json(res, 200, {
        success: true,
        appId: app.id,
        snapshotId: snapshot.id,
        before: result.before,
        after: result.after,
        logs: result.logs,
      });
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // POST /api/apps/:id/datasource/promote/:snapshotId
  const dsPromoteMatch = url.pathname.match(
    /^\/api\/apps\/([^/]+)\/datasource\/promote\/([^/]+)$/,
  );
  if (method === "POST" && dsPromoteMatch) {
    (async () => {
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
        ds = {
          id: id("ds"),
          appId: app.id,
          data: {},
          createdAt: now(),
          schema: null,
          updatedAt: now(),
        };
        store.datasources.push(ds);
      }
      const before = JSON.parse(JSON.stringify(ds.data));
      ds.data = JSON.parse(JSON.stringify(snapshot.data));
      ds.updatedAt = now();
      snapshot.status = "applied";
      snapshot.appliedAt = now();
      await save();
      json(res, 200, {
        appId: app.id,
        before,
        after: ds.data,
        snapshotId: snapshot.id,
      });
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // ── External Datasources ──────────────────────────────────────────────────────

  const extDsListMatch = url.pathname.match(
    /^\/api\/apps\/([^/]+)\/external-datasources$/,
  );
  if (method === "GET" && extDsListMatch) {
    const app = appById(extDsListMatch[1]);
    if (!app) return (error(res, 404, "NOT_FOUND", "App not found"), true);
    json(res, 200, {
      appId: app.id,
      datasources: externalDatasourcesByAppId(app.id),
    });
    return true;
  }
  if (method === "POST" && extDsListMatch) {
    (async () => {
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
        method: ((payload.method as string) || "GET").toUpperCase(),
        headers:
          payload.headers && typeof payload.headers === "object"
            ? (payload.headers as Record<string, string>)
            : {},
        inputSchema:
          payload.inputSchema && typeof payload.inputSchema === "object"
            ? (payload.inputSchema as Record<string, unknown>)
            : null,
        outputSchema:
          payload.outputSchema && typeof payload.outputSchema === "object"
            ? (payload.outputSchema as Record<string, unknown>)
            : null,
        createdAt: now(),
        updatedAt: now(),
      };
      store.externalDatasources.push(eds);
      await save();
      json(res, 201, eds);
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  const extDsMatch = url.pathname.match(
    /^\/api\/apps\/([^/]+)\/external-datasources\/([^/]+)$/,
  );
  if (method === "PUT" && extDsMatch) {
    (async () => {
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
        eds.method = (payload.method as string).toUpperCase();
      if (payload.headers !== undefined)
        eds.headers = payload.headers as Record<string, string>;
      if (payload.inputSchema !== undefined)
        eds.inputSchema = payload.inputSchema as Record<string, unknown> | null;
      if (payload.outputSchema !== undefined)
        eds.outputSchema = payload.outputSchema as Record<
          string,
          unknown
        > | null;
      eds.updatedAt = now();
      await save();
      json(res, 200, eds);
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }
  if (method === "DELETE" && extDsMatch) {
    const app = appById(extDsMatch[1]);
    if (!app) return (error(res, 404, "NOT_FOUND", "App not found"), true);
    const idx = store.externalDatasources.findIndex(
      (e) => e.id === extDsMatch[2] && e.appId === app.id,
    );
    if (idx === -1)
      return (
        error(res, 404, "NOT_FOUND", "External datasource not found"),
        true
      );
    store.externalDatasources.splice(idx, 1);
    save();
    json(res, 200, { deleted: extDsMatch[2] });
    return true;
  }

  // POST /api/apps/:id/external-datasources/:edsId/test
  const extDsTestMatch = url.pathname.match(
    /^\/api\/apps\/([^/]+)\/external-datasources\/([^/]+)\/test$/,
  );
  if (method === "POST" && extDsTestMatch) {
    (async () => {
      const app = appById(extDsTestMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const eds = store.externalDatasources.find(
        (e) => e.id === extDsTestMatch[2] && e.appId === app.id,
      );
      if (!eds)
        return error(res, 404, "NOT_FOUND", "External datasource not found");
      const fetchOpts: any = {
        method: eds.method,
        headers: { ...eds.headers },
      };
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
      json(res, 200, {
        status: upstream.status,
        headers: Object.fromEntries(upstream.headers.entries()),
        data,
        durationMs: Date.now() - start,
      });
    })().catch((e) => json(res, 502, { error: e.message }));
    return true;
  }

  return false;
}
