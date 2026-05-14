import * as http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { logger } from '../logger.js';
import type { ConfigManager } from '../config/manager.js';
import { SessionStore, LoginRateLimiter } from './auth.js';
import { HttpTransportManager } from './mcp-transport.js';
import { handleDashboard, readBody } from './dashboard-router.js';
import type { SearchMcpRuntime } from '../config/types.js';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DASHBOARD_DIST = join(PKG_ROOT, 'dist-dashboard');

function safeTimingEqual(a: string, b: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function validateMcpKey(req: http.IncomingMessage, apiKey: string): boolean {
  if (!apiKey) return false;
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (safeTimingEqual(token, apiKey)) return true;
    const configKey = process.env.SEARCH_MCP_CONFIG_KEY ?? '';
    return configKey.length > 0 && safeTimingEqual(token, configKey);
  }
  if (process.env.MCP_ALLOW_QUERY_KEY === 'true') {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const qKey = url.searchParams.get('key') ?? '';
    return safeTimingEqual(qKey, apiKey);
  }
  return false;
}

export async function startHttpServer(
  runtime: SearchMcpRuntime,
  configManager: ConfigManager,
  port: number,
): Promise<http.Server> {
  if (process.env.MCP_ALLOW_QUERY_KEY === 'true') {
    logger.warn(
      'MCP_ALLOW_QUERY_KEY=true: query-param auth is enabled. API key may appear in logs and browser history.',
    );
  }

  const ttlMs = Number(process.env.SESSION_TTL_HOURS ?? 12) * 3600 * 1000;
  const sessionStore = new SessionStore(ttlMs);
  const rateLimiter = new LoginRateLimiter();
  const transportManager = new HttpTransportManager(runtime);

  const dashboardCtx = {
    configManager,
    sessionStore,
    rateLimiter,
    transportManager,
    dashboardDistDir: DASHBOARD_DIST,
    port,
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', `http://localhost:${String(port)}`).pathname;

    try {
      if (pathname === '/mcp') {
        const cfg = configManager.get();
        const apiKey = cfg.mcpApiKey ?? '';
        if (!validateMcpKey(req, apiKey)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const rawSessionId = req.headers['mcp-session-id'] as string | undefined;
        const sessionId =
          rawSessionId && /^[a-zA-Z0-9-]{1,128}$/.test(rawSessionId) ? rawSessionId : undefined;
        const result = await transportManager.getOrCreate(sessionId);
        if (result === null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session not found' }));
          return;
        }

        if (req.method === 'DELETE') {
          transportManager.close(result.sessionId);
          res.writeHead(200);
          res.end();
          return;
        }

        let bodyBuf: Buffer | undefined;
        if (req.method === 'POST') {
          const buf = await readBody(req, 10 * 1024 * 1024); // 10MB for MCP
          if (buf === null) {
            res.writeHead(413);
            res.end('Request too large');
            return;
          }
          bodyBuf = buf;
        }

        let parsedBody: unknown = undefined;
        if (bodyBuf) {
          try {
            parsedBody = JSON.parse(bodyBuf.toString('utf8')) as unknown;
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
            return;
          }
        }
        await result.transport.handleRequest(req, res, parsedBody);
        return;
      }

      if (pathname.startsWith('/dashboard')) {
        await handleDashboard(req, res, dashboardCtx);
        return;
      }

      if (pathname === '/' || pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mcpSessions: transportManager.sessionCount }));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      logger.error({ err, pathname, method: req.method }, 'HTTP request handler error');
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal server error');
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.listen(port, '0.0.0.0', () => {
      resolve();
    });
    server.on('error', reject);
  });

  logger.info({ port }, 'HTTP server listening');

  return server;
}
