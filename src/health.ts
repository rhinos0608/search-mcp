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
};

// ── Optional config (works without, degraded) ──────────────────────────────

interface OptionalRule {
  check: (cfg: SearchConfig) => boolean;
  degradedMessage: string;
  remediation: string;
}

const OPTIONAL_CONFIG: Record<string, OptionalRule> = {
  web_search: {
    check: (cfg) => cfg.brave.apiKey.length > 0 || cfg.searxng.baseUrl.length > 0,
    degradedMessage: 'No search backend configured — web_search calls will fail.',
    remediation: 'Set BRAVE_API_KEY or SEARXNG_BASE_URL environment variable.',
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
  'github_tree',
  'github_file',
  'github_code_search',
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
    { label: 'github', url: 'https://api.github.com/rate_limit', tools: ['github_repo', 'github_code_search'] },
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

  return probes;
}

// ── Rate limit → tool mapping ───────────────────────────────────────────────

export const RATE_LIMIT_TOOL_MAP: [string, RateLimitedBackend][] = [
  ['web_search', 'brave'],
  ['reddit_search', 'reddit'],
  ['reddit_comments', 'reddit'],
  ['github_repo', 'github'],
  ['github_code_search', 'github_search'],
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
