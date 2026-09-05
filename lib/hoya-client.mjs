import { createHash } from 'node:crypto';
export const limits = { timeoutMs: 3000, memoryMb: 32, maxLogBytes: 65536, maxResultBytes: 1048576 };
export const artifactHash = (code, runtime) => createHash('sha256').update(runtime === 'wasm' ? Buffer.from(code, 'base64') : code).digest('hex');
export class EngineError extends Error {
  constructor(code, message, retryable = false) { super(message); Object.assign(this, { code, retryable }); }
}
const config = () => {
  const url = new URL(process.env.HOYA_URL || 'http://127.0.0.1:3000');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new EngineError('ENGINE_CONFIG', 'HOYA_URL must be an HTTP(S) URL without credentials');
  if (!process.env.HOYA_AUTH_TOKEN) throw new EngineError('ENGINE_CONFIG', 'Set HOYA_AUTH_TOKEN to match the independent Hoya service');
  return url;
};
async function readResponse(response) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new EngineError('ENGINE_PROTOCOL', 'Engine response exceeded size limit'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new EngineError('ENGINE_PROTOCOL', 'Engine returned invalid JSON'); }
}
export async function engineStatus() {
  try {
    const response = await fetch(new URL('/v1/capabilities', config()), { signal: AbortSignal.timeout(1500), redirect: 'error' });
    const data = await readResponse(response);
    if (!response.ok || !data.protocolVersions?.includes('1') || data.wasmAbi !== 'hoya-json-v1' || !['javascript', 'wasm'].every(r => data.runtimes?.includes(r))) throw new EngineError('ENGINE_INCOMPATIBLE', 'Hoya execution v1 with JS and WASM is required');
    return { status: 'ready', ...data };
  } catch (error) { return { status: 'unavailable', error: { code: error.code || 'ENGINE_UNAVAILABLE', message: error instanceof EngineError ? error.message : 'Cannot reach Hoya', retryable: !(error instanceof EngineError) } }; }
}
export async function executeWithHoya(version, input, runId) {
  const status = await engineStatus();
  if (status.status !== 'ready') throw new EngineError(status.error.code, status.error.message, status.error.retryable);
  const runtime = version.runtime || 'javascript';
  const hash = artifactHash(version.code, runtime);
  if (version.codeSha256 !== hash) throw new EngineError('ARTIFACT_HASH_MISMATCH', 'Stored artifact does not match its immutable hash; upload a new verified version');
  const request = { protocolVersion: '1', runId, runtime, code: version.code, artifactSha256: hash, input, limits, capabilities: { network: [] } };
  let response;
  try { response = await fetch(new URL('/v1/executions', config()), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.HOYA_AUTH_TOKEN}` }, body: JSON.stringify(request), signal: AbortSignal.timeout(limits.timeoutMs + 1500), redirect: 'error' }); }
  catch { throw new EngineError('ENGINE_UNAVAILABLE', 'Hoya request failed; query this run before retrying', true); }
  const data = await readResponse(response);
  if (response.status === 401) throw new EngineError('ENGINE_AUTH', 'Hoya rejected the configured credential');
  const statuses = ['succeeded', 'failed', 'timed_out', 'rejected', 'internal_error'];
  if (data.protocolVersion !== '1' || data.runId !== runId || data.artifactSha256 !== hash || !statuses.includes(data.status) || !Array.isArray(data.logs) || !Number.isFinite(data.metrics?.durationMs) || !Object.hasOwn(data, 'result') || (data.status === 'succeeded' ? data.error !== null : typeof data.error?.code !== 'string')) throw new EngineError('ENGINE_PROTOCOL', 'Hoya returned a mismatched or invalid execution response');
  if (!response.ok && data.status === 'succeeded') throw new EngineError('ENGINE_PROTOCOL', 'Hoya HTTP status contradicts execution success');
  return data;
}
