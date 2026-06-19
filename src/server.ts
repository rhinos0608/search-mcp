/**
 * Server composition root.
 *
 * Pure wiring: loads config, registers tools (via standalone and family modules),
 * starts the MCP server. No inline schemas or handlers.
 */

import type { SearchConfig } from './config.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGatedTools, configHealth } from './health.js';
import { logger } from './logger.js';
import { getVersion } from './version.js';

// Standalone tools
import { registerWebSearch } from './tools/standalone/webSearch.js';
import { registerWebCrawl } from './tools/standalone/webCrawl.js';
import { registerSemanticCrawl } from './tools/standalone/semanticCrawl.js';
import { registerSemanticCrawlListCorpora } from './tools/standalone/semanticCrawlListCorpora.js';
import { registerSemanticCrawlInspectCorpus } from './tools/standalone/semanticCrawlInspectCorpus.js';
import { registerSemanticJobs } from './tools/standalone/semanticJobs.js';
import { registerHealthCheck } from './tools/standalone/healthCheck.js';
import { registerFetchFocus } from './tools/standalone/fetchFocus.js';

// Family tools
import { registerYoutubeTool } from './tools/families/youtube.js';
import { registerRedditTool } from './tools/families/reddit.js';
import { registerGitHubTool } from './tools/families/github.js';
import { registerPackagesTool } from './tools/families/packages.js';
import { registerResearchTool } from './tools/families/research.js';
import { registerBrowserTool } from './tools/families/browser.js';
import { registerAgenticBrowseTool } from './tools/families/agenticBrowse.js';

// Deep research
import { registerDeepResearchTool } from './tools/standalone/deepResearch.js';

// Knowledge graph tool family
import { registerKnowledgeGraphTool } from './tools/families/knowledgeGraph.js';

// Knowledge graph
import { initKgDb } from './knowledge/store/db.js';
import { resolveKgDbPath } from './knowledge/config.js';
import { KnowledgeGraphHook } from './knowledge/hook.js';

export function createServer(
  cfg: SearchConfig,
  existingHook?: KnowledgeGraphHook,
): {
  server: McpServer;
  kgHook: KnowledgeGraphHook | null;
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

  // Initialize KG database and hook
  let kgHook: KnowledgeGraphHook | null = existingHook ?? null;
  if (cfg.knowledgeGraph.enabled) {
    if (kgHook === null) {
      initKgDb(resolveKgDbPath(cfg.knowledgeGraph));
      kgHook = new KnowledgeGraphHook(cfg);
    }
  }

  // Standalone tools (pass kgHook for passive capture)
  registerWebSearch(server, cfg, kgHook ?? undefined);
  registerWebCrawl(server, cfg, kgHook ?? undefined);

  // Gated standalone tools
  if (!gated.has('semantic_jobs')) registerSemanticJobs(server, cfg);
  if (!gated.has('semantic_crawl')) {
    registerSemanticCrawl(server, cfg, kgHook ?? undefined);
    registerSemanticCrawlListCorpora(server);
    registerSemanticCrawlInspectCorpus(server);
  }
  if (!gated.has('deep_research')) registerDeepResearchTool(server, cfg, kgHook ?? undefined);

  // Family tools (pass kgHook for passive capture)
  registerYoutubeTool(server, cfg, kgHook ?? undefined);
  registerRedditTool(server, cfg, kgHook ?? undefined);
  registerGitHubTool(server, cfg, kgHook ?? undefined);
  registerPackagesTool(server, cfg, kgHook ?? undefined);
  registerResearchTool(server, cfg, kgHook ?? undefined);
  // Browser is excluded from passive KG capture: its output is complex HTML
  // and session-heavy, and the extraction pipeline is not designed for DOM trees.
  // If browser capture is added later, registerBrowserTool should accept kgHook.
  registerBrowserTool(server, cfg);
  registerAgenticBrowseTool(server, cfg, kgHook ?? undefined);

  // Conditional / gated tools
  registerHealthCheck(server, cfg);

  // Deprecated compatibility alias — use agentic_browse.focus instead.
  // Will be removed in the next major release.
  registerFetchFocus(server, cfg);

  // Knowledge graph family (conditional on KG enabled)
  if (cfg.knowledgeGraph.enabled) {
    registerKnowledgeGraphTool(server, cfg, kgHook ?? undefined);
  }

  return { server, kgHook };
}
