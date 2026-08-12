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
  scheduleById,
  randomBytes,
} from "../utils.js";
import { execute } from "../executor.js";
import { sha } from "../utils.js";

// ── Schedules ──────────────────────────────────────────────────────────────────

export const scheduleTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function registerScheduleRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  const method = req.method!;

  const scheduleMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/schedules$/);
  if (method === "POST" && scheduleMatch) {
    (async () => {
      const app = appById(scheduleMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      const version = versionById(
        (payload.versionId as string) ||
          app.publishedVersionId ||
          app.draftVersionId ||
          "",
      );
      const intervalSeconds = Number(payload.intervalSeconds);
      if (!version || version.appId !== app.id || version.status !== "ready")
        return error(
          res,
          400,
          "NOT_SCHEDULABLE",
          "A ready version is required",
        );
      if (
        !Number.isInteger(intervalSeconds) ||
        intervalSeconds < 60 ||
        intervalSeconds > 86400
      )
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "Interval must be between 60 and 86400 seconds",
        );
      const schedule = {
        id: id("sch"),
        appId: app.id,
        versionId: version.id,
        input:
          (payload.input as Record<string, unknown>) ?? app.sampleInput ?? {},
        intervalSeconds,
        status: "active" as const,
        createdAt: now(),
        nextRunAt: new Date(Date.now() + intervalSeconds * 1000).toISOString(),
        lastRunAt: null,
        lastRunId: null,
      };
      store.schedules.push(schedule);
      await save();
      armSchedule(schedule);
      json(res, 201, schedule);
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  const scheduleDeleteMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)$/);
  if (method === "DELETE" && scheduleDeleteMatch) {
    const schedule = scheduleById(scheduleDeleteMatch[1]);
    if (!schedule)
      return (error(res, 404, "NOT_FOUND", "Schedule not found"), true);
    schedule.status = "disabled";
    const timer = scheduleTimers.get(schedule.id);
    if (timer) clearTimeout(timer);
    scheduleTimers.delete(schedule.id);
    save();
    json(res, 200, schedule);
    return true;
  }

  return false;
}

export function armSchedule(schedule: {
  id: string;
  status: string;
  nextRunAt: string;
  versionId: string;
  input: Record<string, unknown>;
  intervalSeconds: number;
}): void {
  const old = scheduleTimers.get(schedule.id);
  if (old) clearTimeout(old);
  if (schedule.status !== "active") return;
  const due = Date.parse(schedule.nextRunAt || now());
  const delay = Math.max(0, Math.min(2_147_000_000, due - Date.now()));
  scheduleTimers.set(
    schedule.id,
    setTimeout(async () => {
      const latest = scheduleById(schedule.id);
      const version = latest && versionById(latest.versionId);
      if (!latest || latest.status !== "active" || !version) return;
      const run = await execute(version, latest.input, "schedule");
      latest.lastRunId = run.id;
      latest.lastRunAt = now();
      latest.nextRunAt = new Date(
        Date.now() + latest.intervalSeconds * 1000,
      ).toISOString();
      await save();
      armSchedule(latest);
    }, delay),
  );
}

export function armAllSchedules(): void {
  for (const schedule of store.schedules) armSchedule(schedule);
}

// ── Publish ────────────────────────────────────────────────────────────────────

export function registerPublishRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  const method = req.method!;

  const publishMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/publish$/);
  if (method === "POST" && publishMatch) {
    (async () => {
      const app = appById(publishMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      const version = versionById(
        (payload.versionId as string) || app.draftVersionId || "",
      );
      if (!version || version.appId !== app.id || version.status !== "ready")
        return error(
          res,
          400,
          "NOT_PUBLISHABLE",
          "A ready version is required",
        );
      if (
        !store.runs.some(
          (run) =>
            run.versionId === version.id &&
            run.trigger === "manual" &&
            run.status === "succeeded",
        )
      )
        return error(
          res,
          400,
          "TRIAL_REQUIRED",
          "Run this version successfully before publishing",
        );
      let deployment = store.deployments.find((d) => d.appId === app.id);
      const webhookKey = randomBytes(24).toString("base64url");
      if (!deployment) {
        deployment = {
          id: id("dep"),
          appId: app.id,
          status: "active",
          versionId: version.id,
          keyHash: "",
          createdAt: now(),
          updatedAt: now(),
        };
        store.deployments.push(deployment);
      }
      deployment.versionId = version.id;
      deployment.status = "active";
      deployment.keyHash = sha(webhookKey);
      deployment.updatedAt = now();
      app.publishedVersionId = version.id;
      app.updatedAt = now();
      await save();
      json(res, 200, {
        deployment: { ...deployment, keyHash: undefined },
        webhookKey,
        webhookUrl: `/hooks/${deployment.id}`,
      });
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // POST /api/apps/:id/publish (also handled by POST /api/apps/:id/set-default-version in versions.ts)

  return false;
}

// Re-export for convenience
export { randomBytes } from "../utils.js";
