import { recordDeploymentEvent, deploymentHistoryLimit } from "../deployment-history.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { store, save } from "../store.js";
import {
  json,
  body,
  error,
  appById,
  deploymentById,
  sha,
  randomBytes,
} from "../utils.js";

export function registerDeploymentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  const method = req.method!;

  // GET /api/apps/:id/deployment
  const deploymentGetMatch = url.pathname.match(
    /^\/api\/apps\/([^/]+)\/deployment$/,
  );
  if (method === "GET" && deploymentGetMatch) {
    const app = appById(deploymentGetMatch[1]);
    if (!app) return (error(res, 404, "NOT_FOUND", "App not found"), true);
    const deployment = store.deployments.find((d) => d.appId === app.id);
    if (!deployment)
      return (json(res, 200, { appId: app.id, status: "none" }), true);
    const version = deployment.versionId
      ? store.versions.find((v) => v.id === deployment.versionId)
      : null;
    json(res, 200, {
      id: deployment.id,
      lastEventId: deployment.lastEventId ?? null,
      appId: deployment.appId,
      status: deployment.status,
      versionId: deployment.versionId,
      versionNumber: version?.number || null,
      versionStatus: version?.status || null,
      createdAt: deployment.createdAt,
      updatedAt: deployment.updatedAt,
    });
    return true;
  }

  const historyMatch = url.pathname.match(/^\/api\/deployments\/([^/]+)\/history$/);
  if (method === "GET" && historyMatch) {
    if (!deploymentById(historyMatch[1])) return (error(res,404,"NOT_FOUND","Deployment not found"),true);
    const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 20);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return (error(res,400,"VALIDATION_ERROR","Invalid pagination"),true);
    const events = store.deploymentEvents.filter(e => e.deploymentId === historyMatch[1]).reverse();
    json(res,200,{ items: events.slice(offset,offset+limit), nextOffset: offset+limit < events.length ? offset+limit : null, retentionLimit: deploymentHistoryLimit });
    return true;
  }

  // POST /api/deployments/:id/rollback
  const rollbackMatch = url.pathname.match(
    /^\/api\/deployments\/([^/]+)\/rollback$/,
  );
  if (method === "POST" && rollbackMatch) {
    (async () => {
      const deployment = deploymentById(rollbackMatch[1]);
      if (!deployment)
        return error(res, 404, "NOT_FOUND", "Deployment not found");
      const app = appById(deployment.appId);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      if (typeof payload.versionId !== "string" || !payload.versionId)
        return error(res, 400, "VERSION_REQUIRED", "Choose an explicit versionId to roll back to");
      const prevVersion = store.versions.find(v => v.id === payload.versionId && v.appId === app.id);
      if (!prevVersion)
        return error(res, 404, "NOT_FOUND", "Version not found for this application");
      if (prevVersion.status !== "ready" || !store.runs.some(r => r.versionId === prevVersion.id && r.trigger === "manual" && r.status === "succeeded"))
        return error(res, 400, "TRIAL_REQUIRED", "Run the selected version successfully before rollback");
      if (deployment.status !== "active")
        return error(res, 409, "DEPLOYMENT_INACTIVE", "Use publish with an explicit version to restore this deployment");
      const previousVersionId = deployment.versionId;
      deployment.versionId = prevVersion.id;
      deployment.updatedAt = new Date().toISOString();
      app.publishedVersionId = prevVersion.id;
      app.updatedAt = new Date().toISOString();
      const event = recordDeploymentEvent(deployment, "rollback", previousVersionId);
      await save();
      json(res, 200, {
        deploymentEventId: event.id,
        deploymentId: deployment.id,
        versionId: prevVersion.id,
        versionNumber: prevVersion.number,
      });
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // POST /api/deployments/:id/unpublish
  const unpublishMatch = url.pathname.match(
    /^\/api\/deployments\/([^/]+)\/unpublish$/,
  );
  if (method === "POST" && unpublishMatch) {
    (async () => {
      const deployment = deploymentById(unpublishMatch[1]);
      if (!deployment)
        return error(res, 404, "NOT_FOUND", "Deployment not found");
      const app = appById(deployment.appId);
      deployment.status = "inactive";
      deployment.updatedAt = new Date().toISOString();
      if (app) {
        app.publishedVersionId = null;
        app.updatedAt = new Date().toISOString();
      }
      const event = recordDeploymentEvent(deployment, "disable", deployment.versionId);
      await save();
      json(res, 200, { deploymentId: deployment.id, deploymentEventId: event.id, status: "inactive" });
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // POST /api/deployments/:id/regenerate-key
  const regenKeyMatch = url.pathname.match(
    /^\/api\/deployments\/([^/]+)\/regenerate-key$/,
  );
  if (method === "POST" && regenKeyMatch) {
    (async () => {
      const deployment = deploymentById(regenKeyMatch[1]);
      if (!deployment)
        return error(res, 404, "NOT_FOUND", "Deployment not found");
      const webhookKey = randomBytes(24).toString("base64url");
      deployment.keyHash = sha(webhookKey);
      deployment.updatedAt = new Date().toISOString();
      const event = recordDeploymentEvent(deployment, "rotate_key", deployment.versionId);
      await save();
      json(res, 200, {
        deploymentEventId: event.id,
        deploymentId: deployment.id,
        webhookKey,
        webhookUrl: `/hooks/${deployment.id}`,
      });
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  return false;
}
