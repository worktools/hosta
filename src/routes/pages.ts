import type { IncomingMessage, ServerResponse } from "node:http";
import { store, save } from "../store.js";
import {
  json,
  error,
  body,
  id,
  now,
  appById,
  versionById,
  datasourceByAppId,
} from "../utils.js";
import { deepSeekGeneratePage } from "../llm.js";
import { executeWithHoya, artifactHash } from "../../lib/hoya-client.mjs";
import type { Page, PageConfig } from "../types.js";

export function registerPageRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  const method = req.method!;

  const pagesListMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/pages$/);
  const pagesItemMatch = url.pathname.match(
    /^\/api\/apps\/([^/]+)\/pages\/([^/]+)$/,
  );
  const pagesDataMatch = url.pathname.match(
    /^\/api\/apps\/([^/]+)\/pages\/([^/]+)\/data$/,
  );

  // GET /api/apps/:id/pages
  if (method === "GET" && pagesListMatch) {
    const app = appById(pagesListMatch[1]);
    if (!app) return (error(res, 404, "NOT_FOUND", "App not found"), true);
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
    json(res, 200, appPages);
    return true;
  }

  // POST /api/apps/:id/pages
  if (method === "POST" && pagesListMatch) {
    (async () => {
      const app = appById(pagesListMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      if (!String(payload.name || "").trim())
        return error(res, 400, "VALIDATION_ERROR", "Page name is required");
      const page: Page = {
        id: id("page"),
        appId: app.id,
        name: String(payload.name).trim().slice(0, 200),
        pageConfig:
          (payload.pageConfig as PageConfig) ||
          ({
            version: "1.0",
            layout: { type: "grid", config: {} },
            regions: [],
          } as PageConfig),
        processScript: String(payload.processScript || ""),
        createdAt: now(),
        updatedAt: now(),
      };
      (store.pages || (store.pages = [])).push(page);
      await save();
      json(res, 201, page);
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // PUT /api/apps/:id/pages/:pageId
  if (method === "PUT" && pagesItemMatch) {
    (async () => {
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
        page.pageConfig = payload.pageConfig as any;
      if (payload.processScript !== undefined)
        page.processScript = String(payload.processScript);
      page.updatedAt = now();
      await save();
      json(res, 200, page);
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // DELETE /api/apps/:id/pages/:pageId
  if (method === "DELETE" && pagesItemMatch) {
    const app = appById(pagesItemMatch[1]);
    if (!app) return (error(res, 404, "NOT_FOUND", "App not found"), true);
    const idx = (store.pages || []).findIndex(
      (p) => p.id === pagesItemMatch[2] && p.appId === app.id,
    );
    if (idx === -1)
      return (error(res, 404, "NOT_FOUND", "Page not found"), true);
    store.pages.splice(idx, 1);
    save();
    json(res, 200, { deleted: pagesItemMatch[2] });
    return true;
  }

  // POST /api/apps/:id/pages/:pageId/data
  if (method === "POST" && pagesDataMatch) {
    (async () => {
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
        let result: any;
        if (page.processScript && page.processScript.trim()) {
          const code = `async function main(payload) { const process = (${page.processScript.trim()}); return await process(payload.input,payload.datasource); }`;
          const response = await executeWithHoya({code,runtime:'javascript',codeSha256:artifactHash(code,'javascript')},{input,datasource},`page-${page.id}-${Date.now()}`);
          if(response.status!=='succeeded')throw new Error(response.error?.message||'Page script failed');
          result=response.result;
        } else {
          result = { input, datasource };
        }
        json(res, 200, { data: result });
      } catch (e: any) {
        json(res, 200, { data: { error: e.message, input, datasource } });
      }
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // GET /api/apps/code/:code/pages (public pages)
  const publicPagesMatch = url.pathname.match(
    /^\/api\/apps\/code\/([^/]+)\/pages$/,
  );
  if (method === "GET" && publicPagesMatch) {
    const app = store.apps.find((a) => a.code === publicPagesMatch[1]);
    if (!app) return (error(res, 404, "NOT_FOUND", "App not found"), true);
    const appPages = (store.pages || [])
      .filter((p) => p.appId === app.id)
      .map((p) => ({
        id: p.id,
        appId: p.appId,
        name: p.name,
        pageConfig: p.pageConfig,
      }));
    json(res, 200, appPages);
    return true;
  }

  // POST /api/ai/generate-page
  if (method === "POST" && url.pathname === "/api/ai/generate-page") {
    (async () => {
      const input = await body(req);
      const name = String(input.name || "").trim();
      if (!name)
        return error(res, 400, "VALIDATION_ERROR", "Page name is required");
      let datasourceContext: string | null = null;
      if (input.appId) {
        const ds = datasourceByAppId(input.appId as string);
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
      json(res, 200, result);
    })().catch((e) =>
      error(res, 502, "MODEL_ERROR", `Page generation failed: ${e.message}`),
    );
    return true;
  }

  return false;
}
