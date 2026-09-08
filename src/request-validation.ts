import type { IncomingMessage, ServerResponse } from 'node:http';
import { body, error, requestError } from './utils.js';

/** Parse once before route-specific handlers can misclassify input failures. */
export function withRequestValidation(dispatch: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const path = new URL(req.url || '/', 'http://localhost').pathname;
      // Reject unauthorized management writes before consuming their payload.
      if (path.startsWith('/api/') && process.env.HOSTA_API_TOKEN && req.headers.authorization !== `Bearer ${process.env.HOSTA_API_TOKEN}`)
        return error(res, 401, 'UNAUTHORIZED', 'A valid management API token is required');
      if (['POST', 'PUT', 'PATCH'].includes(req.method || '') && path.startsWith('/api/')) {
        const parsed = await body(req);
        const executionInput = /^\/api\/versions\/[^/]+\/(run|diagnose)$/.test(path) || /^\/api\/apps\/[^/]+\/pages\/[^/]+\/data$/.test(path);
        if (!executionInput && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)))
          return error(res, 400, 'INVALID_REQUEST', 'Management request body must be a JSON object');
        (req as IncomingMessage & { parsedBody: unknown }).parsedBody = parsed;
      }
      await dispatch(req, res);
    } catch (cause) {
      requestError(res, cause as Error & { status?: number });
    }
  };
}
