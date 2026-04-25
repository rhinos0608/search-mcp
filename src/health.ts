/**
 * Health checking for MCP tools.
 *
 * Two layers:
 *   configHealth(cfg)    — sync, at startup: determines which tools get registered
 *   runHealthProbes(cfg) — async, on demand: config + rate limits + selective network pings
 */

import type { SearchConfig } from './config.js';
import { getTracker, type RateLimitedBackend } from './rateLimit.js';
import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ToolHealth {
  status: 'healthy' | 'degraded' | 'unconfigured' | 'rate_limited' | 'unreachable';
  message: string;
  remediation?: string | undefined;
  latencyMs?: number | undefined;
}

export interface HealthReport {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  tools: Record<string, ToolHealth>;
  timestamp: string;
}

// ── Gating rules (required config) ──────────────────────────────────────────

interface GateRule {
  check: (cfg: SearchConfig) => boolean;
  remediation: string;
}

const GATED_TOOLS: Record<string, GateRule> = {
  twitter_search: {
    check: (cfg) => cfg.nitter.baseUrl.length > 0,
    remediation: 'Set NITTER_BASE_URL environment variable pointing to a Nitter instance.',
  },
  youtube_search: {
    check: (cfg) => cfg.youtube.apiKey.length > 0,
    remediation: 'Set YOUTUBE_API_KEY environment variable (Google Cloud Console).',
  },
  producthunt_search: {
    check: (cfg) => cfg.producthunt.apiToken.length > 0,
    remediation: 'Set PRODUCTHUNT_API_TOKEN environment variable.',
  },
  patent_search: {
    check: (cfg) => cfg.patentsview.apiKey.length > 0,
    remediation: 'Set PATENTSVIEW_API_KEY environment variable (free at patentsview.org).',
  },
  podcast_search: {
    check: (cfg) => cfg.listennotes.apiKey.length > 0,
    remediation: 'Set LISTENNOTES_API_KEY environment variable.',
  },
  web_crawl: {
    check: (cfg) => cfg.crawl4ai.baseUrl.length > 0,
    remediation:
      'Set CRAWL4AI_BASE_URL to point at a running crawl4ai sidecar (e.g. http://localhost:11235). Run: docker run -d -p 11235:11235 unclecode/crawl4ai:latest',
  },
  semantic_crawl: {
    check: (cfg) => cfg.crawl4ai.baseUrl.length > 0 && cfg.embeddingSidecar.baseUrl.length > 0,
    remediation:
      'Set CRAWL4AI_BASE_URL and EMBEDDING_SIDECAR_BASE_URL. The embedding sidecar requires a running crawl4ai sidecar.',
  },
  semantic_youtube: {
    check: (cfg) => cfg.youtube.apiKey.length > 0 && cfg.embeddingSidecar.baseUrl.length > 0,
    remediation:
      'Set YOUTUBE_API_KEY (Google Cloud Console) and EMBEDDING_SIDECAR_BASE_URL to use semantic_youtube.',
  },
  semantic_reddit: {
    check: (cfg) => cfg.embeddingSidecar.baseUrl.length > 0,
    remediation: 'Set EMBEDDING_SIDECAR_BASE_URL to use semantic_reddit.',
  },
  semantic_jobs: {
    check: (cfg) =>
      cfg.embeddingSidecar.baseUrl.length > 0 &&
      (cfg.exa.apiKey.length > 0 || cfg.brave.apiKey.length > 0 || cfg.searxng.baseUrl.length > 0),
    remediation:
      'Set EMBEDDING_SIDECAR_BASE_URL and a search backend (EXA_API_KEY, BRAVE_API_KEY, or SEARXNG_BASE_URL) to use semantic_jobs.',
  },
};

// ── Optional config (works without, degraded) ──────────────────────────────

interface OptionalRule {
  check: (cfg: SearchConfig) => boolean;
  degradedMessage: string;
  remediation: string;
}

const OPTIONAL_CONFIG: Record<string, OptionalRule> = {
  web_search: {
    check: (cfg) =>
      cfg.exa.apiKey.length > 0 || cfg.brave.apiKey.length > 0 || cfg.searxng.baseUrl.length > 0,
    degradedMessage: 'No search backend configured — web_search calls will fail.',
    remediation: 'Set EXA_API_KEY, BRAVE_API_KEY, or SEARXNG_BASE_URL environment variable.',
  },
  stackoverflow_search: {
    check: (cfg) => cfg.stackexchange.apiKey.length > 0,
    degradedMessage: 'No API key — limited to 300 requests/day (shared IP quota).',
    remediation: 'Set STACKEXCHANGE_API_KEY for 10,000 requests/day (free at stackapps.com).',
  },
};

// Free tools — no config required
export const FREE_TOOLS = [
  'web_read',
  'github_repo',
  'github_repo_tree',
  'github_repo_file',
  'github_repo_search',
  'github_trending',
  'youtube_transcript',
  'reddit_search',
  'reddit_comments',
  'academic_search',
  'hackernews_search',
  'arxiv_search',
  'npm_search',
  'pypi_search',
  'news_search',
] as const;

// ── configHealth (sync, startup) ────────────────────────────────────────────

/**
 * Synchronous config check. Returns health status for every known tool.
 * Used at startup to decide which tools to register and to seed health_check.
 */
export function configHealth(cfg: SearchConfig): Record<string, ToolHealth> {
  const report: Record<string, ToolHealth> = {};

  // Gated tools: healthy or unconfigured
  for (const [tool, rule] of Object.entries(GATED_TOOLS)) {
    report[tool] = rule.check(cfg)
      ? { status: 'healthy', message: 'Configured.' }
      : {
          status: 'unconfigured',
          message: 'Missing required configuration.',
          remediation: rule.remediation,
        };
  }

  // Optional-config tools: healthy or degraded
  for (const [tool, rule] of Object.entries(OPTIONAL_CONFIG)) {
    report[tool] = rule.check(cfg)
      ? { status: 'healthy', message: 'Configured.' }
      : { status: 'degraded', message: rule.degradedMessage, remediation: rule.remediation };
  }

  // Free tools: always healthy at config level
  for (const tool of FREE_TOOLS) {
    report[tool] = { status: 'healthy', message: 'Free API, no configuration required.' };
  }

  // Synthesized Reddit OAuth config-layer indicator.
  // Surfaced as its own tool entry so health_check callers can see the
  // OAuth posture without inferring from reddit_search / reddit_comments.
  report.reddit_oauth = redditOAuthHealth(cfg);

  return report;
}

function redditOAuthHealth(cfg: SearchConfig): ToolHealth {
  const hasId = cfg.reddit.clientId !== '';

  if (!cfg.reddit.oauthConfigValid) {
    // Partial config: exactly one of clientId / clientSecret is present.
    const missing = hasId ? 'REDDIT_CLIENT_SECRET' : 'REDDIT_CLIENT_ID';
    return {
      status: 'degraded',
      message: `Reddit OAuth is partially configured — missing ${missing}. reddit_search and reddit_comments will fail at runtime until this is fixed.`,
      remediation: `Set ${missing}, or unset both REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET to use the unauthenticated public Reddit API.`,
    };
  }

  if (cfg.reddit.oauthEnabled) {
    return {
      status: 'healthy',
      message:
        'Reddit OAuth configured. Requests use https://oauth.reddit.com (100 QPM app-only quota).',
    };
  }

  return {
    status: 'healthy',
    message:
      'Reddit OAuth not configured (using public Reddit JSON API, ~10 QPM unauthenticated quota).',
    remediation:
      'Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET to enable OAuth and raise the quota to 100 QPM.',
  };
}

/**
 * Returns the set of tool names that should NOT be registered (missing required config).
 */
export function getGatedTools(cfg: SearchConfig): Set<string> {
  const gated = new Set<string>();
  for (const [tool, rule] of Object.entries(GATED_TOOLS)) {
    if (!rule.check(cfg)) {
      gated.add(tool);
    }
  }
  return gated;
}

// ── Rate limit check (no network) ──────────────────────────────────────────

function checkRateLimit(backend: RateLimitedBackend): ToolHealth | null {
  const tracker = getTracker(backend);

  if (!tracker.canProceed()) {
    const info = tracker.getInfo();
    const resetAt = info ? new Date(info.resetAt).toISOString() : 'unknown';
    return {
      status: 'rate_limited',
      message: `Rate limit exhausted. Resets at ${resetAt}.`,
      remediation: 'Wait for the rate limit window to reset.',
    };
  }

  const info = tracker.getInfo();
  if (info !== null && info.remaining <= 5) {
    return {
      status: 'degraded',
      message: `Rate limit low: ${String(info.remaining)}/${String(info.limit)} remaining.`,
    };
  }

  return null; // no issues
}

// ── Network probes (free APIs only) ─────────────────────────────────────────

const PROBE_TIMEOUT_MS = 5_000;

async function probeExtractionSupport(
  crawl4aiBaseUrl: string,
  apiToken: string,
): Promise<ToolHealth> {
  const endpoint = `${crawl4aiBaseUrl.replace(/\/+$/, '')}/crawl`;
  const body = {
    urls: ['data:text/html,<html><body><div class="item">Test</div></body></html>'],
    browser_config: { type: 'BrowserConfig', params: { headless: true } },
    crawler_config: {
      type: 'CrawlerRunConfig',
      params: {
        deep_crawl_strategy: {
          type: 'BFSDeepCrawlStrategy',
          params: { max_depth: 1, max_pages: 1, include_external: false },
        },
      },
    },
    extraction_config: {
      type: 'JsonCssExtractionStrategy',
      params: {
        schema: {
          name: 'Health Probe',
          baseSelector: '.item',
          fields: [{ name: 'text', selector: '.item', type: 'text' }],
        },
      },
    },
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'search-mcp/1.0',
  };
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return {
        status: 'degraded',
        message: `Crawl4AI sidecar returned HTTP ${String(res.status)} during extraction probe.`,
        remediation: 'Check that the Crawl4AI sidecar is running and healthy.',
      };
    }

    const raw = (await res.json()) as {
      result?: { extracted_content?: unknown };
      results?: { extracted_content?: unknown }[];
    };
    const page = raw.result ?? raw.results?.[0];
    if (page && 'extracted_content' in page) {
      return {
        status: 'healthy',
        message: 'Crawl4AI sidecar supports structured data extraction (v0.8.x+).',
      };
    }

    return {
      status: 'degraded',
      message: 'Crawl4AI sidecar does not report extraction support.',
      remediation: 'Upgrade Crawl4AI sidecar to v0.8.x or later for extraction support.',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'unreachable',
      message: `Extraction probe failed: ${msg}`,
      remediation: 'Check network connectivity to the Crawl4AI sidecar.',
    };
  }
}

async function probeUrl(url: string): Promise<number> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'search-mcp/1.0 health-check' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
    // Consume a small amount to confirm the body is valid
    await res.text();
    return Date.now() - start;
  } finally {
    clearTimeout(timeout);
  }
}

interface NetworkProbe {
  label: string;
  url: string;
  tools: string[];
}

export function getNetworkProbes(cfg: SearchConfig): NetworkProbe[] {
  const probes: NetworkProbe[] = [
    {
      label: 'github',
      url: 'https://api.github.com/rate_limit',
      tools: ['github_repo', 'github_repo_tree', 'github_repo_file', 'github_repo_search'],
    },
    {
      label: 'hackernews',
      url: 'https://hn.algolia.com/api/v1/search?query=test&hitsPerPage=1',
      tools: ['hackernews_search'],
    },
    {
      label: 'npm',
      url: 'https://registry.npmjs.org/-/v1/search?text=test&size=1',
      tools: ['npm_search'],
    },
  ];

  // SearXNG is self-hosted so probing it costs nothing
  if (cfg.searxng.baseUrl.length > 0) {
    probes.push({
      label: 'searxng',
      url: `${cfg.searxng.baseUrl.replace(/\/+$/, '')}/healthz`,
      tools: ['web_search'],
    });
  }

  if (cfg.crawl4ai.baseUrl.length > 0) {
    probes.push({
      label: 'crawl4ai',
      url: `${cfg.crawl4ai.baseUrl.replace(/\/+$/, '')}/health`,
      tools: ['web_crawl', 'semantic_crawl'],
    });
  }

  if (cfg.embeddingSidecar.baseUrl.length > 0) {
    probes.push({
      label: 'embedding-sidecar',
      url: `${cfg.embeddingSidecar.baseUrl.replace(/\/+$/, '')}/health`,
      tools: ['semantic_crawl'],
    });
  }

  return probes;
}

// ── Rate limit → tool mapping ───────────────────────────────────────────────

export const RATE_LIMIT_TOOL_MAP: [string, RateLimitedBackend][] = [
  ['web_search', 'brave'],
  ['reddit_search', 'reddit'],
  ['reddit_comments', 'reddit'],
  ['github_repo', 'github'],
  ['github_repo_tree', 'github'],
  ['github_repo_file', 'github'],
  ['github_repo_search', 'github_search'],
  ['academic_search', 'semantic_scholar'],
];

// ── runHealthProbes (async, on demand) ──────────────────────────────────────

/**
 * Full health report combining config checks, rate limit tracker state,
 * and selective network probes for free APIs. No caching — always live.
 */
export async function runHealthProbes(cfg: SearchConfig): Promise<HealthReport> {
  const tools = configHealth(cfg);

  // Layer 2: rate limit tracker state (no network)
  for (const [tool, backend] of RATE_LIMIT_TOOL_MAP) {
    const existing = tools[tool];
    if (existing === undefined || existing.status === 'unconfigured') continue;

    const rlHealth = checkRateLimit(backend);
    if (rlHealth !== null) {
      tools[tool] = rlHealth;
    }
  }

  // Layer 3: network probes for free APIs (parallel, 5s timeout each)
  const probes = getNetworkProbes(cfg);
  const probeResults = await Promise.allSettled(
    probes.map(async (probe) => {
      const latencyMs = await probeUrl(probe.url);
      return { probe, latencyMs };
    }),
  );

  for (const result of probeResults) {
    if (result.status === 'fulfilled') {
      const { probe, latencyMs } = result.value;
      for (const tool of probe.tools) {
        const existing = tools[tool];
        if (existing === undefined || existing.status === 'unconfigured') continue;
        // Enrich with latency if healthy, don't downgrade rate_limited/degraded
        if (existing.status === 'healthy') {
          tools[tool] = { ...existing, latencyMs };
        }
      }
    } else {
      const probe = probes[probeResults.indexOf(result)];
      if (probe === undefined) continue;
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.warn({ probe: probe.label, error: msg }, 'Health probe failed');
      for (const tool of probe.tools) {
        const existing = tools[tool];
        if (existing === undefined || existing.status === 'unconfigured') continue;
        tools[tool] = {
          status: 'unreachable',
          message: `${probe.label} probe failed: ${msg}`,
          remediation: 'Check network connectivity or upstream API status.',
        };
      }
    }
  }

  // Extraction capability probe (only when crawl4ai is configured)
  if (cfg.crawl4ai.baseUrl.length > 0) {
    const extractionHealth = await probeExtractionSupport(
      cfg.crawl4ai.baseUrl,
      cfg.crawl4ai.apiToken,
    );
    tools.web_crawl_extraction = extractionHealth;
    tools.semantic_crawl_extraction = extractionHealth;
  }

  // Compute overall status keyed on web_search as primary
  const webSearchStatus = tools.web_search?.status ?? 'unconfigured';
  const otherStatuses = Object.entries(tools)
    .filter(([name]) => name !== 'web_search')
    .map(([, h]) => h.status);
  const hasOtherIssues = otherStatuses.some((s) => s === 'rate_limited' || s === 'unreachable');

  let overall: 'healthy' | 'degraded' | 'unhealthy';
  if (webSearchStatus === 'healthy') {
    overall = hasOtherIssues ? 'degraded' : 'healthy';
  } else if (webSearchStatus === 'degraded' || webSearchStatus === 'rate_limited') {
    overall = 'degraded';
  } else {
    // unconfigured or unreachable
    overall = 'unhealthy';
  }

  return {
    overall,
    tools,
    timestamp: new Date().toISOString(),
  };
}
