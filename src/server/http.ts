import * as http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { logger } from '../logger.js';
import type { ConfigManager } from '../config/manager.js';
import { SessionStore, LoginRateLimiter } from './auth.js';
import { parseSessionTtlMs } from './session-utils.js';
import { HttpTransportManager } from './mcp-transport.js';
import { handleDashboard, readBody } from './dashboard-router.js';
import { resolveHttpListenHost } from './httpBind.js';
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

/** Query-param API key auth is OFF by default; requires explicit MCP_ALLOW_QUERY_KEY=true. */
export function queryKeyAuthEnabled(env = process.env): boolean {
  return env.MCP_ALLOW_QUERY_KEY === 'true';
}

/** Query param names whose values must never appear in logs or error telemetry. */
const SENSITIVE_QUERY_PARAM_NAMES = new Set([
  'key',
  'api_key',
  'api-key',
  'apikey',
  'token',
  'secret',
  'auth',
]);

/**
 * Redact sensitive query-parameter values from a request URL/path before
 * logging. Preserves the pathname and non-sensitive parameters.
 */
export function redactRequestUrl(urlOrPath: string): string {
  try {
    const parsed = new URL(urlOrPath, 'http://localhost');
    for (const name of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAM_NAMES.has(name.toLowerCase())) {
        parsed.searchParams.set(name, '•••');
      }
    }
    return parsed.toString();
  } catch {
    // Malformed URL fail closed
    return '•••';
  }
}

export function validateMcpKey(req: http.IncomingMessage, apiKey: string): boolean {
  if (!apiKey) return false;
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (safeTimingEqual(token, apiKey)) return true;
    // SEARCH_MCP_CONFIG_KEY fallback is only accepted when MCP_ALLOW_CONFIG_KEY_FALLBACK=true
    // (or during setup mode via SETUP_MODE=true)
    const configKeyFallback =
      process.env.MCP_ALLOW_CONFIG_KEY_FALLBACK === 'true' || process.env.SETUP_MODE === 'true';
    if (configKeyFallback) {
      const configKey = process.env.SEARCH_MCP_CONFIG_KEY ?? '';
      if (configKey.length > 0 && safeTimingEqual(token, configKey)) return true;
    }
  }
  if (queryKeyAuthEnabled()) {
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
  host = '127.0.0.1',
): Promise<http.Server> {
  // Query-param auth is opt-in: silent by default, announced only when enabled.
  if (queryKeyAuthEnabled()) {
    logger.info(
      'Query-param auth enabled via MCP_ALLOW_QUERY_KEY=true. API key may appear in URLs and browser history; prefer the Bearer header.',
    );
  }

  const ttlMs = parseSessionTtlMs();
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
          await transportManager.close(result.sessionId);
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
    server.listen(port, host, () => {
      resolve();
    });
    server.on('error', reject);
  });

  // Log the real security posture: loopback-only vs explicitly network-exposed.
  const listen = resolveHttpListenHost(host);
  const exposure = listen.exposure;
  logger.info(
    { host: listen.host, port, exposure },
    exposure === 'loopback'
      ? 'HTTP server listening (loopback-only)'
      : 'HTTP server listening (network-exposed; HTTP_HOST set)',
  );

  // Warn if no TLS termination indicator is present — the MCP endpoint
  // uses plaintext Bearer auth over HTTP, which is only safe behind a
  // reverse proxy or in isolated dev/Docker networks.
  if (
    !process.env.TLS_CERT_PATH &&
    !process.env.TLS_KEY_PATH &&
    process.env.NODE_ENV !== 'development' &&
    process.env.SETUP_MODE !== 'true'
  ) {
    logger.warn(
      'HTTP_PORT is active but no TLS_CERT_PATH/TLS_KEY_PATH set. ' +
        'The MCP endpoint (/mcp) uses plaintext Bearer auth over HTTP. ' +
        'Place a reverse proxy with TLS termination in front for production deployments.',
    );
  }

  return server;
}
