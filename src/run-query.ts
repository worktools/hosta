import type { Run } from './types.js';

/** Read newest-first, retaining at most one page plus a lookahead match. */
export function queryRuns(runs: Run[], query: URLSearchParams) {
  const offset = Number(query.get('offset') || 0);
  const limit = Number(query.get('limit') || 20);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Invalid pagination');
  const fields = ['appId', 'versionId', 'status', 'trigger'] as const;
  const filters = fields.filter(key => query.has(key)).map(key => [key, query.get(key)] as const);
  const summary = query.get('view') === 'summary';
  const items = [];
  let matched = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (!filters.every(([key, value]) => run[key] === value)) continue;
    if (matched++ < offset) continue;
    if (items.length === limit) return { items, nextOffset: offset + limit };
    items.push(summary ? {
      id: run.id, appId: run.appId, versionId: run.versionId, versionNumber: run.versionNumber,
      status: run.status, trigger: run.trigger, retryOf: run.retryOf ?? null,
      durationMs: run.durationMs, createdAt: run.createdAt, finishedAt: run.finishedAt,
      artifactSha256: run.artifactSha256, errorCode: run.error?.code ?? null,
    } : run);
  }
  return { items, nextOffset: null };
}
