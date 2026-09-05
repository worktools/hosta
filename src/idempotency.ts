import type {IncomingMessage,ServerResponse} from 'node:http';
import {store as data,save} from './store.js';
import {sha,body,json,error} from './utils.js';
interface IdempotencyRecord {key:string;fingerprint:string;state:string;createdAt:number;httpStatus?:number;response?:unknown;}
const store=data as typeof data & {idempotency:IdempotencyRecord[]};
store.idempotency ??= [];
const inFlight = new Map<string, Promise<void>>();
export function withIdempotency(dispatch: (req: IncomingMessage,res:ServerResponse)=>Promise<void>) {
return async (req:IncomingMessage,res:ServerResponse) => {
  const key = req.headers['idempotency-key'];
  if (!key) return dispatch(req, res);
  try {
    if (process.env.HOSTA_API_TOKEN && req.headers.authorization !== `Bearer ${process.env.HOSTA_API_TOKEN}`) return error(res, 401, 'UNAUTHORIZED', 'A valid management API token is required');
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (req.method !== 'POST' || !/^\/api\/apps(?:\/[^/]+\/versions)?$/.test(path)) return error(res, 400, 'IDEMPOTENCY_UNSUPPORTED', 'Keys are supported only for app/version creation');
    if (typeof key !== 'string' || key.length < 1 || key.length > 128) return error(res, 400, 'INVALID_KEY', 'Idempotency key must be 1..128 characters');
    (req as IncomingMessage & {parsedBody: unknown}).parsedBody = await body(req);
    const fingerprint = sha(JSON.stringify({ path, body: (req as IncomingMessage & {parsedBody: unknown}).parsedBody }));
    store.idempotency = store.idempotency.filter(r => r.state === 'pending' || Date.now() - r.createdAt < 86400000);
    const existing = store.idempotency.find(r => r.key === key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return error(res, 409, 'IDEMPOTENCY_CONFLICT', 'Key was used for a different request');
      if (inFlight.has(key)) await inFlight.get(key);
      if (existing.state !== 'completed') return error(res, 409, 'OUTCOME_UNKNOWN', 'Query app/version state before choosing a new key');
      return json(res, existing.httpStatus!, existing.response);
    }
    if (store.idempotency.length >= 1000) return error(res, 503, 'IDEMPOTENCY_CAPACITY', 'Idempotency record capacity reached');
    const record: IdempotencyRecord = { key, fingerprint, state: 'pending', createdAt: Date.now() };
    store.idempotency.push(record);
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); inFlight.set(key, pending);
    try {
      await save();
      const result = await new Promise<{httpStatus:number;response:unknown}>((resolveResult, rejectResult) => {
        let httpStatus = 200;
        const capture = { writeHead(status:number) { httpStatus = status; }, end(bytes:string) { resolveResult({ httpStatus, response: JSON.parse(bytes) }); } };
        dispatch(req, capture as unknown as ServerResponse).catch(rejectResult);
      });
      Object.assign(record, result, { state: 'completed' }); await save();
      return json(res, result.httpStatus, result.response);
    } finally { inFlight.delete(key); release(); }
  } catch { return error(res, 500, 'PLATFORM_ERROR', 'Cannot persist idempotent operation; query state before retrying'); }
};
}
