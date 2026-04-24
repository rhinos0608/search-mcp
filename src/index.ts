#!/usr/bin/env node
import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from './logger.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  logger.info('Starting search-mcp server');
  const server = createServer();
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

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
