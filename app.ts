// The HTTP server: routes one request to the git smart-HTTP surface, the REST v3
// surface, GraphQL, or MCP, all on the same in-memory store. Every JSON reply carries
// a non-empty X-GitHub-Request-Id. Authentication is the Bearer token from
// MAKEFUN_SHOP_TOKEN when the harness sets it; otherwise any non-empty Bearer token
// is accepted. The git surface never requires a token (git clients do not send one).

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, Store } from './store.ts';
import { gitRoute, handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (match === null || match[1] === undefined || match[1] === '') return false;
  if (SHOP_TOKEN !== '') return match[1] === SHOP_TOKEN;
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  if (status === 204 || body === null) {
    res.writeHead(status, { 'x-github-request-id': requestId(), ...extraHeaders });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': requestId(),
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function createApp(): ReturnType<typeof createServer> {
  const store = new Store();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`;

      // The env's boot check calls this twice: 200 {"ok":true}.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path === '/mcp') {
        if (method === 'DELETE') {
          res.writeHead(204, { 'x-github-request-id': requestId() });
          res.end();
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed' } });
          return;
        }
        const parsed = parseJsonBody(await readBody(req));
        if (!parsed.ok) {
          sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          return;
        }
        if (!authorized(req)) {
          const id = parsed.value !== null && typeof parsed.value === 'object'
            ? (parsed.value as Record<string, unknown>).id ?? null
            : null;
          sendJson(res, 401, { jsonrpc: '2.0', id, error: { code: -32000, message: 'Unauthorized' } });
          return;
        }
        const result = handleMcp(store, parsed.value);
        if (result.status === 202 || result.json === null) {
          res.writeHead(202, { 'x-github-request-id': requestId() });
          res.end();
          return;
        }
        sendJson(res, result.status, result.json);
        return;
      }

      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 405, { errors: [{ message: 'Method Not Allowed' }] });
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, { errors: [{ message: 'Unauthorized' }] });
          return;
        }
        const parsed = parseJsonBody(await readBody(req));
        if (!parsed.ok) {
          sendJson(res, 400, { errors: [{ message: 'Malformed JSON' }] });
          return;
        }
        const result = handleGraphQL(store, parsed.value);
        sendJson(res, result.status, result.json);
        return;
      }

      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const parsed = method === 'GET' || method === 'DELETE' || method === 'HEAD'
          ? { ok: true as const, value: undefined }
          : parseJsonBody(await readBody(req));
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Malformed JSON' });
          return;
        }
        const result = handleRest(store, { method, path, query: url.searchParams, body: parsed.value, origin });
        sendJson(res, result.status, result.json, result.headers ?? {});
        return;
      }

      const route = gitRoute(path);
      if (route !== null) {
        const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : null;
        if (method === 'GET' && route.suffix === '/info/refs') {
          const result = handleInfoRefs(store, route.owner, route.repo, url.searchParams.get('service'), gitProtocol);
          res.writeHead(result.status, { 'content-type': result.contentType, 'x-github-request-id': requestId() });
          res.end(result.body);
          return;
        }
        if (method === 'POST' && route.suffix === '/git-upload-pack') {
          const result = handleUploadPack(store, route.owner, route.repo, await readBody(req), gitProtocol);
          res.writeHead(result.status, { 'content-type': result.contentType, 'x-github-request-id': requestId() });
          res.end(result.body);
          return;
        }
        if (method === 'POST' && route.suffix === '/git-receive-pack') {
          const result = handleReceivePack(store, route.owner, route.repo, await readBody(req));
          res.writeHead(result.status, { 'content-type': result.contentType, 'x-github-request-id': requestId() });
          res.end(result.body);
          return;
        }
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (err instanceof ApiError) {
        // A handler's expected failure (404, 422, 409, 405, 400): answer its own
        // status with a JSON message, never a 500.
        if (!res.headersSent) sendJson(res, err.status, { message: err.message });
        else res.end();
        return;
      }
      if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      else res.end();
    }
  });
  return server;
}
