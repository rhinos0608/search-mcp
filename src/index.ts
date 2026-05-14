#!/usr/bin/env node
import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { ConfigManager } from './config/manager.js';
import { startHttpServer } from './server/http.js';
import type { SearchMcpRuntime } from './config/types.js';

async function main(): Promise<void> {
  logger.info('Starting search-mcp server');

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

    const stdioServer = createServer(cfg);
    const stdioTransport = new StdioServerTransport();
    await stdioServer.connect(stdioTransport);
    logger.info('search-mcp server connected via stdio');

    const runtime: SearchMcpRuntime = {
      getConfig: () => configManager.get(),
    };

    const httpServer = await startHttpServer(runtime, configManager, port);
    logger.info({ port }, 'HTTP MCP transport active');

    async function shutdown(): Promise<void> {
      logger.info('Shutting down search-mcp server');
      try { await stdioServer.close(); } catch (err) { logger.error({ err }, 'stdio close error'); }
      await new Promise<void>(r => { httpServer.close(() => { r(); }); });
      process.exit(0);
    }

    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });
    process.on('uncaughtException', (err) => {
      logger.fatal({ err }, 'Uncaught exception');
      void shutdown().finally(() => { process.exit(1); });
    });
    process.on('unhandledRejection', (reason) => {
      logger.fatal({ reason }, 'Unhandled rejection');
      void shutdown().finally(() => { process.exit(1); });
    });
  } else {
    const cfg = loadConfig();
    const server = createServer(cfg);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('search-mcp server connected via stdio');

    async function shutdown(): Promise<void> {
      logger.info('Shutting down search-mcp server');
      try {
        await server.close();
      } catch (err) {
        logger.error({ err }, 'Error during server close');
      }
      process.exit(0);
    }

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    process.on('uncaughtException', (err) => {
      logger.fatal({ err }, 'Uncaught exception — shutting down');
      void shutdown().finally(() => process.exit(1));
    });

    process.on('unhandledRejection', (reason) => {
      logger.fatal({ reason }, 'Unhandled promise rejection — shutting down');
      void shutdown().finally(() => process.exit(1));
    });
  }
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
