import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm, rename } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { artifactHash, engineStatus, executeWithHoya } from './lib/hoya-client.mjs';

const root = resolve(process.cwd());
const staticDir = join(root, 'dist');
const dataFile = resolve(process.env.HOSTA_DATA_FILE || join(root, 'data', 'hosta.json'));
const port = Number(process.env.PORT || 4173);
const now = () => new Date().toISOString();
const rustStarter = "#![no_std]\n#![no_main]\n\n#[link(wasm_import_module = \"env\")]\nunsafe extern \"C\" {\n    fn get_input(ptr: *mut u8, capacity: u32) -> u32;\n}\nstatic mut OUTPUT: [u8; 1048577] = [0; 1048577];\n#[unsafe(no_mangle)]\npub extern \"C\" fn hoya_main() -> i32 {\n    unsafe {\n        let ptr = core::ptr::addr_of_mut!(OUTPUT).cast::<u8>();\n        let len = get_input(ptr, 1048576);\n        *ptr.add(len as usize) = 0;\n        ptr as i32\n    }\n}\n#[panic_handler]\nfn panic(_: &core::panic::PanicInfo) -> ! { loop {} }\n";
const moonStarter = `pub fn run() -> Int {\n  42\n}\n`;

async function loadStore() {
  try { return JSON.parse(await readFile(dataFile, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { apps: [], versions: [], deployments: [], runs: [] };
  }
}
let store = await loadStore();
store.schedules ??= [];
store.modelCalls ??= [];
store.idempotency ??= [];
let serial = Promise.resolve();
function save() {
  serial = serial.catch(() => {}).then(async () => {
    await mkdir(dirname(dataFile), { recursive: true });
    await writeFile(`${dataFile}.tmp`, JSON.stringify(store, null, 2));
    await rename(`${dataFile}.tmp`, dataFile);
  });
  return serial;
}
function id(prefix) { return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`; }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function error(res, status, code, message) { json(res, status, { error: { code, message } }); }
async function body(req) {
  if (Object.hasOwn(req, 'parsedBody')) return req.parsedBody;
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 2_097_152) { const error = new Error('Request body exceeds 2 MiB'); error.status = 413; throw error; } chunks.push(chunk); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const err = new Error('Body must be valid JSON'); err.status = 400; throw err; }
}
function appById(appId) { return store.apps.find((item) => item.id === appId); }
function appByCode(code) { return store.apps.find((item) => item.code === code); }
function appCode(name) {
  const base = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'app';
  const prefix = `fn-${base}`; let candidate = prefix; let suffix = 2;
  while (appByCode(candidate)) candidate = `${prefix}-${suffix++}`;
  return candidate;
}
let migratedAppCodes = false;
for (const app of store.apps) {
  if (!app.code) { app.code = appCode(app.name); migratedAppCodes = true; }
  app.runtime ??= 'javascript';
}
if (migratedAppCodes) await save();
function versionById(versionId) { return store.versions.find((item) => item.id === versionId); }
function deploymentById(deploymentId) { return store.deployments.find((item) => item.id === deploymentId); }
function scheduleById(scheduleId) { return store.schedules.find((item) => item.id === scheduleId); }
function publicApp(app) {
  const draft = app.draftVersionId ? versionById(app.draftVersionId) : null;
  const published = app.publishedVersionId ? versionById(app.publishedVersionId) : null;
  return { ...app, draftVersion: draft, publishedVersion: published, deployments: store.deployments.filter((d) => d.appId === app.id).map(({ keyHash, ...d }) => d), schedules: store.schedules.filter((s) => s.appId === app.id), modelCalls: store.modelCalls.filter((call) => call.appId === app.id).slice(-10).reverse(), runs: store.runs.filter((r) => r.appId === app.id).slice(-20).reverse() };
}
function validateCode(code, runtime = 'javascript') {
  if (typeof code !== 'string' || code.length === 0 || Buffer.byteLength(code) > (runtime === 'wasm' ? 1398104 : 131072)) return 'Artifact exceeds the supported source/binary size limit';
  if (runtime === 'wasm') {
    const bytes = Buffer.from(code, 'base64');
    return bytes.toString('base64') === code && bytes.subarray(0, 8).equals(Buffer.from([0,97,115,109,1,0,0,0])) ? null : 'Expected canonical base64 WASM bytes; ABI validation occurs in Hoya';
  }
  if (!/(?:async\s+)?function\s+main\s*\(/.test(code)) return 'Code must define function main(input, ctx)';
  if (/\b(require|process|globalThis|import\s*\(|child_process|fs|eval|Function)\b/.test(code)) return 'Code contains a forbidden host capability';
  return null;
}
function diagnosticsFor(code, runtime = 'javascript') {
  const diagnostics = [];
  const policyError = validateCode(code, runtime);
  if (policyError) diagnostics.push({ severity: 'error', code: 'POLICY_REJECTED', message: policyError });
  else {
    if (runtime === 'wasm') diagnostics.push({ severity: 'info', code: 'WASM_ISOLATION', message: 'WASM 由独立 Hoya 校验并执行 hoya-json-v1 ABI。' });
    else if (!/ctx\.log\s*\(/.test(code)) diagnostics.push({ severity: 'info', code: 'NO_STRUCTURED_LOGS', message: '建议在关键分支调用 ctx.log，便于定位线上输入问题。' });
    if (!/return\s+/.test(code)) diagnostics.push({ severity: 'warning', code: 'NO_EXPLICIT_RETURN', message: '未发现显式 return，Webhook 可能只返回 null。' });
  }
  return diagnostics;
}
function sampleCode(description = '') {
  const lower = description.toLowerCase();
  if (lower.includes('汇总') || lower.includes('sum') || lower.includes('total')) {
    return `async function main(input, ctx) {\n  const items = Array.isArray(input.items) ? input.items : [];\n  const total = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);\n  ctx.log('info', 'Calculated item total', { count: items.length });\n  return { total, count: items.length };\n}`;
  }
  return `async function main(input, ctx) {\n  ctx.log('info', 'Hosta function started');\n  return { ok: true, received: input };\n}`;
}
function runCommand(command, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(rejectRun, new Error(`${command} exceeded the 15 second compilation limit`)); }, 15000);
    child.on('error', (err) => finish(rejectRun, err));
    child.on('close', (code) => finish(code === 0 ? resolveRun : rejectRun, code === 0 ? output : new Error(output.slice(-6000) || `${command} exited with ${code}`)));
  });
}
async function compileWasm(language, source) {
  if (process.env.HOSTA_ENABLE_LOCAL_COMPILER !== '1') { const error = new Error('Upload precompiled WASM with encoding=base64; local source compilation requires HOSTA_ENABLE_LOCAL_COMPILER=1 for trusted sources'); error.status = 400; throw error; }
  const workdir = await mkdtemp(join(tmpdir(), 'hosta-compile-'));
  try {
    let outputFile;
    if (language === 'moonbit') {
      await writeFile(join(workdir, 'moon.mod.json'), JSON.stringify({ name: 'hosta/runner', version: '0.1.0' }));
      await writeFile(join(workdir, 'moon.pkg.json'), JSON.stringify({ name: 'hosta/runner', link: { wasm: { exports: ['run:main'] } } }));
      await writeFile(join(workdir, 'main.mbt'), source);
      await runCommand('moon', ['build', '--target', 'wasm', '--release'], workdir);
      outputFile = join(workdir, '_build/wasm/release/build/runner.wasm');
    } else {
      outputFile = join(workdir, 'module.wasm'); await writeFile(join(workdir, 'main.rs'), source);
      await runCommand('rustc', ['+stable', '--target', 'wasm32-unknown-unknown', '-O', '--crate-type', 'cdylib', 'main.rs', '-o', 'module.wasm'], workdir);
    }
    const wasm = await readFile(outputFile);
    return { binary: wasm.toString('base64'), size: wasm.length };
  } catch (error) { const wrapped = new Error(`Compilation failed: ${String(error.message).slice(0, 6000)}`); wrapped.status = 400; throw wrapped; }
  finally { await rm(workdir, { recursive: true, force: true }); }
}
async function deepSeekGenerate({ description, sampleInput, runtime = 'javascript' }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (runtime === 'wasm') return { source: 'local-demo', summary: 'WASM 示例已生成。编辑区保存 Rust 或 MoonBit 源码，发布前会由系统编译。', code: null, tests: [{ input: sampleInput ?? {}, expectedStatus: 'succeeded' }], usage: null, model: null };
  if (!apiKey) return { source: 'local-demo', summary: '本地演示生成器：已生成可试运行的 JavaScript。配置 DEEPSEEK_API_KEY 后将调用 DeepSeek。', code: sampleCode(description), tests: [{ input: sampleInput ?? {}, expectedStatus: 'succeeded' }], usage: null, model: null };
  const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const prompt = `You generate a small Hosta JavaScript function. Return JSON only with keys summary, code, tests. code must define: async function main(input, ctx). No imports, require, process, eval, Function, network, or markdown. Return JSON-serializable data. tests is an array of {input}. User request: ${description}\nSample input: ${JSON.stringify(sampleInput ?? {})}`;
  const response = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, temperature: 0.2, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`DeepSeek returned HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek returned no content');
  const cleaned = content.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  const generated = JSON.parse(cleaned);
  if (typeof generated.summary !== 'string' || typeof generated.code !== 'string') throw new Error('DeepSeek response does not match the Hosta generation schema');
  return { source: 'deepseek', summary: generated.summary, code: generated.code, tests: Array.isArray(generated.tests) && generated.tests.length ? generated.tests.slice(0, 3) : [{ input: sampleInput ?? {} }], usage: payload.usage ?? null, model };
}
async function execute(version, input, trigger) {
  const run = { id: id('run'), appId: version.appId, versionId: version.id, trigger, status: 'running', input, logs: [], createdAt: now(), startedAt: now() };
  store.runs.push(run); await save();
  const start = performance.now();
  try {
    const value = await executeWithHoya(version, input, run.id);
    Object.assign(run, { status: value.status, result: value.result, logs: value.logs, error: value.error, metrics: value.metrics, artifactSha256: value.artifactSha256, protocolVersion: value.protocolVersion });
  } catch (err) {
    run.status = 'internal_error';
    run.error = { code: err.code || 'PLATFORM_ERROR', message: err.message, retryable: Boolean(err.retryable) };
  } finally { run.finishedAt = now(); run.durationMs = Math.round(performance.now() - start); await save(); }
  return run;
}
const scheduleTimers = new Map();
function armSchedule(schedule) {
  const old = scheduleTimers.get(schedule.id); if (old) clearTimeout(old);
  if (schedule.status !== 'active') return;
  const due = Date.parse(schedule.nextRunAt || now());
  const delay = Math.max(0, Math.min(2_147_000_000, due - Date.now()));
  scheduleTimers.set(schedule.id, setTimeout(async () => {
    const latest = scheduleById(schedule.id); const version = latest && versionById(latest.versionId);
    if (!latest || latest.status !== 'active' || !version) return;
    const run = await execute(version, latest.input, 'schedule');
    latest.lastRunId = run.id; latest.lastRunAt = now(); latest.nextRunAt = new Date(Date.now() + latest.intervalSeconds * 1000).toISOString(); await save(); armSchedule(latest);
  }, delay));
}
function armAllSchedules() { for (const schedule of store.schedules) armSchedule(schedule); }
function contentType(file) { return extname(file) === '.css' ? 'text/css; charset=utf-8' : extname(file) === '.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'; }
async function staticFile(res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = resolve(staticDir, requested);
  if (!file.startsWith(`${staticDir}/`) && file !== join(staticDir, 'index.html')) return false;
  try { const data = await readFile(file); res.writeHead(200, { 'content-type': contentType(file) }); res.end(data); return true; } catch { return false; }
}
async function dispatch(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/') && process.env.HOSTA_API_TOKEN && req.headers.authorization !== `Bearer ${process.env.HOSTA_API_TOKEN}`) return error(res, 401, 'UNAUTHORIZED', 'A valid management API token is required');
  try {
    if (req.method === 'GET' && url.pathname === '/llms.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`# Hosta API

Hosta creates and hosts short JavaScript or WebAssembly functions.

## Discovery
- GET /api/apps lists applications, versions, deployments and recent runs.
- GET /api/apps/:id retrieves an application.
- GET /health reports service health.

## Create and run
- POST /api/apps body: {name, description, sampleInput, runtime: "javascript" | "wasm", language?: "rust" | "moonbit"}.
- POST /api/apps/:id/versions accepts {code,runtime,encoding?: "base64"}; WASM uses precompiled bytes, JS uses UTF-8 source.
- GET /api/status reports actual Hoya readiness; GET /api/apps/:id/versions lists immutable versions.
- GET /api/runs supports appId/versionId/status/trigger filters and offset/limit.
- CLI: node bin/hosta.mjs --help provides non-interactive commands and JSON output.
- POST /api/apps/:id/generate is optional; no AI is required for version upload.
- POST /api/versions/:id/run body: JSON input.
- POST /api/versions/:id/diagnose body: JSON input.

## Publish and invoke
- POST /api/apps/:id/publish after a successful manual run.
- POST /invoke/:appCode with Authorization: Bearer <deployment key> invokes the published version.
- DELETE /api/apps/:id deletes an application, versions, deployments, schedules and runs.

## Runtime contracts
- javascript: define async function main(input, ctx).
- wasm: upload canonical base64 bytes with encoding=base64, exporting memory and hoya_main() -> i32 (pointer to NUL-terminated JSON).
- MoonBit ABI support is not yet verified.
- Hoya executes immutable artifacts; artifact hashes cover decoded WASM bytes or UTF-8 JS source.
`);
    }
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'healthy', service: 'hosta', generator: process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'local-demo' });
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { service: 'hosta', engine: await engineStatus(), generator: process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'local-demo', localCompilerEnabled: process.env.HOSTA_ENABLE_LOCAL_COMPILER === '1' });
    const versionsList = url.pathname.match(/^\/api\/apps\/([^/]+)\/versions$/);
    if (req.method === 'GET' && versionsList) {
      if (!appById(versionsList[1])) return error(res, 404, 'NOT_FOUND', 'App not found');
      return json(res, 200, store.versions.filter(v => v.appId === versionsList[1]));
    }
    if (req.method === 'GET' && url.pathname === '/api/runs') {
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 20);
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) return error(res, 400, 'VALIDATION_ERROR', 'Invalid pagination');
      const items = store.runs.filter(r => ['appId','versionId','status','trigger'].every(k => !url.searchParams.has(k) || r[k] === url.searchParams.get(k))).slice().reverse();
      return json(res, 200, { items: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : null });
    }
    if (req.method === 'GET' && url.pathname === '/api/apps') return json(res, 200, store.apps.map(publicApp));
    if (req.method === 'POST' && url.pathname === '/api/apps') {
      const input = await body(req); if (!String(input.name || '').trim() || !String(input.description || '').trim()) return error(res, 400, 'VALIDATION_ERROR', 'Name and description are required');
      const runtime = input.runtime === 'wasm' ? 'wasm' : 'javascript'; const language = runtime === 'wasm' && input.language === 'moonbit' ? 'moonbit' : runtime === 'wasm' ? 'rust' : 'javascript'; const name = String(input.name).trim().slice(0, 120);
      const app = { id: id('app'), code: appCode(name), name, description: String(input.description).trim().slice(0, 4000), runtime, language, sampleInput: input.sampleInput ?? {}, draftVersionId: null, publishedVersionId: null, createdAt: now(), updatedAt: now() };
      store.apps.push(app); await save(); return json(res, 201, publicApp(app));
    }
    const versionCreateMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/versions$/);
    if (req.method === 'POST' && versionCreateMatch) {
      const app = appById(versionCreateMatch[1]); if (!app) return error(res, 404, 'NOT_FOUND', 'App not found'); const payload = await body(req); const code = String(payload.code || '');
      const runtime = payload.runtime === 'wasm' ? 'wasm' : (app.runtime || 'javascript'); const language = runtime === 'wasm' && payload.language === 'moonbit' ? 'moonbit' : runtime === 'wasm' ? 'rust' : 'javascript';
      const compiled = runtime === 'wasm' && payload.encoding !== 'base64' ? await compileWasm(language, code) : { binary: code, size: runtime === 'wasm' ? Buffer.from(code, 'base64').length : Buffer.byteLength(code) }; const diagnostics = diagnosticsFor(compiled.binary, runtime); const hasError = diagnostics.some((item) => item.severity === 'error');
      const version = { id: id('ver'), appId: app.id, runtime, language, sourceCode: runtime === 'wasm' && payload.encoding !== 'base64' ? code : undefined, wasmSize: runtime === 'wasm' ? compiled.size : undefined, number: store.versions.filter((v) => v.appId === app.id).length + 1, status: hasError ? 'needs_revision' : 'ready', source: 'manual-edit', summary: String(payload.summary || '用户编辑的程序版本').slice(0, 500), code: compiled.binary, codeSha256: artifactHash(compiled.binary, runtime), tests: [], validationError: diagnostics.find((item) => item.severity === 'error')?.message || null, diagnostics, createdAt: now() };
      store.versions.push(version); app.draftVersionId = version.id; app.updatedAt = now(); await save(); return json(res, 201, version);
    }
    const generateMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/generate$/);
    if (req.method === 'POST' && generateMatch) {
      const app = appById(generateMatch[1]); if (!app) return error(res, 404, 'NOT_FOUND', 'App not found');
      const runtime = app.runtime || 'javascript'; const language = app.language || 'javascript'; const generated = await deepSeekGenerate({ description: app.description, sampleInput: app.sampleInput, runtime });
      const sourceCode = runtime === 'wasm' ? (language === 'moonbit' ? moonStarter : rustStarter) : generated.code; const compiled = runtime === 'wasm' ? await compileWasm(language, sourceCode) : { binary: generated.code, size: Buffer.byteLength(generated.code) }; const problem = validateCode(compiled.binary, runtime);
      const version = { id: id('ver'), appId: app.id, runtime, language, sourceCode: runtime === 'wasm' ? sourceCode : undefined, wasmSize: runtime === 'wasm' ? compiled.size : undefined, number: store.versions.filter((v) => v.appId === app.id).length + 1, status: problem ? 'needs_revision' : 'ready', source: generated.source, summary: generated.summary, code: compiled.binary, codeSha256: artifactHash(compiled.binary, runtime), tests: generated.tests, validationError: problem || null, createdAt: now() };
      store.versions.push(version); app.draftVersionId = version.id; app.updatedAt = now(); await save();
      store.modelCalls.push({ id: id('model'), appId: app.id, versionId: version.id, provider: generated.source, model: generated.model, usage: generated.usage, estimatedCost: null, createdAt: now() }); await save();
      if (!problem) { for (const test of generated.tests) await execute(version, test.input ?? {}, 'generated_test'); }
      return json(res, 201, version);
    }
    const runMatch = url.pathname.match(/^\/api\/versions\/([^/]+)\/run$/);
    if (req.method === 'POST' && runMatch) { const version = versionById(runMatch[1]); if (!version) return error(res, 404, 'NOT_FOUND', 'Version not found'); const input = await body(req); return json(res, 201, await execute(version, input, 'manual')); }
    const diagnoseMatch = url.pathname.match(/^\/api\/versions\/([^/]+)\/diagnose$/);
    if (req.method === 'POST' && diagnoseMatch) {
      const version = versionById(diagnoseMatch[1]); if (!version) return error(res, 404, 'NOT_FOUND', 'Version not found'); const input = await body(req); const diagnostics = diagnosticsFor(version.code, version.runtime || 'javascript'); const run = diagnostics.some((item) => item.severity === 'error') ? null : await execute(version, input, 'diagnostic');
      if (run?.status !== 'succeeded') diagnostics.push({ severity: 'error', code: run?.error?.code || 'EXECUTION_FAILED', message: run?.error?.message || 'Execution did not complete', runId: run?.id });
      else diagnostics.push({ severity: 'info', code: 'EXECUTION_SUCCEEDED', message: `样例执行成功，耗时 ${run.durationMs} ms。`, runId: run.id });
      return json(res, 200, { versionId: version.id, diagnostics, run });
    }
    const publishMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/publish$/);
    if (req.method === 'POST' && publishMatch) {
      const app = appById(publishMatch[1]); if (!app) return error(res, 404, 'NOT_FOUND', 'App not found'); const payload = await body(req); const version = versionById(payload.versionId);
      if (!version || version.appId !== app.id || version.status !== 'ready') return error(res, 400, 'NOT_PUBLISHABLE', 'A ready version is required');
      if (!store.runs.some((run) => run.versionId === version.id && run.trigger === 'manual' && run.status === 'succeeded')) return error(res, 400, 'TRIAL_REQUIRED', 'Run this exact version successfully via CLI/API before publishing');
      let deployment = store.deployments.find((d) => d.appId === app.id); const webhookKey = deployment ? undefined : randomBytes(24).toString('base64url');
      if (!deployment) { deployment = { id: id('dep'), appId: app.id, createdAt: now() }; store.deployments.push(deployment); }
      Object.assign(deployment, { versionId: version.id, status: 'active', ...(webhookKey ? { keyHash: sha(webhookKey) } : {}), updatedAt: now() }); app.publishedVersionId = version.id; app.updatedAt = now(); await save();
      return json(res, 200, { deployment: { ...deployment, keyHash: undefined }, webhookKey, webhookUrl: `/hooks/${deployment.id}` });
    }
    const scheduleMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/schedules$/);
    if (req.method === 'POST' && scheduleMatch) {
      const app = appById(scheduleMatch[1]); if (!app) return error(res, 404, 'NOT_FOUND', 'App not found'); const payload = await body(req);
      const version = versionById(payload.versionId || app.publishedVersionId || app.draftVersionId); const intervalSeconds = Number(payload.intervalSeconds);
      if (!version || version.appId !== app.id || version.status !== 'ready') return error(res, 400, 'NOT_SCHEDULABLE', 'A ready version is required');
      if (!Number.isInteger(intervalSeconds) || intervalSeconds < 60 || intervalSeconds > 86400) return error(res, 400, 'VALIDATION_ERROR', 'Interval must be between 60 and 86400 seconds');
      const schedule = { id: id('sch'), appId: app.id, versionId: version.id, input: payload.input ?? app.sampleInput ?? {}, intervalSeconds, status: 'active', createdAt: now(), nextRunAt: new Date(Date.now() + intervalSeconds * 1000).toISOString(), lastRunAt: null, lastRunId: null };
      store.schedules.push(schedule); await save(); armSchedule(schedule); return json(res, 201, schedule);
    }
    const scheduleDeleteMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)$/);
    if (req.method === 'DELETE' && scheduleDeleteMatch) { const schedule = scheduleById(scheduleDeleteMatch[1]); if (!schedule) return error(res, 404, 'NOT_FOUND', 'Schedule not found'); schedule.status = 'disabled'; const timer = scheduleTimers.get(schedule.id); if (timer) clearTimeout(timer); scheduleTimers.delete(schedule.id); await save(); return json(res, 200, schedule); }
    const hookMatch = url.pathname.match(/^\/hooks\/([^/]+)$/);
    if (req.method === 'POST' && hookMatch) {
      const deployment = deploymentById(hookMatch[1]); if (!deployment || deployment.status !== 'active') return error(res, 404, 'NOT_FOUND', 'Deployment not found');
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); if (!token || sha(token) !== deployment.keyHash) return error(res, 401, 'UNAUTHORIZED', 'A valid Bearer key is required');
      const version = versionById(deployment.versionId); return json(res, 200, await execute(version, await body(req), 'webhook'));
    }
    const invokeMatch = url.pathname.match(/^\/invoke\/([a-z0-9-]+)$/);
    if (req.method === 'POST' && invokeMatch) {
      const app = appByCode(invokeMatch[1]); const deployment = app && store.deployments.find((item) => item.appId === app.id && item.status === 'active');
      if (!deployment) return error(res, 404, 'NOT_FOUND', 'Published application not found'); const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); if (!token || sha(token) !== deployment.keyHash) return error(res, 401, 'UNAUTHORIZED', 'A valid Bearer key is required');
      return json(res, 200, await execute(versionById(deployment.versionId), await body(req), 'invoke'));
    }
    const appMatch = url.pathname.match(/^\/api\/apps\/([^/]+)$/);
    if (req.method === 'GET' && appMatch) { const app = appById(appMatch[1]); return app ? json(res, 200, publicApp(app)) : error(res, 404, 'NOT_FOUND', 'App not found'); }
    if (req.method === 'DELETE' && appMatch) {
      const app = appById(appMatch[1]); if (!app) return error(res, 404, 'NOT_FOUND', 'App not found');
      for (const schedule of store.schedules.filter((item) => item.appId === app.id)) { const timer = scheduleTimers.get(schedule.id); if (timer) clearTimeout(timer); scheduleTimers.delete(schedule.id); }
      store.apps = store.apps.filter((item) => item.id !== app.id); store.versions = store.versions.filter((item) => item.appId !== app.id); store.deployments = store.deployments.filter((item) => item.appId !== app.id); store.schedules = store.schedules.filter((item) => item.appId !== app.id); store.runs = store.runs.filter((item) => item.appId !== app.id); store.modelCalls = store.modelCalls.filter((item) => item.appId !== app.id); await save(); return json(res, 200, { deleted: app.id });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/runs/')) { const run = store.runs.find((r) => r.id === url.pathname.split('/').pop()); return run ? json(res, 200, run) : error(res, 404, 'NOT_FOUND', 'Run not found'); }
    if (req.method === 'GET' && await staticFile(res, url.pathname)) return;
    error(res, 404, 'NOT_FOUND', 'Route not found');
  } catch (err) { console.error(err); error(res, err.status || 500, 'INTERNAL_ERROR', err.message || 'Unexpected error'); }
 }
// A key with an uncertain outcome is never replayed as a fresh write after restart.
// Completed records are retained for 24h; at capacity reject new keys rather than evict live records.
const inFlight = new Map();
const server = createServer(async (req, res) => {
  const key = req.headers['idempotency-key'];
  if (!key) return dispatch(req, res);
  try {
    if (process.env.HOSTA_API_TOKEN && req.headers.authorization !== `Bearer ${process.env.HOSTA_API_TOKEN}`) return error(res, 401, 'UNAUTHORIZED', 'A valid management API token is required');
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method !== 'POST' || !/^\/api\/apps(?:\/[^/]+\/versions)?$/.test(path)) return error(res, 400, 'IDEMPOTENCY_UNSUPPORTED', 'Keys are supported only for app/version creation');
    if (typeof key !== 'string' || key.length < 1 || key.length > 128) return error(res, 400, 'INVALID_KEY', 'Idempotency key must be 1..128 characters');
    req.parsedBody = await body(req);
    const fingerprint = sha(JSON.stringify({ path, body: req.parsedBody }));
    store.idempotency = store.idempotency.filter(r => r.state === 'pending' || Date.now() - r.createdAt < 86400000);
    const existing = store.idempotency.find(r => r.key === key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return error(res, 409, 'IDEMPOTENCY_CONFLICT', 'Key was used for a different request');
      if (inFlight.has(key)) await inFlight.get(key);
      if (existing.state !== 'completed') return error(res, 409, 'OUTCOME_UNKNOWN', 'Query app/version state before choosing a new key');
      return json(res, existing.httpStatus, existing.response);
    }
    if (store.idempotency.length >= 1000) return error(res, 503, 'IDEMPOTENCY_CAPACITY', 'Idempotency record capacity reached');
    const record = { key, fingerprint, state: 'pending', createdAt: Date.now() };
    store.idempotency.push(record);
    let release; const pending = new Promise(resolve => { release = resolve; }); inFlight.set(key, pending);
    try {
      await save();
      const result = await new Promise((resolveResult, rejectResult) => {
        let httpStatus = 200;
        const capture = { writeHead(status) { httpStatus = status; }, end(bytes) { resolveResult({ httpStatus, response: JSON.parse(bytes) }); } };
        dispatch(req, capture).catch(rejectResult);
      });
      Object.assign(record, result, { state: 'completed' }); await save();
      return json(res, result.httpStatus, result.response);
    } finally { inFlight.delete(key); release(); }
  } catch { return error(res, 500, 'PLATFORM_ERROR', 'Cannot persist idempotent operation; query state before retrying'); }
});

server.listen(port, '127.0.0.1', () => { armAllSchedules(); console.log(`Hosta listening on http://127.0.0.1:${server.address().port}`); });
