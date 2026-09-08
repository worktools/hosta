import type { IncomingMessage, ServerResponse } from "node:http";
import { store, save } from "../store.js";
import {
  json,
  error,
  body,
  appById,
  versionById,
  deploymentById,
  appByCode,
  inputFromRequest,
  sha,
} from "../utils.js";
import { diagnosticsFor, codeQualityScore } from "../validator.js";
import { execute } from "../executor.js";

export function registerExecutionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  const method = req.method!;

  // Retrying is an explicit new execution, never a replay of the original response.
  const retryMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/retry$/);
  if (method === "POST" && retryMatch) {
    (async () => {
      const original = store.runs.find(run => run.id === retryMatch[1]);
      if (!original) return error(res, 404, "NOT_FOUND", "Run not found");
      const payload = await body(req);
      if (!payload || payload.confirm !== true)
        return error(res, 400, "CONFIRMATION_REQUIRED", "Send confirm=true to execute the original version and input again");
      if (Object.keys(payload).some(key => key !== "confirm"))
        return error(res, 400, "INVALID_RETRY", "Retry does not accept input or version overrides");
      if (!["succeeded", "failed", "timed_out", "rejected", "internal_error"].includes(original.status))
        return error(res, 409, "RUN_NOT_FINISHED", "Wait for the original run to finish before retrying");
      const version = versionById(original.versionId);
      if (!version || version.appId !== original.appId || !appById(original.appId))
        return error(res, 404, "NOT_FOUND", "Original application or version no longer exists");
      if (original.artifactSha256 && original.artifactSha256 !== version.codeSha256)
        return error(res, 409, "ARTIFACT_HASH_MISMATCH", "Original artifact no longer matches the stored version");
      json(res, 201, await execute(version, structuredClone(original.input), "retry", { retryOf: original.id }));
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // POST /api/versions/:id/run
  const runMatch = url.pathname.match(/^\/api\/versions\/([^/]+)\/run$/);
  if (method === "POST" && runMatch) {
    (async () => {
      const version = versionById(runMatch[1]);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const input = await body(req);
      json(res, 201, await execute(version, input, "manual"));
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // POST /api/versions/:id/diagnose
  const diagnoseMatch = url.pathname.match(
    /^\/api\/versions\/([^/]+)\/diagnose$/,
  );
  if (method === "POST" && diagnoseMatch) {
    (async () => {
      const version = versionById(diagnoseMatch[1]);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const input = await body(req);
      const diags = diagnosticsFor(
        version.code,
        version.runtime || "javascript",
      );
      const run = diags.some((item) => item.severity === "error")
        ? null
        : await execute(version, input, "diagnostic");
      if (run?.status !== "succeeded")
        diags.push({
          severity: "error",
          code: run?.error?.code || "EXECUTION_FAILED",
          message: run?.error?.message || "Execution did not complete",
          runId: run?.id,
        });
      else
        diags.push({
          severity: "info",
          code: "EXECUTION_SUCCEEDED",
          message: `样例执行成功，耗时 ${run.durationMs} ms。`,
          runId: run.id,
        });
      const quality = codeQualityScore(diags, version.code);
      json(res, 200, {
        versionId: version.id,
        diagnostics: diags,
        run,
        quality,
      });
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // POST /hooks/:id
  const hookMatch = url.pathname.match(/^\/hooks\/([^/]+)$/);
  if (method === "POST" && hookMatch) {
    (async () => {
      const deployment = deploymentById(hookMatch[1]);
      if (!deployment || deployment.status !== "active")
        return error(res, 404, "NOT_FOUND", "Deployment not found");
      const token = String(req.headers.authorization || "").replace(
        /^Bearer\s+/i,
        "",
      );
      if (!token || sha(token) !== deployment.keyHash)
        return error(
          res,
          401,
          "UNAUTHORIZED",
          "A valid Bearer key is required",
        );
      const version = versionById(deployment.versionId);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const deploymentContext = { deploymentId: deployment.id, deploymentEventId: deployment.lastEventId };
      json(res, 200, await execute(version, await body(req), "webhook", deploymentContext));
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // GET|POST /invoke-version/:appCode/:version
  const invokePinnedMatch = url.pathname.match(
    /^\/invoke-version\/([a-z0-9-]+)\/(\d+)$/,
  );
  if (invokePinnedMatch && (method === "GET" || method === "POST")) {
    (async () => {
      const app = appByCode(invokePinnedMatch[1]);
      const versionNumber = parseInt(invokePinnedMatch[2], 10);
      if (!app) return error(res, 404, "NOT_FOUND", "Application not found");
      const deployment = store.deployments.find(
        (item) => item.appId === app.id && item.status === "active",
      );
      if (!deployment)
        return error(
          res,
          404,
          "NOT_FOUND",
          "No active deployment for this application",
        );
      const version = store.versions.find(
        (v) => v.appId === app.id && v.number === versionNumber,
      );
      if (!version)
        return error(
          res,
          404,
          "NOT_FOUND",
          `Version v${versionNumber} not found`,
        );
      if (version.status !== "ready")
        return error(
          res,
          400,
          "VERSION_NOT_READY",
          `Version v${versionNumber} is not ready (status: ${version.status})`,
        );
      const token =
        method === "GET"
          ? String(
              url.searchParams.get("key") ||
                url.searchParams.get("api_key") ||
                "",
            )
          : String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!token || sha(token) !== deployment.keyHash)
        return error(
          res,
          401,
          "UNAUTHORIZED",
          "A valid Bearer key is required",
        );
      const deploymentContext = { deploymentId: deployment.id, deploymentEventId: deployment.lastEventId };
      json(
        res,
        200,
        await execute(version, await inputFromRequest(req), "invoke-pinned", deploymentContext),
      );
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // GET|POST /invoke/:appCode
  const invokeMatch = url.pathname.match(/^\/invoke\/([a-z0-9-]+)$/);
  if (invokeMatch && (method === "GET" || method === "POST")) {
    (async () => {
      const app = appByCode(invokeMatch[1]);
      const deployment =
        app &&
        store.deployments.find(
          (item) => item.appId === app.id && item.status === "active",
        );
      if (!deployment)
        return error(res, 404, "NOT_FOUND", "Published application not found");
      const token =
        method === "GET"
          ? String(
              url.searchParams.get("key") ||
                url.searchParams.get("api_key") ||
                "",
            )
          : String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!token || sha(token) !== deployment.keyHash)
        return error(
          res,
          401,
          "UNAUTHORIZED",
          "A valid Bearer key is required",
        );
      const version = versionById(deployment.versionId);
      const deploymentContext = { deploymentId: deployment.id, deploymentEventId: deployment.lastEventId };
      json(
        res,
        200,
        await execute(version!, await inputFromRequest(req), "invoke", deploymentContext),
      );
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // GET /api/runs/:id
  if (method === "GET" && url.pathname.startsWith("/api/runs/")) {
    const runId = url.pathname.split("/").pop();
    // /chain
    if (url.pathname.endsWith("/chain")) {
      const chainRunId = url.pathname.split("/")[3];
      const run = store.runs.find((r) => r.id === chainRunId);
      if (!run) return (error(res, 404, "NOT_FOUND", "Run not found"), true);
      const nodes = [];
      const visited = new Set<string>();
      let current: any = run;
      let depth = 0;
      while (current && !visited.has(current.id) && depth < 5) {
        visited.add(current.id);
        const app = appById(current.appId);
        nodes.push({
          appId: current.appId,
          appName: app?.name || "",
          appCode: app?.code || "",
          runId: current.id,
          status: current.status,
          durationMs: current.durationMs,
          depth,
          trigger: current.trigger,
        });
        if (current.parentRunId) {
          current = store.runs.find((r) => r.id === current.parentRunId);
          depth++;
        } else break;
      }
      nodes.reverse();
      json(res, 200, { nodes, rootRunId: nodes[0]?.runId });
      return true;
    }
    // /logs
    if (url.pathname.endsWith("/logs")) {
      const logsRunId = url.pathname.split("/")[3];
      const run = store.runs.find((r) => r.id === logsRunId);
      if (!run) return (error(res, 404, "NOT_FOUND", "Run not found"), true);
      json(res, 200, {
        runId: run.id,
        logs: run.logs || [],
        status: run.status,
        error: run.error || null,
      });
      return true;
    }
    // /api/runs/:id
    const run = store.runs.find((r) => r.id === runId);
    return run
      ? (json(res, 200, run), true)
      : (error(res, 404, "NOT_FOUND", "Run not found"), true);
  }

  return false;
}
