import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createServer } from '../server.js';
import { logger } from '../logger.js';
import type { SearchMcpRuntime } from '../config/types.js';
import type { KnowledgeGraphHook } from '../knowledge/hook.js';

const SESSION_IDLE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  kgHook: KnowledgeGraphHook | null;
  createdAt: number;
  lastUsedAt: number;
}

export interface SessionResult {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  isNew: boolean;
}

export class HttpTransportManager {
  private sessions = new Map<string, SessionEntry>();
  private pruneTimer: ReturnType<typeof setInterval>;

  constructor(private readonly runtime: SearchMcpRuntime) {
    this.pruneTimer = setInterval(() => { this.pruneIdle(); }, 30 * 60 * 1000);
    this.pruneTimer.unref();
  }

  async getOrCreate(sessionId: string | undefined): Promise<SessionResult | null> {
    if (sessionId !== undefined) {
      const entry = this.sessions.get(sessionId);
      if (!entry) return null; // stale / unknown session
      entry.lastUsedAt = Date.now();
      return { sessionId, transport: entry.transport, isNew: false };
    }

    // Create new session
    const newId = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newId,
      // Use direct JSON responses instead of SSE for POST requests.
      // Avoids SSE stream termination errors with large payloads (e.g. 150KB tools/list).
      // Per the MCP Streamable HTTP spec, servers MAY return JSON directly when
      // all responses are immediately available.
      enableJsonResponse: true,
    });
    // Each HTTP session gets its own McpServer instance
    const { server, kgHook } = createServer(this.runtime.getConfig());
    // Bind hook's internal session ID to the HTTP session UUID so
    // passive captures and flushSession() use the same ID.
    if (kgHook) {
      kgHook.setSessionId(newId);
    }
    await server.connect(transport as unknown as Transport);
    const now = Date.now();
    this.sessions.set(newId, { transport, kgHook, createdAt: now, lastUsedAt: now });
    return { sessionId: newId, transport, isNew: true };
  }

  async close(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      // Flush pending KG extractions for this session
      if (entry.kgHook) {
        try {
          await entry.kgHook.flushSession(sessionId);
        } catch (err) {
          logger.debug({ err, sessionId }, 'KG flush error during session close');
        }
      }
      try {
        await entry.transport.close();
      } catch (err) {
        logger.debug({ err, sessionId }, 'Transport close error');
      }
      this.sessions.delete(sessionId);
    }
  }

  async closeAll(): Promise<void> {
    for (const [id] of this.sessions) await this.close(id);
  }

  private pruneIdle(): void {
    const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
    for (const [id, entry] of this.sessions) {
      if (entry.lastUsedAt < cutoff) {
        logger.debug({ sessionId: id }, 'Pruning idle MCP session');
        void this.close(id);
      }
    }
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}
