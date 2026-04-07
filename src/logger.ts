// Pino logger that always writes to stderr (fd 2).
// stdout is reserved for MCP JSON-RPC protocol messages.
//
// --json flag: structured JSON output (for log aggregation / CI)
// no flag:     human-readable via pino-pretty (for development)
//
// Usage:
//   logger.info({ tool: 'web_search', query }, 'Tool invoked')
//   logger.error({ err, tool: 'web_read', url }, 'Tool failed')

import pino, { type DestinationStream } from 'pino';

export const isJsonMode: boolean =
  process.argv.includes('--json') ||
  process.env.NODE_ENV === 'production' ||
  process.env.CI === 'true';

const dest: DestinationStream = isJsonMode
  ? pino.destination({ fd: 2, sync: false })
  : (pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        destination: 2, // stderr
      },
    }) as DestinationStream);

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
  },
  dest,
);
