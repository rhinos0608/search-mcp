import * as http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import type { ConfigManager } from '../config/manager.js';
import type { SessionStore, LoginRateLimiter } from './auth.js';
import {
  parseCookieHeader,
  getCookieName,
  buildSetCookieHeader,
  buildClearCookieHeader,
} from './auth.js';
import { classifyRequestOrigin, dashboardAllowed } from './access-provider.js';
import type { HttpTransportManager } from './mcp-transport.js';
import { timingSafeEqual } from 'node:crypto';

export interface DashboardContext {
  configManager: ConfigManager;
  sessionStore: SessionStore;
  rateLimiter: LoginRateLimiter;
  transportManager: HttpTransportManager;
  dashboardDistDir: string;
  port: number;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export async function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;

    function cleanup(): void {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    }

    function onData(chunk: Buffer | string): void {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        cleanup();
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(buf);
    }

    function onEnd(): void {
      cleanup();
      resolve(Buffer.concat(chunks));
    }

    function onError(): void {
      cleanup();
      resolve(null);
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
  });
  res.end(body);
}

function isHttps(req: http.IncomingMessage): boolean {
  return (req.socket as { encrypted?: boolean }).encrypted === true;
}

function getSessionId(req: http.IncomingMessage): string | undefined {
  const header = req.headers.cookie ?? '';
  const https = isHttps(req);
  return parseCookieHeader(header, getCookieName(https));
}

function validateOriginHeader(req: http.IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    if (o.hostname !== 'localhost' && o.hostname !== '127.0.0.1') return false;
    const originPort = o.port || (o.protocol === 'https:' ? '443' : '80');
    return originPort === String(port);
  } catch {
    return false;
  }
}

async function serveStatic(res: http.ServerResponse, filePath: string): Promise<void> {
  try {
    const ext = extname(filePath);
    const mime = MIME[ext] ?? 'application/octet-stream';
    const stats = await stat(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': String(stats.size) });
    createReadStream(filePath).pipe(res);
  } catch {
    if (!res.headersSent) {
      res.writeHead(404);
      res.end('Not found');
    }
  }
}

export async function handleDashboard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: DashboardContext,
): Promise<void> {
  const { configManager, dashboardDistDir, port } = ctx;
  const cfg = configManager.get();

  // 1. Exposure check — MUST run first
  const origin = classifyRequestOrigin(req);
  if (!dashboardAllowed(origin, cfg.access)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const indexPath = join(dashboardDistDir, 'index.html');
  const distExists = existsSync(indexPath);

  const url = new URL(req.url ?? '/', `http://localhost:${String(port)}`);
  const pathname = url.pathname;
  const https = isHttps(req);

  // 2. API routes
  if (pathname.startsWith('/dashboard/api/')) {
    let body: Buffer | null = null;
    if (req.method === 'POST') {
      const limit = pathname === '/dashboard/api/login' ? 1024 : 65536;
      body = await readBody(req, limit);
      if (body === null) {
        res.writeHead(413);
        res.end('Request too large');
        return;
      }

      if (!validateOriginHeader(req, port)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: invalid Origin');
        return;
      }
    }

    await handleApi(req, res, { body, ctx, https });
    return;
  }

  // 3. Static files
  if (!distExists) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Dashboard build not found. Run: npm run build:dashboard');
    return;
  }

  if (pathname === '/dashboard' || pathname === '/dashboard/') {
    await serveStatic(res, indexPath);
    return;
  }

  // Sanitize: prevent path traversal outside dashboardDistDir
  const relative = pathname.replace(/^\/dashboard/, '');
  const candidatePath = join(dashboardDistDir, relative);
  const resolvedPath = resolve(candidatePath);
  const resolvedRoot = resolve(dashboardDistDir);
  if (!resolvedPath.startsWith(resolvedRoot + '/') && resolvedPath !== resolvedRoot) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  try {
    const candidateStat = await stat(resolvedPath);
    if (candidateStat.isFile()) {
      await serveStatic(res, resolvedPath);
      return;
    }
  } catch {
    /* not a file or not found */
  }

  // SPA fallback
  await serveStatic(res, indexPath);
}

function parseBody(body: Buffer | null, endpoint: string): unknown {
  if (body === null) throw new Error(`Missing body for ${endpoint}`);
  return JSON.parse(body.toString('utf8')) as unknown;
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: { body: Buffer | null; ctx: DashboardContext; https: boolean },
): Promise<void> {
  const { body, ctx, https } = opts;
  const { configManager, sessionStore, rateLimiter, transportManager, port } = ctx;
  const url = new URL(req.url ?? '/', `http://localhost:${String(port)}`);
  const endpoint = url.pathname.replace('/dashboard/api', '');
  const ip = req.socket.remoteAddress ?? 'unknown';

  // --- Setup endpoints (loopback-only, no session required) ---
  if (endpoint === '/setup' && req.method === 'GET') {
    if (classifyRequestOrigin(req) !== 'loopback') {
      json(res, 403, { error: 'Setup is only accessible from localhost' });
      return;
    }
    const cfg = configManager.get();
    if (cfg.apiKeyClaimed) {
      json(res, 200, { claimed: true });
    } else {
      json(res, 200, { claimed: false, apiKey: cfg.mcpApiKey ?? '' });
    }
    return;
  }

  if (endpoint === '/setup/claim' && req.method === 'POST') {
    if (classifyRequestOrigin(req) !== 'loopback') {
      json(res, 403, { error: 'Setup is only accessible from localhost' });
      return;
    }
    configManager.claimApiKey();
    const session = sessionStore.create();
    const rawTtl = process.env.SESSION_TTL_HOURS;
    const ttlHours = rawTtl !== undefined ? Number.parseFloat(rawTtl) : 12;
    const ttl = (Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : 12) * 3600 * 1000;
    res.setHeader('Set-Cookie', buildSetCookieHeader(session.id, ttl, https));
    json(res, 200, { ok: true });
    return;
  }

  // --- Unauthenticated endpoints ---
  if (endpoint === '/login' && req.method === 'POST') {
    let parsedLogin: unknown;
    try {
      parsedLogin = parseBody(body, endpoint);
    } catch (err) {
      json(res, 400, { error: 'Invalid request body' });
      return;
    }
    const loginData = parsedLogin as { apiKey?: string };
    const apiKey = loginData.apiKey ?? '';
    const check = rateLimiter.check(ip);
    if (!check.allowed) {
      json(res, 429, { error: 'Too many login attempts', retryAfter: check.retryAfter });
      return;
    }
    const expected = configManager.get().mcpApiKey ?? '';
    const configKey = process.env.SEARCH_MCP_CONFIG_KEY ?? '';
    await new Promise((r) => setTimeout(r, 500));
    let match = false;
    if (expected.length > 0 && apiKey.length === expected.length) {
      match = timingSafeEqual(Buffer.from(apiKey), Buffer.from(expected));
    }
    if (!match && configKey.length > 0 && apiKey.length === configKey.length) {
      match = timingSafeEqual(Buffer.from(apiKey), Buffer.from(configKey));
    }
    if (!match) {
      rateLimiter.recordFailure(ip);
      json(res, 401, { error: 'Invalid API key' });
      return;
    }
    rateLimiter.recordSuccess(ip);
    const session = sessionStore.create();
    const rawTtl = process.env.SESSION_TTL_HOURS;
    const ttlHours = rawTtl !== undefined ? Number.parseFloat(rawTtl) : 12;
    const ttl = (Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : 12) * 3600 * 1000;
    res.setHeader('Set-Cookie', buildSetCookieHeader(session.id, ttl, https));
    json(res, 200, { ok: true });
    return;
  }

  if (endpoint === '/session' && req.method === 'GET') {
    const sid = getSessionId(req);
    json(res, 200, { authenticated: sid !== undefined && sessionStore.validate(sid) });
    return;
  }

  // --- Session-gated endpoints ---
  const sid = getSessionId(req);
  if (!sid || !sessionStore.validate(sid)) {
    json(res, 401, { error: 'Not authenticated' });
    return;
  }

  if (endpoint === '/logout' && req.method === 'POST') {
    sessionStore.revoke(sid);
    res.setHeader('Set-Cookie', buildClearCookieHeader(https));
    json(res, 200, { ok: true });
    return;
  }

  if (endpoint === '/config/status' && req.method === 'GET') {
    json(res, 200, { config: configManager.getRedacted() });
    return;
  }

  if (endpoint === '/providers' && req.method === 'GET') {
    const cfg = configManager.get();
    json(res, 200, {
      providers: [
        { id: 'brave', configured: !!cfg.brave.apiKey },
        { id: 'searxng', configured: !!cfg.searxng.baseUrl },
        { id: 'exa', configured: !!cfg.exa.apiKey },
        { id: 'crawl4ai', configured: !!cfg.crawl4ai.baseUrl },
        { id: 'youtube', configured: !!cfg.youtube.apiKey },
        { id: 'github', configured: !!cfg.github.token },
      ],
    });
    return;
  }

  if (endpoint === '/config/update' && req.method === 'POST') {
    try {
      const patch = parseBody(body, endpoint) as never;
      configManager.update(patch);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: String(err) });
    }
    return;
  }

  if (endpoint === '/config/test-connection' && req.method === 'POST') {
    let parsedTest: unknown;
    try {
      parsedTest = parseBody(body, endpoint);
    } catch (err) {
      json(res, 400, { error: 'Invalid request body' });
      return;
    }
    const testData = parsedTest as { provider: string };
    const result = await configManager.testConnection(testData.provider);
    json(res, 200, result);
    return;
  }

  if (endpoint === '/access' && req.method === 'GET') {
    json(res, 200, { access: configManager.get().access });
    return;
  }

  if (endpoint === '/access/update' && req.method === 'POST') {
    try {
      const patch = parseBody(body, endpoint) as never;
      configManager.update({ access: patch });
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: String(err) });
    }
    return;
  }

  if (endpoint === '/rotate-key' && req.method === 'POST') {
    sessionStore.revokeAll();
    transportManager.closeAll();
    const newKey = configManager.rotateApiKey();
    res.setHeader('Set-Cookie', buildClearCookieHeader(https));
    json(res, 200, { newKey, warning: 'All sessions and MCP connections have been terminated.' });
    return;
  }

  json(res, 404, { error: 'Not found' });
}
