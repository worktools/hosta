import type { IncomingMessage, ServerResponse } from "node:http";
import { store, save } from "../store.js";
import {
  json,
  error,
  body,
  id,
  now,
  sha,
  versionById,
  appById,
  datasourceByAppId,
} from "../utils.js";
import {
  diagnosticsFor,
  codeQualityScore,
  validateCode,
  validateJsonSchema,
} from "../validator.js";
import { compileWasm } from "../compiler.js";
import {
  deepSeekGenerateTests,
  deepSeekGenerateSchema,
  deepSeekRevise,
  deepSeekRefine,
  deepSeekRefineRequirements,
} from "../llm.js";
import { execute } from "../executor.js";
import type { Version } from "../types.js";

export function registerVersionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  const method = req.method!;

  // POST /api/apps/:id/versions
  const versionCreateMatch = url.pathname.match(
    /^\/api\/apps\/([^/]+)\/versions$/,
  );
  if (method === "POST" && versionCreateMatch) {
    (async () => {
      const app = appById(versionCreateMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      const code = String(payload.code || "");
      const runtime =
        payload.runtime === "wasm" ? "wasm" : app.runtime || "javascript";
      const language =
        runtime === "wasm" && payload.language === "moonbit"
          ? "moonbit"
          : runtime === "wasm"
            ? "rust"
            : "javascript";
      const compiled =
        runtime === "wasm"
          ? await compileWasm(language, code)
          : { binary: code, size: Buffer.byteLength(code) };
      const diags = diagnosticsFor(compiled.binary, runtime);
      const hasError = diags.some((item) => item.severity === "error");
      const prevVersion = app.draftVersionId
        ? versionById(app.draftVersionId)
        : null;
      const inputSchema =
        payload.inputSchema && typeof payload.inputSchema === "object"
          ? payload.inputSchema
          : prevVersion?.inputSchema || null;
      const outputSchema =
        payload.outputSchema && typeof payload.outputSchema === "object"
          ? payload.outputSchema
          : prevVersion?.outputSchema || null;
      const version: Version = {
        id: id("ver"),
        appId: app.id,
        runtime,
        language,
        sourceCode: runtime === "wasm" ? code : undefined,
        wasmSize: runtime === "wasm" ? compiled.size : undefined,
        number: store.versions.filter((v) => v.appId === app.id).length + 1,
        status: hasError ? "needs_revision" : "ready",
        source: "manual-edit",
        summary: String(payload.summary || "用户编辑的程序版本").slice(0, 500),
        code: compiled.binary,
        codeSha256: sha(compiled.binary),
        inputSchema: inputSchema as Record<string, unknown> | null,
        outputSchema: outputSchema as Record<string, unknown> | null,
        tests:
          prevVersion && prevVersion.tests?.length
            ? prevVersion.tests.map((t) => ({
                name: t.name,
                input: t.input,
                expectedOutput: t.expectedOutput,
              }))
            : [],
        validationError:
          diags.find((item) => item.severity === "error")?.message || null,
        diagnostics: diags,
        createdAt: now(),
      };
      store.versions.push(version);
      app.draftVersionId = version.id;
      app.updatedAt = now();
      await save();
      json(res, 201, version);
    })().catch((e) => error(res, e.status || 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // GET /api/apps/:id/versions
  const versionListMatch = url.pathname.match(
    /^\/api\/apps\/([^/]+)\/versions$/,
  );
  if (method === "GET" && versionListMatch) {
    const app = appById(versionListMatch[1]);
    if (!app) return (error(res, 404, "NOT_FOUND", "App not found"), true);
    const versions = store.versions
      .filter((v) => v.appId === app.id)
      .sort((a, b) => b.number - a.number);
    json(res, 200, {
      appId: app.id,
      publishedVersionId: app.publishedVersionId,
      draftVersionId: app.draftVersionId,
      versions,
    });
    return true;
  }

  // POST /api/apps/:id/refine
  const refineMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/refine$/);
  if (method === "POST" && refineMatch) {
    (async () => {
      const app = appById(refineMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const version = app.draftVersionId
        ? versionById(app.draftVersionId)
        : null;
      const payload = await body(req);
      const instruction = String(payload.instruction || "").trim();
      if (!instruction)
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "refine instruction is required",
        );
      const generated = await deepSeekRefine({
        app,
        version: version!,
        instruction,
        datasourceSchema: (datasourceByAppId(app.id) || {}).schema || null,
      });
      const compiled = {
        binary: generated.code,
        size: Buffer.byteLength(generated.code),
      };
      const diags = diagnosticsFor(
        compiled.binary,
        app.runtime || "javascript",
      );
      const hasError = diags.some((item) => item.severity === "error");
      const newVersion: Version = {
        id: id("ver"),
        appId: app.id,
        runtime: app.runtime || "javascript",
        language: app.language || "javascript",
        number: store.versions.filter((v) => v.appId === app.id).length + 1,
        status: hasError ? "needs_revision" : "ready",
        source: generated.source,
        summary: generated.summary,
        code: compiled.binary,
        codeSha256: sha(compiled.binary),
        inputSchema: version?.inputSchema || null,
        outputSchema: version?.outputSchema || null,
        tests: generated.tests,
        validationError: hasError
          ? diags.find((d) => d.severity === "error")?.message || null
          : null,
        diagnostics: diags,
        createdAt: now(),
        revisedFrom: version?.id || null,
      };
      store.versions.push(newVersion);
      app.draftVersionId = newVersion.id;
      app.updatedAt = now();
      store.modelCalls.push({
        id: id("model"),
        appId: app.id,
        versionId: newVersion.id,
        provider: generated.source,
        model: generated.model,
        usage: generated.usage as Record<string, unknown> | null,
        estimatedCost: null,
        createdAt: now(),
      });
      await save();
      if (!hasError) {
        for (const test of generated.tests)
          await execute(newVersion, test.input ?? {}, "generated_test");
      }
      json(res, 201, newVersion);
    })().catch((e) =>
      error(res, 502, "MODEL_ERROR", `Refinement failed: ${e.message}`),
    );
    return true;
  }

  // POST /api/apps/:id/refine-requirements
  const refineReqMatch = url.pathname.match(
    /^\/api\/apps\/([^/]+)\/refine-requirements$/,
  );
  if (method === "POST" && refineReqMatch) {
    (async () => {
      const app = appById(refineReqMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      const instruction = String(payload.instruction || "").trim();
      if (!instruction)
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "refine instruction is required",
        );
      const result = await deepSeekRefineRequirements({
        requirements: app.requirements || "",
        instruction,
        appName: app.name,
        appDescription: app.description || "",
      });
      json(res, 200, { summary: result.summary, refined: result.refined });
    })().catch((e) =>
      error(
        res,
        502,
        "MODEL_ERROR",
        `Requirements refinement failed: ${e.message}`,
      ),
    );
    return true;
  }

  // POST /api/apps/:id/set-default-version
  const setDefaultVersionMatch = url.pathname.match(
    /^\/api\/apps\/([^/]+)\/set-default-version$/,
  );
  if (method === "POST" && setDefaultVersionMatch) {
    (async () => {
      const app = appById(setDefaultVersionMatch[1]);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      const version = versionById(payload.versionId as string);
      if (!version || version.appId !== app.id)
        return error(res, 404, "NOT_FOUND", "Version not found");
      if (version.status !== "ready")
        return error(
          res,
          400,
          "NOT_PUBLISHABLE",
          "Version must be in ready status",
        );
      const deployment = store.deployments.find((d) => d.appId === app.id);
      if (deployment) {
        deployment.versionId = version.id;
        deployment.updatedAt = now();
      }
      app.publishedVersionId = version.id;
      app.updatedAt = now();
      await save();
      json(res, 200, {
        appId: app.id,
        publishedVersionId: version.id,
        versionNumber: version.number,
      });
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // ── Tests ──────────────────────────────────────────────────────────────────────

  const testsMatch = url.pathname.match(/^\/api\/versions\/([^/]+)\/tests$/);
  if (method === "GET" && testsMatch) {
    const version = versionById(testsMatch[1]);
    if (!version)
      return (error(res, 404, "NOT_FOUND", "Version not found"), true);
    const tests = (version.tests || []).map((t, i) => ({ index: i, ...t }));
    json(res, 200, { versionId: version.id, tests });
    return true;
  }
  if (method === "POST" && testsMatch) {
    (async () => {
      const version = versionById(testsMatch[1]);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const payload = await body(req);
      if (!payload.input || typeof payload.input !== "object")
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "Test input must be a JSON object",
        );
      if (
        version.inputSchema &&
        typeof version.inputSchema === "object" &&
        (version.inputSchema as any).type
      ) {
        const schemaErrors = validateJsonSchema(
          version.inputSchema as Record<string, unknown>,
          payload.input,
        );
        if (schemaErrors.length > 0)
          return error(
            res,
            400,
            "SCHEMA_VALIDATION_FAILED",
            `Test input does not match schema: ${schemaErrors.join("; ")}`,
          );
      }
      version.tests = version.tests || [];
      version.tests.push({
        name:
          String(payload.name || "")
            .trim()
            .slice(0, 200) || `Test ${version.tests.length + 1}`,
        input: payload.input as Record<string, unknown>,
        expectedOutput:
          payload.expectedOutput && typeof payload.expectedOutput === "object"
            ? (payload.expectedOutput as Record<string, unknown>)
            : undefined,
      });
      await save();
      json(res, 201, {
        index: version.tests.length - 1,
        name: version.tests[version.tests.length - 1].name,
        input: payload.input,
        expectedOutput: version.tests[version.tests.length - 1].expectedOutput,
      });
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // POST /api/versions/:id/tests/run-all
  const testRunAllMatch = url.pathname.match(
    /^\/api\/versions\/([^/]+)\/tests\/run-all$/,
  );
  if (method === "POST" && testRunAllMatch) {
    (async () => {
      const version = versionById(testRunAllMatch[1]);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const tests = version.tests || [];
      const results = [];
      for (const test of tests) {
        const run = await execute(version, test.input ?? {}, "test");
        const matched = test.expectedOutput
          ? JSON.stringify(run.result) === JSON.stringify(test.expectedOutput)
          : undefined;
        results.push({
          name: test.name,
          input: test.input,
          expectedOutput: test.expectedOutput,
          actualStatus: run.status,
          matched,
          runId: run.id,
          durationMs: run.durationMs,
          result: run.result,
          error: run.error,
        });
      }
      json(res, 200, {
        versionId: version.id,
        passed: results.filter((r) => r.actualStatus === "succeeded").length,
        total: results.length,
        results,
      });
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // POST /api/versions/:id/tests/generate
  const testGenerateMatch = url.pathname.match(
    /^\/api\/versions\/([^/]+)\/tests\/generate$/,
  );
  if (method === "POST" && testGenerateMatch) {
    (async () => {
      const version = versionById(testGenerateMatch[1]);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const app = appById(version.appId);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const generated = await deepSeekGenerateTests({ app, version });
      version.tests = version.tests || [];
      let added = 0;
      for (const t of generated) {
        if (
          version.inputSchema &&
          typeof version.inputSchema === "object" &&
          (version.inputSchema as any).type
        ) {
          const schemaErrors = validateJsonSchema(
            version.inputSchema as Record<string, unknown>,
            t.input,
          );
          if (schemaErrors.length > 0) continue;
        }
        version.tests.push(t);
        added++;
      }
      await save();
      json(res, 200, {
        generated: added,
        tests: version.tests.map((t, i) => ({
          index: i,
          name: t.name,
          input: t.input,
          expectedOutput: t.expectedOutput,
        })),
      });
    })().catch((e) =>
      error(res, 502, "MODEL_ERROR", `Test generation failed: ${e.message}`),
    );
    return true;
  }

  // DELETE /api/versions/:id/tests/:idx
  const testDeleteMatch = url.pathname.match(
    /^\/api\/versions\/([^/]+)\/tests\/(\d+)$/,
  );
  if (method === "DELETE" && testDeleteMatch) {
    const version = versionById(testDeleteMatch[1]);
    if (!version)
      return (error(res, 404, "NOT_FOUND", "Version not found"), true);
    const idx = Number(testDeleteMatch[2]);
    if (!version.tests || idx < 0 || idx >= version.tests.length)
      return (error(res, 404, "NOT_FOUND", "Test not found"), true);
    version.tests.splice(idx, 1);
    save();
    json(res, 200, { deleted: idx });
    return true;
  }

  // ── Schema ─────────────────────────────────────────────────────────────────────

  // POST /api/versions/:id/schema/generate
  const schemaGenerateMatch = url.pathname.match(
    /^\/api\/versions\/([^/]+)\/schema\/generate$/,
  );
  if (method === "POST" && schemaGenerateMatch) {
    (async () => {
      const version = versionById(schemaGenerateMatch[1]);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const app = appById(version.appId);
      if (!app) return error(res, 404, "NOT_FOUND", "App not found");
      const payload = await body(req);
      const target = payload.target === "output" ? "output" : "input";
      const instruction = String(payload.instruction || "").trim();
      const { schema } = await deepSeekGenerateSchema({
        app,
        version,
        target,
        instruction,
      });
      json(res, 200, { schema, target });
    })().catch((e) =>
      error(res, 502, "MODEL_ERROR", `Schema generation failed: ${e.message}`),
    );
    return true;
  }

  // PUT /api/versions/:id/schema
  const schemaMatch = url.pathname.match(/^\/api\/versions\/([^/]+)\/schema$/);
  if (method === "PUT" && schemaMatch) {
    (async () => {
      const version = versionById(schemaMatch[1]);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const payload = await body(req);
      if (
        !payload.inputSchema ||
        typeof payload.inputSchema !== "object" ||
        !(payload.inputSchema as any).type
      )
        return error(
          res,
          400,
          "VALIDATION_ERROR",
          "inputSchema must be a valid JSON Schema object with a type",
        );
      version.inputSchema = payload.inputSchema as Record<string, unknown>;
      if (payload.outputSchema !== undefined) {
        version.outputSchema =
          payload.outputSchema &&
          typeof payload.outputSchema === "object" &&
          (payload.outputSchema as any).type
            ? (payload.outputSchema as Record<string, unknown>)
            : null;
      }
      await save();
      json(res, 200, {
        versionId: version.id,
        inputSchema: version.inputSchema,
        outputSchema: version.outputSchema || null,
      });
    })().catch((e) => error(res, 500, "INTERNAL_ERROR", e.message));
    return true;
  }

  // ── Revise ─────────────────────────────────────────────────────────────────────

  const reviseMatch = url.pathname.match(/^\/api\/versions\/([^/]+)\/revise$/);
  if (method === "POST" && reviseMatch) {
    (async () => {
      const version = versionById(reviseMatch[1]);
      if (!version) return error(res, 404, "NOT_FOUND", "Version not found");
      const app = appById(version.appId);
      const payload = await body(req);
      const hint = String(payload.hint || "").trim();
      const testResults = [];
      const tests = version.tests || [];
      for (const test of tests) {
        const run = await execute(version, test.input ?? {}, "test");
        const matched = test.expectedOutput
          ? JSON.stringify(run.result) === JSON.stringify(test.expectedOutput)
          : undefined;
        testResults.push({
          name: test.name,
          input: test.input,
          expectedOutput: test.expectedOutput,
          actualStatus: run.status,
          matched,
          runId: run.id,
          durationMs: run.durationMs,
          error: run.error ? { message: run.error.message } : undefined,
        });
      }
      const revised = await deepSeekRevise({
        app: app!,
        version,
        prevResult: { testResults },
        hint,
      });
      const compiled = {
        binary: revised.code,
        size: Buffer.byteLength(revised.code),
      };
      const problem = validateCode(
        compiled.binary,
        version.runtime || "javascript",
      );
      const newVersion: Version = {
        id: id("ver"),
        appId: app!.id,
        runtime: version.runtime || "javascript",
        language: version.language || "javascript",
        number: store.versions.filter((v) => v.appId === app!.id).length + 1,
        status: problem ? "needs_revision" : "ready",
        source: revised.source,
        summary: revised.summary,
        code: compiled.binary,
        codeSha256: sha(compiled.binary),
        inputSchema: null,
        outputSchema: null,
        tests: revised.tests,
        validationError: problem || null,
        revisedFrom: version.id,
        createdAt: now(),
      };
      store.versions.push(newVersion);
      app!.draftVersionId = newVersion.id;
      app!.updatedAt = now();
      store.modelCalls.push({
        id: id("model"),
        appId: app!.id,
        versionId: newVersion.id,
        provider: revised.source,
        model: revised.model,
        usage: revised.usage as Record<string, unknown> | null,
        estimatedCost: null,
        createdAt: now(),
      });
      await save();
      if (!problem) {
        for (const test of revised.tests)
          await execute(newVersion, test.input ?? {}, "generated_test");
      }
      json(res, 201, { version: newVersion, prevTestResults: testResults });
    })().catch((e) =>
      error(res, 502, "MODEL_ERROR", `Revision failed: ${e.message}`),
    );
    return true;
  }

  return false;
}
