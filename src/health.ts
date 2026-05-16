/**
 * Health checking for MCP tools.
 *
 * Two layers:
 *   configHealth(cfg)    — sync, at startup: determines which tools get registered
 *   runHealthProbes(cfg) — async, on demand: config + rate limits + selective network pings
 */

import type { SearchConfig } from './config.js';
import { getTracker, type RateLimitedBackend } from './rateLimit.js';
import { safeResponseText, safeResponseJson } from './httpGuards.js';
import { logger } from './logger.js';
import { getUserAgent } from './version.js';
import { jobSpyHealth } from './utils/jobspyClient.js';
import { youtubeCapabilities } from './tools/families/youtube.js';
import { redditCapabilities } from './tools/families/reddit.js';
import { gitHubCapabilities } from './tools/families/github.js';
import { packagesCapabilities } from './tools/families/packages.js';
import { researchCapabilities } from './tools/families/research.js';
import { browserCapabilities } from './tools/families/browser.js';

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
  semantic_jobs: {
    check: (cfg) =>
      cfg.embeddingSidecar.baseUrl.length > 0 &&
      ((cfg.exa.apiKey ?? '').length > 0 ||
        (cfg.brave.apiKey ?? '').length > 0 ||
        cfg.searxng.baseUrl.length > 0),
    remediation:
      'Set EMBEDDING_SIDECAR_BASE_URL and a search backend (EXA_API_KEY, BRAVE_API_KEY, or SEARXNG_BASE_URL) to use semantic_jobs.',
  },
  deep_research: {
    check: (cfg) => cfg.deepResearch.enabled,
    remediation: 'Set DEEP_RESEARCH_ENABLED=true to enable the deep research orchestration engine.',
  },
  fetch_focus: {
    check: (cfg) =>
      cfg.crawl4ai.baseUrl.length > 0 &&
      cfg.deepResearch.baseUrl.length > 0 &&
      cfg.deepResearch.model.length > 0,
    remediation:
      'Set CRAWL4AI_BASE_URL plus DEEP_RESEARCH_BASE_URL and DEEP_RESEARCH_MODEL to enable fetch_focus.',
  },
  browser: {
    check: (cfg) => cfg.browser.enabled,
    remediation:
      'Set BROWSER_ENABLED=true to enable interactive browser control via Playwright + CDP.',
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
      (cfg.exa.apiKey ?? '').length > 0 ||
      (cfg.brave.apiKey ?? '').length > 0 ||
      cfg.searxng.baseUrl.length > 0 ||
      (cfg.tavily.apiKey ?? '').length > 0,
    degradedMessage: 'No search backend configured — web_search calls will fail.',
    remediation:
      'Set EXA_API_KEY, BRAVE_API_KEY, SEARXNG_BASE_URL, or TAVILY_API_KEY environment variable.',
  },
};

// (stackoverflow_search moved to research family — see researchCapabilities)

// Free tools — no config required
export const FREE_TOOLS = ['web_read'] as const;

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
      : {
          status: 'degraded',
          message: rule.degradedMessage,
          remediation: rule.remediation,
        };
  }

  // Free tools: always healthy at config level
  for (const tool of FREE_TOOLS) {
    report[tool] = {
      status: 'healthy',
      message: 'Free API, no configuration required.',
    };
  }

  // Synthesized Reddit OAuth config-layer indicator.
  // Surfaced as its own tool entry so health_check callers can see the
  // OAuth posture without having to parse the reddit family entries.
  report.reddit_oauth = redditOAuthHealth(cfg);

  // Synthesized RAG-Anything bridge indicator.
  report.raga_bridge = ragaBridgeHealth(cfg);

  // Family tool capabilities (per-action breakdown).
  for (const cap of youtubeCapabilities(cfg)) {
    report[cap.name] = cap.available
      ? { status: 'healthy' as const, message: 'Configured.' }
      : {
          status: 'unconfigured' as const,
          message: 'Missing required configuration.',
          remediation: cap.issue ?? undefined,
        };
  }

  for (const cap of redditCapabilities(cfg)) {
    report[cap.name] = cap.available
      ? { status: 'healthy' as const, message: 'Configured.' }
      : {
          status: 'unconfigured' as const,
          message: 'Missing required configuration.',
          remediation: cap.issue ?? undefined,
        };
  }

  for (const cap of gitHubCapabilities(cfg)) {
    report[cap.name] = cap.available
      ? { status: 'healthy' as const, message: 'Configured.' }
      : {
          status: 'unconfigured' as const,
          message: 'Missing required configuration.',
          remediation: cap.issue ?? undefined,
        };
  }

  for (const cap of packagesCapabilities(cfg)) {
    report[cap.name] = cap.available
      ? { status: 'healthy' as const, message: 'Configured.' }
      : {
          status: 'unconfigured' as const,
          message: 'Missing required configuration.',
        };
  }

  for (const cap of researchCapabilities(cfg)) {
    report[cap.name] = cap.available
      ? { status: 'healthy' as const, message: 'Configured.' }
      : {
          status: 'unconfigured' as const,
          message: 'Missing required configuration.',
          ...(cap.issue ? { remediation: cap.issue } : {}),
        };
  }

  for (const cap of browserCapabilities(cfg)) {
    report[cap.name] = cap.available
      ? { status: 'healthy' as const, message: 'Configured.' }
      : {
          status: 'unconfigured' as const,
          message: 'Missing required configuration.',
          ...(cap.issue ? { remediation: cap.issue } : {}),
        };
  }

  return report;
}

async function jobSpyProbe(): Promise<ToolHealth> {
  try {
    const ok = await jobSpyHealth();
    if (ok) {
      return { status: 'healthy', message: 'JobSpy library functional and reachable.' };
    }
  } catch (err) {
    return {
      status: 'degraded',
      message: `JobSpy health probe failed: ${err instanceof Error ? err.message : String(err)}`,
      remediation: 'Check network connectivity or if job boards are blocking requests.',
    };
  }

  return {
    status: 'degraded',
    message: 'JobSpy health probe failed.',
    remediation: 'Check network connectivity or if job boards are blocking requests.',
  };
}

function redditOAuthHealth(cfg: SearchConfig): ToolHealth {
  const hasId = (cfg.reddit.clientId ?? '') !== '';

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

function ragaBridgeHealth(cfg: SearchConfig): ToolHealth {
  if (!cfg.raga.enabled) {
    return {
      status: 'unconfigured',
      message:
        'RAG-Anything bridge is disabled. Set RAGA_ENABLED=true to enable multimodal document extraction (PDF, Office, OCR).',
      remediation:
        'Set RAGA_ENABLED=true and RAGA_BRIDGE_URL to point at a running rag-anything-bridge service.',
    };
  }

  if (!cfg.raga.baseUrl || cfg.raga.baseUrl.length === 0) {
    return {
      status: 'degraded',
      message: 'RAG-Anything bridge is enabled but RAGA_BRIDGE_URL is not set.',
      remediation:
        'Set RAGA_BRIDGE_URL to point at the rag-anything-bridge service (e.g. http://localhost:8002).',
    };
  }

  return {
    status: 'healthy',
    message: `RAG-Anything bridge configured at ${cfg.raga.baseUrl} (parser: ${cfg.raga.defaultParser}).`,
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
    urls: ['https://example.com'],
    browser_config: { type: 'BrowserConfig', params: { headless: true } },
    crawler_config: {
      type: 'CrawlerRunConfig',
      params: {
        deep_crawl_strategy: {
          type: 'BFSDeepCrawlStrategy',
          params: {
            max_depth: 0,
            max_pages: 1,
            include_external: false,
          },
        },
      },
    },
    extraction_config: {
      type: 'JsonCssExtractionStrategy',
      params: {
        schema: {
          name: 'Health Probe',
          baseSelector: 'h1',
          fields: [{ name: 'text', selector: 'h1', type: 'text' }],
        },
      },
    },
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': getUserAgent(),
  };
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      logger.warn(
        { status: res.status, endpoint },
        'probeExtractionSupport: sidecar returned non-OK for extraction test',
      );
      return {
        status: 'degraded',
        message: `Crawl4AI sidecar returned HTTP ${String(res.status)} during extraction probe (sidecar may not support extraction).`,
        remediation: 'Upgrade Crawl4AI sidecar to v0.8.x or later for extraction support.',
      };
    }

    const raw = (await safeResponseJson(res, endpoint)) as {
      result?: { extracted_content?: unknown; success?: boolean };
      results?: { extracted_content?: unknown; success?: boolean }[];
      success?: boolean;
      error?: string;
    };

    if (raw.success === false && typeof raw.error === 'string') {
      return {
        status: 'degraded',
        message: `Crawl4AI sidecar error: ${raw.error}`,
        remediation: 'Check Crawl4AI sidecar logs for extraction-related errors.',
      };
    }

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
      headers: { 'User-Agent': getUserAgent('health-check') },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
    await safeResponseText(res, url);
    return Date.now() - start;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Sidecar-aware probes (parse /health JSON body) ───────────────────────────

interface SidecarHealthBody {
  modelLoaded?: boolean | undefined;
  model?: string | undefined;
  upstream?: string | undefined;
  torchDtype?: string | undefined;
  detail?: string | undefined;
}

async function probeSidecarUrl(
  url: string,
): Promise<{ latencyMs: number; body: SidecarHealthBody }> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': getUserAgent('health-check') },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;

    let body: SidecarHealthBody = {};
    const text = await res.text();
    try {
      body = JSON.parse(text) as SidecarHealthBody;
    } catch {
      /* ignore non-JSON body */
    }

    if (!res.ok) {
      const detail = typeof body.detail === 'string' ? body.detail : `HTTP ${String(res.status)}`;
      throw new Error(detail);
    }

    return { latencyMs, body };
  } finally {
    clearTimeout(timeout);
  }
}

function sidecarStatusMessage(label: string, body: SidecarHealthBody): string {
  const model = body.model ?? 'unknown';
  if (label === 'embedding-sidecar') {
    if (body.upstream !== undefined) {
      return `OpenAI-compatible proxy at ${body.upstream}, model: ${model}`;
    }
    if (body.torchDtype !== undefined) {
      return `Torch sidecar, model: ${model}, dtype: ${body.torchDtype}`;
    }
    return `Embedding sidecar running, model: ${model}`;
  }
  return `${label} running`;
}

const SIDECAR_LABELS = new Set(['embedding-sidecar']);

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
      tools: ['github.repo', 'github.tree', 'github.file', 'github.search'],
    },
    {
      label: 'hackernews',
      url: 'https://hn.algolia.com/api/v1/search?query=test&hitsPerPage=1',
      tools: ['research.hackernews'],
    },
    {
      label: 'npm',
      url: 'https://registry.npmjs.org/-/v1/search?text=test&size=1',
      tools: ['packages.npm'],
    },
    {
      label: 'pubmed',
      url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi?retmode=json',
      tools: ['research.pubmed'],
    },
    {
      label: 'wikipedia',
      url: 'https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srsearch=test',
      tools: ['research.wikipedia'],
    },
    {
      label: 'semantic-scholar',
      url: 'https://api.semanticscholar.org/graph/v1/paper/search?query=test&limit=1&fields=title',
      tools: ['research.academic', 'research.semantic_scholar'],
    },
    {
      label: 'openalex',
      url: 'https://api.openalex.org/works?search=test&per_page=1',
      tools: ['research.openalex'],
    },
    {
      label: 'crossref',
      url: 'https://api.crossref.org/works?query=test&rows=1',
      tools: ['research.crossref'],
    },
    {
      label: 'datacite',
      url: 'https://api.datacite.org/dois?query=test&page%5Bsize%5D=1',
      tools: ['research.datacite'],
    },
    {
      label: 'ror',
      url: 'https://api.ror.org/v2/organizations?query=stanford',
      tools: ['research.ror'],
    },
    {
      label: 'gdelt',
      url: 'https://api.gdeltproject.org/api/v2/doc/doc?query=test&mode=ArtList&format=json&maxrecords=1',
      tools: ['research.gdelt'],
    },
    {
      label: 'wikidata',
      url: 'https://www.wikidata.org/w/api.php?action=wbsearchentities&search=test&language=en&format=json',
      tools: ['research.wikidata'],
    },
  ];

  if (cfg.searxng.baseUrl.length > 0) {
    probes.push({
      label: 'searxng',
      url: `${cfg.searxng.baseUrl.replace(/\/+$/, '')}/healthz`,
      tools: ['web_search'],
    });
  }

  if (cfg.embeddingSidecar.baseUrl.length > 0) {
    probes.push({
      label: 'embedding-sidecar',
      url: `${cfg.embeddingSidecar.baseUrl.replace(/\/+$/, '')}/health`,
      tools: ['semantic_crawl'],
    });
  }

  if (cfg.raga.enabled && cfg.raga.baseUrl.length > 0) {
    probes.push({
      label: 'raga-bridge',
      url: `${cfg.raga.baseUrl.replace(/\/+$/, '')}/health`,
      tools: ['web_read', 'raga_bridge'],
    });
  }

  return probes;
}

// ── Rate limit → tool mapping ───────────────────────────────────────────────

export const RATE_LIMIT_TOOL_MAP: [string, RateLimitedBackend][] = [
  ['web_search', 'brave'],
  ['reddit.search', 'reddit'],
  ['reddit.comments', 'reddit'],
  ['github.repo', 'github'],
  ['github.tree', 'github'],
  ['github.file', 'github'],
  ['github.search', 'github_search'],
  ['research.academic', 'semantic_scholar'],
  ['research.semantic_scholar', 'semantic_scholar'],
];

// ── runHealthProbes (async, on demand) ──────────────────────────────────────

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
      if (SIDECAR_LABELS.has(probe.label)) {
        const { latencyMs, body } = await probeSidecarUrl(probe.url);
        return { probe, latencyMs, sidecarBody: body };
      }
      const latencyMs = await probeUrl(probe.url);
      return { probe, latencyMs, sidecarBody: null as SidecarHealthBody | null };
    }),
  );

  for (const result of probeResults) {
    if (result.status === 'fulfilled') {
      const { probe, latencyMs, sidecarBody } = result.value;
      for (const tool of probe.tools) {
        const existing = tools[tool];
        if (existing === undefined || existing.status === 'unconfigured') continue;
        if (existing.status === 'healthy') {
          const message =
            sidecarBody !== null ? sidecarStatusMessage(probe.label, sidecarBody) : 'Configured.';
          tools[tool] = { ...existing, latencyMs, message };
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
        if (tool === 'web_read') {
          tools[tool] = {
            status: 'degraded',
            message: `${probe.label} probe failed: ${msg} (Readability fallback still available).`,
            remediation: `Check the ${probe.label} service. Readability-based extraction will be used as fallback.`,
          };
        } else {
          tools[tool] = {
            status: 'unreachable',
            message: `${probe.label} probe failed: ${msg}`,
            remediation: 'Check network connectivity or upstream API status.',
          };
        }
      }
    }
  }

  // Extraction capability probe (only when crawl4ai is configured)
  if (cfg.crawl4ai.baseUrl.length > 0) {
    const extractionHealth = await probeExtractionSupport(
      cfg.crawl4ai.baseUrl,
      cfg.crawl4ai.apiToken ?? '',
    );
    tools.web_crawl_extraction = extractionHealth;
    tools.semantic_crawl_extraction = extractionHealth;
  }

  // JobSpy synthesized probe
  tools.jobspy = await jobSpyProbe();

  // Browser probe — config-only, no network check in v1 (launched on-demand)
  if (cfg.browser.enabled) {
    tools.browser = { status: 'healthy', message: 'Browser control enabled (Playwright + CDP).' };
  } else {
    tools.browser = {
      status: 'unconfigured',
      message: 'Browser control is disabled.',
      remediation:
        'Set BROWSER_ENABLED=true to enable interactive browser control via Playwright + CDP.',
    };
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
    overall = 'unhealthy';
  }

  return {
    overall,
    tools,
    timestamp: new Date().toISOString(),
  };
}

export async function probeConfiguredSidecars(cfg: SearchConfig): Promise<void> {
  const probes: { label: string; url: string }[] = [];

  if (cfg.embeddingSidecar.baseUrl.length > 0) {
    probes.push({
      label: 'embedding-sidecar',
      url: `${cfg.embeddingSidecar.baseUrl.replace(/\/+$/, '')}/health`,
    });
  }

  if (probes.length === 0) return;

  await Promise.allSettled(
    probes.map(async (probe) => {
      try {
        const { latencyMs, body } = await probeSidecarUrl(probe.url);
        logger.info(
          { probe: probe.label, latencyMs, status: sidecarStatusMessage(probe.label, body) },
          'Sidecar reachable at startup',
        );
      } catch (err) {
        logger.warn(
          { probe: probe.label, error: err instanceof Error ? err.message : String(err) },
          'Sidecar unreachable at startup — dependent tools will fail until it becomes available',
        );
      }
    }),
  );
}
