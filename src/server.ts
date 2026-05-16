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

// Standalone tools
import { registerWebSearch } from './tools/standalone/webSearch.js';
import { registerWebRead } from './tools/standalone/webRead.js';
import { registerWebCrawl } from './tools/standalone/webCrawl.js';
import { registerSemanticCrawl } from './tools/standalone/semanticCrawl.js';
import { registerSemanticCrawlListCorpora } from './tools/standalone/semanticCrawlListCorpora.js';
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

// Knowledge graph tools
import { registerGraphIngestTool } from './tools/graph-ingest.js';
import { registerGraphQueryTool } from './tools/graph-query.js';
import { registerEntityLookupBatchTool } from './tools/entity-lookup-batch.js';
import { registerGraphStatusTool } from './tools/graph-status.js';
import { registerGraphRebuildTool } from './tools/graph-rebuild.js';
import { registerFamilyListTool } from './tools/family-list.js';
import { registerFamilyGetTool } from './tools/family-get.js';
import { registerFamilyMergeTool } from './tools/family-merge.js';
import { registerRunListTool } from './tools/run-list.js';
import { registerRunRollbackTool } from './tools/run-rollback.js';

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
    version: '1.0.0',
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
  registerWebRead(server, cfg, kgHook ?? undefined);
  registerWebCrawl(server, cfg, kgHook ?? undefined);

  // Gated standalone tools
  if (!gated.has('semantic_jobs')) registerSemanticJobs(server, cfg);
  if (!gated.has('semantic_crawl')) {
    registerSemanticCrawl(server, cfg, kgHook ?? undefined);
    registerSemanticCrawlListCorpora(server);
  }
  if (!gated.has('deep_research')) registerDeepResearchTool(server, cfg, kgHook ?? undefined);

  // Family tools (pass kgHook for passive capture)
  registerYoutubeTool(server, cfg, kgHook ?? undefined);
  registerRedditTool(server, cfg, kgHook ?? undefined);
  registerGitHubTool(server, cfg, kgHook ?? undefined);
  registerPackagesTool(server, cfg, kgHook ?? undefined);
  registerResearchTool(server, cfg, kgHook ?? undefined);
  registerBrowserTool(server, cfg);

  // Conditional / gated tools
  registerFetchFocus(server, cfg);
  registerHealthCheck(server, cfg);

  // Knowledge graph tools (conditional on KG enabled)
  if (cfg.knowledgeGraph.enabled) {
    registerGraphIngestTool(server, cfg);
    registerGraphQueryTool(server, cfg);
    registerEntityLookupBatchTool(server, cfg);
    registerGraphStatusTool(server, cfg);
    registerGraphRebuildTool(server, cfg);
    registerFamilyListTool(server, cfg);
    registerFamilyGetTool(server, cfg);
    registerFamilyMergeTool(server, cfg);
    registerRunListTool(server, cfg);
    registerRunRollbackTool(server, cfg);
  }

  return { server, kgHook };
}
