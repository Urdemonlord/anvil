// Anvil's server: one Node process, one store, four surfaces.
//
// Routing is by path: /healthz (no auth), /api/v3 (REST), /api/graphql, /mcp, and
// /{owner}/{repo}.git (smart HTTP). Everything except /healthz and the API root
// requires the bearer token: when MAKEFUN_SHOP_TOKEN is set it must match exactly,
// otherwise any non-empty token is accepted (the local-runner fallback) and a missing
// token is refused either way. Every reply carries X-GitHub-Request-Id, an
// incrementing `anvil-<n>`.
//
// A handler that throws is a 500 with a JSON body, never a dropped connection: the
// suite drives hundreds of requests in one trial and a single crash would fail the
// whole run. The server is keep-alive friendly (the read workload runs 2000 requests
// on one connection).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

export interface HandlerContext {
  store: Store;
  method: string;
  /** The raw percent-encoded path, without the query string. */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
  /** The Host header, for absolute pagination links. */
  host: string;
  requestId: string;
}

export interface HandlerResult {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | string | Record<string, unknown> | unknown[];
}

/** The largest request body accepted (a 100-file push pack is far below this). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface App {
  server: Server;
  store: Store;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function writeResult(response: ServerResponse, result: HandlerResult, requestId: string): void {
  const headers: Record<string, string> = { 'x-github-request-id': requestId, ...(result.headers ?? {}) };
  let body: Buffer;
  if (result.body === undefined || result.body === '') {
    body = Buffer.alloc(0);
  } else if (Buffer.isBuffer(result.body)) {
    body = result.body;
  } else if (typeof result.body === 'string') {
    body = Buffer.from(result.body, 'utf8');
  } else {
    body = Buffer.from(JSON.stringify(result.body), 'utf8');
    headers['content-type'] ??= 'application/json';
  }
  headers['content-length'] = String(body.length);
  response.writeHead(result.status, headers);
  response.end(body);
}

export function createApp(options: { token?: string } = {}): App {
  const store = new Store();
  const expectedToken = options.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCount = 0;

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      requestCount += 1;
      const requestId = `anvil-${requestCount}`;
      try {
        const host = request.headers.host ?? '127.0.0.1';
        const url = new URL(request.url ?? '/', `http://${host}`);
        const path = url.pathname;
        const method = (request.method ?? 'GET').toUpperCase();
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.headers)) {
          if (typeof value === 'string') headers[key.toLowerCase()] = value;
        }
        // GET and HEAD carry no body; DELETE does (contents delete sends message + sha).
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(request);
        const ctx: HandlerContext = { store, method, path, query: url.searchParams, headers, body, host, requestId };

        // /healthz takes no token and answers the runner's probe.
        if (method === 'GET' && path === '/healthz') {
          writeResult(response, { status: 200, body: { ok: true } }, requestId);
          return;
        }

        // Auth: the API root is public; everything else needs the bearer token.
        const isApiRoot = method === 'GET' && path === '/api/v3/';
        if (!isApiRoot) {
          const authorization = headers.authorization ?? '';
          const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
          const valid = expectedToken === '' ? token !== '' : token === expectedToken;
          if (!valid) {
            writeResult(response, { status: 401, body: { message: 'Bad credentials' } }, requestId);
            return;
          }
        }

        let result: HandlerResult | null = null;
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
          result = handleRest(store, restPath, ctx);
        } else if (path === '/api/graphql') {
          if (method !== 'POST') {
            result = { status: 405, body: { message: 'Method Not Allowed' } };
          } else {
            result = handleGraphql(store, ctx);
          }
        } else if (path === '/mcp') {
          result = handleMcp(store, ctx);
        } else {
          const segments = path.split('/').filter((segment) => segment.length > 0);
          if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
            const owner = decodeURIComponent(segments[0]!);
            const repoName = decodeURIComponent(segments[1]!.slice(0, -'.git'.length));
            const subpath = segments.slice(2).join('/');
            result = handleGit(store, owner, repoName, subpath, ctx);
          }
        }
        if (result === null) {
          result = { status: 404, body: { message: 'Not Found' } };
        }
        writeResult(response, result, requestId);
      } catch (error) {
        if (!response.headersSent) {
          writeResult(response, { status: 500, body: { message: error instanceof Error ? error.message : String(error) } }, requestId);
        } else {
          response.end();
        }
      }
    })();
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  return { server, store };
}
