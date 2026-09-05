import type { IncomingMessage, ServerResponse } from "node:http";
import { store, save } from "../store.js";
import {
  json,
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
      // Find the previous version(s) that were published before
      const prevVersions = store.versions
        .filter(
          (v) =>
            v.appId === app.id &&
            v.status === "ready" &&
            store.runs.some(r=>r.versionId===v.id && r.trigger==='manual' && r.status==='succeeded') &&
            v.id !== deployment.versionId,
        )
        .sort((a, b) => b.number - a.number);
      const prevVersion = prevVersions[0];
      if (!prevVersion)
        return error(
          res,
          400,
          "NO_ROLLBACK",
          "No previous version to roll back to",
        );
      deployment.versionId = prevVersion.id;
      deployment.updatedAt = new Date().toISOString();
      app.publishedVersionId = prevVersion.id;
      app.updatedAt = new Date().toISOString();
      await save();
      json(res, 200, {
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
      await save();
      json(res, 200, { deploymentId: deployment.id, status: "inactive" });
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
      await save();
      json(res, 200, {
        deploymentId: deployment.id,
        webhookKey,
        webhookUrl: `/hooks/${deployment.id}`,
      });
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  return false;
}
