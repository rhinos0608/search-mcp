/**
 * Server composition root.
 *
 * Pure wiring: loads config, registers tools (via standalone and family modules),
 * starts the MCP server. No inline schemas or handlers.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from './config.js';
import { getGatedTools, configHealth } from './health.js';
import { logger } from './logger.js';

// Standalone tools
import { registerWebSearch } from './tools/standalone/webSearch.js';
import { registerWebRead } from './tools/standalone/webRead.js';
import { registerWebCrawl } from './tools/standalone/webCrawl.js';
import { registerSemanticCrawl } from './tools/standalone/semanticCrawl.js';
import { registerSemanticJobs } from './tools/standalone/semanticJobs.js';
import { registerFetchFocus } from './tools/standalone/fetchFocus.js';
import { registerHealthCheck } from './tools/standalone/healthCheck.js';

// Family tools
import { registerYoutubeTool } from './tools/families/youtube.js';
import { registerRedditTool } from './tools/families/reddit.js';
import { registerGitHubTool } from './tools/families/github.js';
import { registerPackagesTool } from './tools/families/packages.js';
import { registerResearchTool } from './tools/families/research.js';
import { registerBrowserTool } from './tools/families/browser.js';

// Deep research (standalone but not in standalone/ directory)
import { registerDeepResearchTool } from './tools/deepResearch.js';

export function createServer(): McpServer {
  const cfg = loadConfig();
  logger.info({ backend: cfg.searchBackend }, 'Primary search backend');

  const gated = getGatedTools(cfg);
  if (gated.size > 0) {
    const startupHealth = configHealth(cfg);
    for (const tool of gated) {
      const h = startupHealth[tool];
      logger.info({ tool, remediation: h?.remediation }, 'Tool not registered (unconfigured)');
    }
  }

  const server = new McpServer({
    name: 'search-mcp',
    version: '1.0.0',
  });

  // Standalone tools
  registerWebSearch(server, cfg);
  registerWebRead(server, cfg);
  registerWebCrawl(server, cfg);

  // Gated standalone tools
  if (!gated.has('semantic_jobs')) registerSemanticJobs(server, cfg);
  if (!gated.has('semantic_crawl')) registerSemanticCrawl(server, cfg);
  if (!gated.has('deep_research')) registerDeepResearchTool(server, cfg);

  // Family tools
  registerYoutubeTool(server, cfg);
  registerRedditTool(server, cfg);
  registerGitHubTool(server, cfg);
  registerPackagesTool(server, cfg);
  registerResearchTool(server, cfg);
  registerBrowserTool(server, cfg);

  // Conditional / gated tools
  registerFetchFocus(server, cfg);
  registerHealthCheck(server, cfg);

  return server;
}
