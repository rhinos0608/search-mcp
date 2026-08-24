/**
 * Server composition root.
 *
 * Pure wiring: loads config, registers tools (via standalone and family modules),
 * starts the MCP server. No inline schemas or handlers.
 */

import type { SearchConfig } from './config.js';
import { loadConfig } from './config.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGatedTools, configHealth } from './health.js';
import { logger } from './logger.js';
import { getVersion } from './version.js';

// Standalone tools
import { registerWebSearch } from './tools/standalone/webSearch.js';
import { registerWebCrawl } from './tools/standalone/webCrawl.js';
import { registerSemanticCrawlFamily } from './tools/families/semanticCrawl.js';
import { registerSemanticJobs } from './tools/standalone/semanticJobs.js';
import { registerHealthCheck } from './tools/standalone/healthCheck.js';
import { registerRssTool } from './tools/standalone/rss.js';

// Family tools
import { registerYoutubeTool } from './tools/families/youtube.js';
import { registerRedditTool } from './tools/families/reddit.js';
import { registerGitHubTool } from './tools/families/github.js';
import { registerPackagesTool } from './tools/families/packages.js';
import { registerResearchTool } from './tools/families/research.js';
import { registerBrowserTool } from './tools/families/browser.js';
import { registerAgenticBrowseTool } from './tools/families/agenticBrowse.js';

export function createServer(
  cfg: SearchConfig,
  getConfig?: () => SearchConfig,
): {
  server: McpServer;
} {
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
    version: getVersion(),
  });

  registerWebSearch(server, getConfig ?? loadConfig);
  registerWebCrawl(server, cfg);
  registerRssTool(server);

  // Gated standalone tools
  if (!gated.has('semantic_jobs')) registerSemanticJobs(server, cfg);
  // semantic_crawl is now a family tool with crawl/list_corpora/inspect_corpus actions.
  // The crawl action requires Crawl4AI + embedding; list_corpora/inspect_corpus are always available.
  registerSemanticCrawlFamily(server, cfg);

  registerYoutubeTool(server, cfg);
  registerRedditTool(server, cfg);
  registerGitHubTool(server, cfg);
  registerPackagesTool(server, cfg);
  registerResearchTool(server, cfg);
  // Browser is excluded from passive KG capture: its output is complex HTML
  // and session-heavy, and the extraction pipeline is not designed for DOM trees.
  registerBrowserTool(server, cfg);
  registerAgenticBrowseTool(server, cfg);

  // Conditional / gated tools
  registerHealthCheck(server, cfg);

  return { server };
}
