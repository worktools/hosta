import vm from "node:vm";
import type { Version, Diagnostic, QualityScore } from "./types.js";

// ── 代码校验 ──────────────────────────────────────────────────────────────────

export function validateCode(
  code: string,
  runtime = "javascript",
): string | null {
  if (typeof code !== "string" || code.length === 0 || code.length > 131072)
    return "Code must be between 1 and 131072 characters";
  if (runtime === "wasm") {
    try {
      new WebAssembly.Module(Buffer.from(code, "base64"));
      return null;
    } catch {
      return "WASM mode expects a valid base64-encoded WebAssembly module";
    }
  }
  if (!/async\s+function\s+main\s*\(/.test(code))
    return "Code must define async function main(input, ctx)";
  if (
    /\b(require|process|globalThis|import\s*\(|child_process|fs|eval|Function)\b/.test(
      code,
    )
  )
    return "Code contains a forbidden host capability";
  return null;
}

/** 代码质量诊断 */
export function diagnosticsFor(
  code: string,
  runtime = "javascript",
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const policyError = validateCode(code, runtime);
  if (policyError) {
    diagnostics.push({
      severity: "error",
      code: "POLICY_REJECTED",
      message: policyError,
    });
  } else {
    try {
      new vm.Script(`"use strict"; ${code}`);
    } catch (err: any) {
      diagnostics.push({
        severity: "error",
        code: "SYNTAX_ERROR",
        message: String(err.message),
      });
    }
    if (runtime === "wasm") {
      diagnostics.push({
        severity: "info",
        code: "WASM_ISOLATION",
        message:
          "WASM 运行于 JSPI 异步环境；可调用 fetch/log/now/get_input/get_datasource 等 host 函数。",
      });
    } else {
      if (!/ctx\.log\s*\(/.test(code))
        diagnostics.push({
          severity: "info",
          code: "NO_STRUCTURED_LOGS",
          message: "建议在关键分支调用 ctx.log，便于定位线上输入问题。",
        });
      if (!/return\s+/.test(code))
        diagnostics.push({
          severity: "warning",
          code: "NO_EXPLICIT_RETURN",
          message: "未发现显式 return，Webhook 可能只返回 null。",
        });
      if (code.length > 4096)
        diagnostics.push({
          severity: "warning",
          code: "CODE_SIZE",
          message: `代码长度 ${code.length} 字符，建议控制在 4096 以内。`,
        });
      if (!/try\s*\{/.test(code) && !/catch\s*\(/.test(code))
        diagnostics.push({
          severity: "info",
          code: "NO_ERROR_HANDLING",
          message: "建议添加 try-catch 处理异常输入。",
        });
      if (!/input\.\w+/.test(code) && !/input\[/.test(code))
        diagnostics.push({
          severity: "info",
          code: "NO_INPUT_VALIDATION",
          message: "建议验证输入字段是否存在。",
        });
      const loopCount = (code.match(/\b(for|while)\b/g) || []).length;
      if (loopCount > 3)
        diagnostics.push({
          severity: "warning",
          code: "TOO_MANY_LOOPS",
          message: `发现 ${loopCount} 个循环，建议检查时间复杂度。`,
        });
    }
  }
  return diagnostics;
}

/** 计算代码质量评分 0-5 */
export function codeQualityScore(
  diagnostics: Diagnostic[],
  _code = "",
): QualityScore {
  let score = 5;
  const details: string[] = [];
  for (const d of diagnostics) {
    if (d.severity === "error") {
      score -= 2;
      details.push(`❌ ${d.code}: ${d.message}`);
    }
    if (d.severity === "warning") {
      score -= 0.5;
      details.push(`⚠️ ${d.code}: ${d.message}`);
    }
    if (d.severity === "info" && d.code !== "EXECUTION_SUCCEEDED") {
      details.push(`💡 ${d.message}`);
    }
  }
  return { score: Math.max(0, score), maxScore: 5, details };
}

// ── JSON Schema 校验 ──────────────────────────────────────────────────────────

/** JSON Schema 校验器（轻量实现，支持 draft-04 核心关键字） */
export function validateJsonSchema(
  schema: Record<string, unknown>,
  data: unknown,
  path = "$",
): string[] {
  if (!schema || typeof schema !== "object") return [];
  const errors: string[] = [];
  const t = schema.type as string | undefined;
  if (t) {
    const actual = Array.isArray(data)
      ? "array"
      : data === null
        ? "null"
        : typeof data;
    const allowed = Array.isArray(t) ? t : [t];
    if (!allowed.includes(actual)) {
      errors.push(`${path}: expected ${allowed.join("|")}, got ${actual}`);
      return errors;
    }
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some(
      (v: unknown) => JSON.stringify(v) === JSON.stringify(data),
    )
  ) {
    errors.push(`${path}: value must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (t === "string" && typeof data === "string") {
    if (typeof schema.minLength === "number" && data.length < schema.minLength)
      errors.push(
        `${path}: length ${data.length} < minLength ${schema.minLength}`,
      );
    if (typeof schema.maxLength === "number" && data.length > schema.maxLength)
      errors.push(
        `${path}: length ${data.length} > maxLength ${schema.maxLength}`,
      );
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(data))
          errors.push(
            `${path}: "${data}" does not match pattern ${schema.pattern}`,
          );
      } catch {
        /* skip */
      }
    }
  }
  if ((t === "number" || t === "integer") && typeof data === "number") {
    if (t === "integer" && !Number.isInteger(data))
      errors.push(`${path}: expected integer, got ${data}`);
    if (typeof schema.minimum === "number" && data < schema.minimum)
      errors.push(`${path}: ${data} < minimum ${schema.minimum}`);
    if (typeof schema.maximum === "number" && data > schema.maximum)
      errors.push(`${path}: ${data} > maximum ${schema.maximum}`);
  }
  if (
    t === "object" &&
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data)
  ) {
    const properties = schema.properties as Record<string, unknown> | undefined;
    const required = schema.required as string[] | undefined;
    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in (data as Record<string, unknown>)) {
          errors.push(
            ...validateJsonSchema(
              propSchema as Record<string, unknown>,
              (data as Record<string, unknown>)[key],
              `${path}.${key}`,
            ),
          );
        } else if (required?.includes(key)) {
          errors.push(`${path}.${key}: required property missing`);
        }
      }
    }
    if (schema.additionalProperties === false && properties) {
      for (const key of Object.keys(data as Record<string, unknown>)) {
        if (!(key in properties))
          errors.push(`${path}.${key}: additional property not allowed`);
      }
    }
  }
  if (t === "array" && Array.isArray(data)) {
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      for (let i = 0; i < data.length; i++) {
        errors.push(...validateJsonSchema(items, data[i], `${path}[${i}]`));
      }
    }
    if (typeof schema.minItems === "number" && data.length < schema.minItems)
      errors.push(
        `${path}: items count ${data.length} < minItems ${schema.minItems}`,
      );
    if (typeof schema.maxItems === "number" && data.length > schema.maxItems)
      errors.push(
        `${path}: items count ${data.length} > maxItems ${schema.maxItems}`,
      );
  }
  return errors;
}
