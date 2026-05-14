import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createServer } from '../server.js';
import { logger } from '../logger.js';
import type { SearchMcpRuntime } from '../config/types.js';

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  createdAt: number;
}

export interface SessionResult {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  isNew: boolean;
}

export class HttpTransportManager {
  private sessions = new Map<string, SessionEntry>();

  constructor(private readonly runtime: SearchMcpRuntime) {}

  async getOrCreate(sessionId: string | undefined): Promise<SessionResult | null> {
    if (sessionId !== undefined) {
      const entry = this.sessions.get(sessionId);
      if (!entry) return null; // stale / unknown session
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
    this.sessions.set(newId, { transport, createdAt: Date.now() });
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

  get sessionCount(): number {
    return this.sessions.size;
  }
}
