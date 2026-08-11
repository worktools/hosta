import type { IncomingMessage, ServerResponse } from "node:http";
import { store } from "../store.js";
import { json, error, appById, versionById } from "../utils.js";

export function registerStatsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  const method = req.method!;

  if (method !== "GET") return false;

  // GET /api/stats
  if (url.pathname === "/api/stats") {
    const allRuns = store.runs;
    const byStatus: Record<string, number> = {};
    for (const r of allRuns) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    const recent = allRuns.slice(-50).reverse();
    const recentLogs: any[] = [];
    for (const r of recent) {
      if (r.logs && r.logs.length) {
        for (const l of r.logs.slice(-5)) {
          recentLogs.push({
            runId: r.id, appId: r.appId,
            appName: (appById(r.appId) || {}).name || "",
            versionNumber: r.versionNumber, level: l.level, message: l.message, fields: l.fields, at: l.at,
          });
        }
      }
    }
    const perApp: Record<string, any> = {};
    for (const r of allRuns) {
      const app = appById(r.appId);
      const key = app ? app.name : r.appId;
      if (!perApp[key]) perApp[key] = { total: 0, succeeded: 0, failed: 0, timed_out: 0, rejected: 0 };
      perApp[key].total++;
      perApp[key][r.status] = (perApp[key][r.status] || 0) + 1;
    }
    const perVersion: Record<string, any> = {};
    for (const r of allRuns) {
      const app = appById(r.appId);
      const key = `${app?.name || r.appId} / v${r.versionNumber || "?"}`;
      if (!perVersion[key]) perVersion[key] = { appId: r.appId, versionNumber: r.versionNumber || 0, total: 0, succeeded: 0, failed: 0, timed_out: 0 };
      perVersion[key].total++;
      perVersion[key][r.status] = (perVersion[key][r.status] || 0) + 1;
    }
    json(res, 200, {
      totalRuns: allRuns.length, byStatus,
      recentLogs: recentLogs.slice(-100),
      perApp: Object.entries(perApp).map(([name, s]) => ({ name, ...s } as any)),
      perVersion: Object.entries(perVersion).map(([name, s]) => ({ name, ...s } as any)).sort((a: any, b: any) => b.total - a.total),
      totalApps: store.apps.length,
      totalPublished: store.apps.filter((a) => a.publishedVersionId).length,
    });
    return true;
  }

  // GET /api/apps/:id/runs
  const appRunsMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/runs$/);
  if (appRunsMatch) {
    const app = appById(appRunsMatch[1]);
    if (!app) return error(res, 404, "NOT_FOUND", "App not found"), true;
    const runs = store.runs.filter((r) => r.appId === app.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
    json(res, 200, { appId: app.id, runs });
    return true;
  }

  // GET /api/versions/:id/runs
  const versionRunsMatch = url.pathname.match(/^\/api\/versions\/([^/]+)\/runs$/);
  if (versionRunsMatch) {
    const version = versionById(versionRunsMatch[1]);
    if (!version) return error(res, 404, "NOT_FOUND", "Version not found"), true;
    const runs = store.runs.filter((r) => r.versionId === version.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
    json(res, 200, { versionId: version.id, runs });
    return true;
  }

  return false;
}