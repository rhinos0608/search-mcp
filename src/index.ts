#!/usr/bin/env node
import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { ConfigManager } from './config/manager.js';
import * as http from 'node:http';
import { startHttpServer } from './server/http.js';
import { isAddressInUseError } from './server/startupErrors.js';
import type { SearchMcpRuntime } from './config/types.js';
import { startArtifactSweeper } from './tools/webSearchArtifact.js';
import { startGitHubArtifactSweeper } from './tools/githubOverflowArtifact.js';

// ── Shutdown handler registration ──────────────────────────────────────────

/**
 * Register OS signal and error handlers that call `close` on shutdown,
 * always running `closeKgDb()` in a finally block so the KG database
 * is flushed even if server close throws.
 */
function registerShutdownHandlers(close: () => Promise<void>): void {
  async function shutdown(exitCode = 0): Promise<void> {
    logger.info('Shutting down search-mcp server');
    try {
      await close();
    } catch (err) {
      logger.error({ err }, 'Error during server close');
    } finally {
      if (exitCode !== 0) process.exit(exitCode);
    }
  }

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — shutting down');
    void shutdown(1).finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled promise rejection — shutting down');
    void shutdown(1).finally(() => process.exit(1));
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('Starting search-mcp server');

  // Periodic artifact TTL/capacity sweep, independent of web_search traffic.
  startArtifactSweeper();
  startGitHubArtifactSweeper();

  const httpPortEnv = process.env.HTTP_PORT;
  const useHttp = httpPortEnv !== undefined && httpPortEnv !== '';

  if (useHttp) {
    const port = parseInt(httpPortEnv, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      logger.error({ HTTP_PORT: httpPortEnv }, 'Invalid HTTP_PORT — must be a number 1–65535');
      process.exit(1);
    }

    const configManager = new ConfigManager();
    configManager.load();
    const cfg = configManager.get();

    const { server: stdioServer } = createServer(cfg);
    const stdioTransport = new StdioServerTransport();
    await stdioServer.connect(stdioTransport);
    logger.info('search-mcp server connected via stdio');

    const runtime: SearchMcpRuntime = {
      getConfig: () => configManager.get(),
    };

    let httpServer: http.Server | undefined;
    try {
      httpServer = await startHttpServer(runtime, configManager, port);
      logger.info({ port }, 'HTTP MCP transport active');
    } catch (err) {
      if (!isAddressInUseError(err)) {
        logger.error({ err: err as Error }, 'HTTP server startup failed');
        await stdioServer.close().catch(() => {
          // Ignore errors during shutdown
        });
        throw err;
      }

      logger.warn(
        { err: err as Error, port },
        'HTTP_PORT is already in use; continuing with stdio transport only',
      );
    }

    registerShutdownHandlers(async () => {
      if (httpServer) {
        try {
          await new Promise<void>((resolve, reject) => {
            httpServer.close((err) => {
              if (err) reject(err);
              else resolve();
            });
          });
        } catch (err) {
          logger.error({ err }, 'Error closing HTTP server');
        }
      }
      try {
        await stdioServer.close();
      } catch (err) {
        logger.error({ err }, 'Error closing stdio server');
      }
    });
  } else {
    const cfg = loadConfig();
    const { server } = createServer(cfg);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('search-mcp server connected via stdio');

    registerShutdownHandlers(async () => {
      await server.close();
    });
  }
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
