#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
const help = `hosta — non-interactive serverless client (CLI schema 1)

hosta doctor|status
hosta apps create --name NAME [--description TEXT] [--runtime javascript|wasm]
hosta apps list | apps get --app ID
hosta versions upload --app ID --source FILE|- [--runtime javascript|wasm]
hosta versions list --app ID
hosta run --version ID [--input FILE|-] [--wait]
hosta publish --app ID --version ID
hosta invoke --code CODE [--input FILE|-]
hosta runs list [--app ID] [--status STATE] [--offset N] [--limit N]
hosta runs get|logs --run ID [--wait]

--json                  Stable JSON on stdout (also the default)
--url URL               Hosta URL (HOSTA_URL, default http://127.0.0.1:4173)
--timeout MS            Total command deadline, default 10000
--idempotency-key KEY   Supported for apps create and versions upload only
HOSTA_API_TOKEN         Management API credential
HOSTA_WEBHOOK_KEY       Invoke credential, distinct from management token
--help / --version     No service required

WASM --source reads precompiled binary; JS reads UTF-8. --input reads JSON.
No command prompts, starts servers, or retries writes automatically.
run/invoke currently return synchronously; --wait also polls queued run IDs.
Exit codes: 0 success, 1 API error, 2 usage/input, 3 authentication,
4 guest failure, 5 transport/deadline, 6 incompatible API response.
`;
class Failure extends Error {
  constructor(code, message, exit = 1, data = null, retryable = false) { super(message); Object.assign(this, { code, exit, data, retryable }); }
}
async function stdin() { const chunks = []; let size = 0; for await (const chunk of process.stdin) { size += chunk.length; if (size > 1024 * 1024) throw new Failure('INPUT_TOO_LARGE', 'stdin exceeds 1 MiB', 2); chunks.push(chunk); } return Buffer.concat(chunks); }
const options = Object.fromEntries(['url','timeout','name','description','runtime','app','version','source','input','code','run','status','offset','limit','idempotency-key'].map(name => [name, { type: 'string' }]));
Object.assign(options, { json: { type: 'boolean' }, wait: { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'string' } });
async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--version') return { version: '0.1.0', cliSchemaVersion: '1' };
  let args; try { args = parseArgs({ options, allowPositionals: true }); } catch (e) { throw new Failure('USAGE_ERROR', e.message, 2); }
  const v = args.values; const command = args.positionals.join(' ');
  if (v.help || !command) { process.stdout.write(help); return undefined; }
  const required = key => { if (!v[key]) throw new Failure('USAGE_ERROR', `--${key} is required`, 2); return encodeURIComponent(v[key]); };
  const timeout = Number(v.timeout || 10000);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000) throw new Failure('USAGE_ERROR', '--timeout must be 1..300000 ms', 2);
  if (v.source === '-' && v.input === '-') throw new Failure('USAGE_ERROR', 'Only one argument can consume stdin', 2);
  const runtime = v.runtime || 'javascript';
  if (!['javascript','wasm'].includes(runtime)) throw new Failure('USAGE_ERROR', 'Unsupported runtime', 2);
  if (v['idempotency-key'] && !['apps create','versions upload'].includes(command)) throw new Failure('USAGE_ERROR', 'Idempotency is only supported for app/version creation', 2);
  let base; try { base = new URL(v.url || process.env.HOSTA_URL || 'http://127.0.0.1:4173'); } catch { throw new Failure('USAGE_ERROR', 'Invalid service URL', 2); }
  if (!['http:','https:'].includes(base.protocol) || base.username || base.password) throw new Failure('USAGE_ERROR', 'URL must use HTTP(S), without credentials', 2);
  const signal = AbortSignal.timeout(timeout);
  const bytes = async path => { try { const data = path === '-' ? await stdin() : await readFile(path); if (data.length > 1024*1024) throw new Failure('INPUT_TOO_LARGE','File exceeds 1 MiB',2); return data; } catch (e) { if (e instanceof Failure) throw e; throw new Failure('INPUT_ERROR', `Cannot read ${path}`, 2); } };
  const input = async () => { if (!v.input) return {}; try { return JSON.parse((await bytes(v.input)).toString('utf8')); } catch (e) { if (e instanceof Failure) throw e; throw new Failure('INVALID_JSON', 'Input must be valid JSON', 2); } };
  const request = async (path, body, invoke = false) => {
    let response, data;
    const token = invoke ? process.env.HOSTA_WEBHOOK_KEY : process.env.HOSTA_API_TOKEN;
    try {
      response = await fetch(new URL(path, base), { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(v['idempotency-key'] ? { 'idempotency-key': v['idempotency-key'] } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal, redirect: 'error' });
      const chunks=[]; let size=0;
      for await (const chunk of response.body) { size+=chunk.length; if(size>8*1024*1024) throw new Failure('RESPONSE_TOO_LARGE','API response exceeds 8 MiB',6); chunks.push(chunk); }
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Failure('API_PROTOCOL', 'API returned invalid JSON', 6); }
    } catch (e) { if (e instanceof Failure) throw e; throw new Failure(signal.aborted ? 'COMMAND_TIMEOUT' : 'SERVICE_UNAVAILABLE', 'Request could not complete; query state before retrying a write', 5, null, true); }
    if (!response.ok) throw new Failure(data.error?.code || 'API_ERROR', data.error?.message || `HTTP ${response.status}`, [401,403].includes(response.status) ? 3 : 1, null, Boolean(data.error?.retryable));
    return data;
  };
  let data;
  switch (command) {
    case 'doctor': case 'status': data = await request('/api/status'); if (data.engine?.status !== 'ready') throw new Failure(data.engine?.error?.code || 'ENGINE_UNAVAILABLE', data.engine?.error?.message || 'Engine is not ready', 5, data, true); break;
    case 'apps create': required('name'); data = await request('/api/apps', { name: v.name, description: v.description || 'Created via Hosta CLI', runtime }); break;
    case 'apps list': data = await request('/api/apps'); break;
    case 'apps get': data = await request(`/api/apps/${required('app')}`); break;
    case 'versions list': data = await request(`/api/apps/${required('app')}/versions`); break;
    case 'versions upload': {
      const app=required('app'); required('source'); const source=await bytes(v.source);
      data=await request(`/api/apps/${app}/versions`, { code:source.toString(runtime==='wasm'?'base64':'utf8'), runtime, ...(runtime==='wasm'?{encoding:'base64'}:{}) }); break;
    }
    case 'run': data = await request(`/api/versions/${required('version')}/run`, await input()); break;
    case 'publish': data = await request(`/api/apps/${required('app')}/publish`, { versionId: decodeURIComponent(required('version')) }); break;
    case 'invoke': required('code'); if (!process.env.HOSTA_WEBHOOK_KEY) throw new Failure('USAGE_ERROR','Set HOSTA_WEBHOOK_KEY for invoke',2); data=await request(`/invoke/${encodeURIComponent(v.code)}`,await input(),true); break;
    case 'runs list': {
      const query=new URLSearchParams(); for(const [flag,key] of [['app','appId'],['version','versionId'],['status','status'],['offset','offset'],['limit','limit']]) if(v[flag]) query.set(key,v[flag]);
      data=await request(`/api/runs?${query}`); break;
    }
    case 'runs get': case 'runs logs': data=await request(`/api/runs/${required('run')}`); break;
    default: throw new Failure('USAGE_ERROR', `Unknown command: ${command}`, 2);
  }
  while (v.wait && ['queued','running'].includes(data?.status)) {
    if (!data.id) throw new Failure('API_PROTOCOL','Pending execution has no run ID',6);
    const runId=data.id;
    await new Promise((resolve,reject)=>{ if(signal.aborted) return reject(new Failure('COMMAND_TIMEOUT','Query the run ID to resume waiting',5,data,true)); const done=()=>{clearTimeout(timer); signal.removeEventListener('abort',abort); resolve();}; const abort=()=>{clearTimeout(timer); reject(new Failure('COMMAND_TIMEOUT','Query the run ID to resume waiting',5,data,true));}; const timer=setTimeout(done,100); signal.addEventListener('abort',abort,{once:true}); });
    data=await request(`/api/runs/${encodeURIComponent(runId)}`);
  }
  if (['failed','timed_out','rejected','internal_error','needs_revision'].includes(data?.status)) throw new Failure(data.error?.code || 'EXECUTION_FAILED',data.error?.message || data.validationError || 'Execution or validation failed',4,data,Boolean(data.error?.retryable));
  if(command==='runs logs') data={runId:data.id,status:data.status,logs:data.logs};
  return data;
}
try {
  const data=await main();
  if (data !== undefined) process.stdout.write(JSON.stringify({ schemaVersion:'1',status:'succeeded',data,error:null })+'\n');
} catch (e) {
  const failure=e instanceof Failure?e:new Failure('CLI_ERROR','Unexpected client error',1);
  process.stdout.write(JSON.stringify({schemaVersion:'1',status:'failed',data:failure.data,error:{code:failure.code,message:failure.message,retryable:failure.retryable}})+'\n');
  process.exitCode=failure.exit;
}
