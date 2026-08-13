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

  // GET — list schedules for an app
  if (method === "GET" && scheduleMatch) {
    const app = appById(scheduleMatch[1]);
    if (!app) return (error(res, 404, "NOT_FOUND", "App not found"), true);
    const schedules = store.schedules
      .filter((s) => s.appId === app.id)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    json(res, 200, schedules);
    return true;
  }

  // POST — create a schedule
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
      if (!version || version.appId !== app.id || version.status !== "ready")
        return error(
          res,
          400,
          "NOT_SCHEDULABLE",
          "A ready version is required",
        );

      const scheduleType = (payload.scheduleType as string) || "interval";
      if (!["interval", "daily", "cron"].includes(scheduleType))
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "scheduleType must be one of: interval, daily, cron",
        );

      let nextRunAtStr: string;
      let intervalSeconds = 0;
      const input =
        (payload.input as Record<string, unknown>) ?? app.sampleInput ?? {};

      if (scheduleType === "interval") {
        intervalSeconds = Number(payload.intervalSeconds);
        if (
          !Number.isInteger(intervalSeconds) ||
          intervalSeconds < 600 ||
          intervalSeconds > 86400
        )
          return error(
            res,
            400,
            "VALIDATION_ERROR",
            "intervalSeconds must be between 600 (10min) and 86400 (24h)",
          );
        nextRunAtStr = new Date(
          Date.now() + intervalSeconds * 1000,
        ).toISOString();
      } else if (scheduleType === "daily") {
        const dailyAt = (payload.dailyAt as string) || "00:00";
        if (!/^\d{2}:\d{2}$/.test(dailyAt))
          return error(
            res,
            400,
            "VALIDATION_ERROR",
            "dailyAt must be in HH:mm format (e.g. 08:30)",
          );
        const [h, m] = dailyAt.split(":").map(Number);
        if (h < 0 || h > 23 || m < 0 || m > 59)
          return error(
            res,
            400,
            "VALIDATION_ERROR",
            "dailyAt hours must be 0-23, minutes 0-59",
          );
        const now = new Date();
        const next = new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate(),
            h,
            m,
          ),
        );
        if (next.getTime() <= now.getTime()) {
          next.setUTCDate(next.getUTCDate() + 1);
        }
        nextRunAtStr = next.toISOString();
        intervalSeconds = 86400;
      } else {
        // cron
        const cronExpression = (payload.cronExpression as string) || "";
        if (
          !/^(\*|\d{1,2})(\s+(\*|\d{1,2})){4}$/.test(cronExpression.trim())
        )
          return error(
            res,
            400,
            "VALIDATION_ERROR",
            "cronExpression must be a 5-field cron expression (e.g. '*/30 * * * *')",
          );
        const nextRun = nextCronTime(cronExpression.trim());
        if (!nextRun)
          return error(
            res,
            400,
            "VALIDATION_ERROR",
            "Cannot compute next run time from cron expression",
          );
        nextRunAtStr = nextRun.toISOString();
        intervalSeconds = 600;
      }

      const schedule = {
        id: id("sch"),
        appId: app.id,
        versionId: version.id,
        input,
        scheduleType: scheduleType as "interval" | "daily" | "cron",
        intervalSeconds,
        dailyAt: scheduleType === "daily" ? (payload.dailyAt as string) : null,
        cronExpression:
          scheduleType === "cron" ? (payload.cronExpression as string) : null,
        status: "active" as const,
        createdAt: now(),
        nextRunAt: nextRunAtStr,
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
  scheduleType: string;
  nextRunAt: string;
  versionId: string;
  input: Record<string, unknown>;
  intervalSeconds: number;
  dailyAt?: string | null;
  cronExpression?: string | null;
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

      // Compute next run time based on schedule type
      if (latest.scheduleType === "daily" && latest.dailyAt) {
        const [h, m] = latest.dailyAt.split(":").map(Number);
        const next = new Date();
        next.setUTCHours(h, m, 0, 0);
        if (next.getTime() <= Date.now()) {
          next.setUTCDate(next.getUTCDate() + 1);
        }
        latest.nextRunAt = next.toISOString();
      } else if (latest.scheduleType === "cron" && latest.cronExpression) {
        const next = nextCronTime(latest.cronExpression);
        latest.nextRunAt = next
          ? next.toISOString()
          : new Date(Date.now() + 600 * 1000).toISOString();
      } else {
        latest.nextRunAt = new Date(
          Date.now() + latest.intervalSeconds * 1000,
        ).toISOString();
      }

      await save();
      armSchedule(latest);
    }, delay),
  );
}

// ── Cron helper ────────────────────────────────────────────────────────────────

function nextCronTime(expr: string): Date | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minStr, hourStr, dayStr, monthStr, weekdayStr] = parts;

  const parseField = (f: string, min: number, max: number): number[] => {
    if (f === "*") {
      const vals: number[] = [];
      for (let i = min; i <= max; i++) vals.push(i);
      return vals;
    }
    if (f.startsWith("*/")) {
      const step = parseInt(f.slice(2), 10);
      if (isNaN(step) || step <= 0) return [];
      const vals: number[] = [];
      for (let i = min; i <= max; i += step) vals.push(i);
      return vals;
    }
    const val = parseInt(f, 10);
    if (isNaN(val) || val < min || val > max) return [];
    return [val];
  };

  const minutes = parseField(minStr, 0, 59);
  const hours = parseField(hourStr, 0, 23);
  const days = parseField(dayStr, 1, 31);
  const months = parseField(monthStr, 1, 12);
  const weekdays = parseField(weekdayStr, 0, 6);

  if (
    !minutes.length ||
    !hours.length ||
    !days.length ||
    !months.length ||
    !weekdays.length
  )
    return null;

  const now = new Date();
  // Search forward day by day, up to 2 years
  for (let d = 0; d < 730; d++) {
    const candidate = new Date(now.getTime() + d * 86400000);
    // Set to start of the day
    candidate.setUTCHours(0, 0, 0, 0);
    const month = candidate.getUTCMonth() + 1; // 1-12
    const day = candidate.getUTCDate();
    const weekday = candidate.getUTCDay(); // 0-6

    if (!months.includes(month)) continue;
    if (!days.includes(day)) continue;
    if (!weekdays.includes(weekday)) continue;

    for (const h of hours) {
      for (const m of minutes) {
        candidate.setUTCHours(h, m, 0, 0);
        if (candidate.getTime() > now.getTime()) {
          return candidate;
        }
      }
    }
  }
  return null;
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
