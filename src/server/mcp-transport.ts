import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createServer } from '../server.js';
import { logger } from '../logger.js';
import type { SearchMcpRuntime } from '../config/types.js';

const SESSION_IDLE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
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
    });
    // Each HTTP session gets its own McpServer instance
    const server = createServer(this.runtime.getConfig());
    await server.connect(transport as unknown as Transport);
    const now = Date.now();
    this.sessions.set(newId, { transport, createdAt: now, lastUsedAt: now });
    return { sessionId: newId, transport, isNew: true };
  }

  close(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      try {
        void entry.transport.close();
      } catch (err) {
        logger.debug({ err, sessionId }, 'Transport close error');
      }
      this.sessions.delete(sessionId);
    }
  }

  closeAll(): void {
    for (const [id] of this.sessions) this.close(id);
  }

  private pruneIdle(): void {
    const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
    for (const [id, entry] of this.sessions) {
      if (entry.lastUsedAt < cutoff) {
        logger.debug({ sessionId: id }, 'Pruning idle MCP session');
        this.close(id);
      }
    }
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}
