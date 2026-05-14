import type { Page } from 'playwright-core';
import type {
  NetworkBlockConfig,
  NetworkInjectConfig,
  NetworkModifyConfig,
  NetworkInterceptResult,
} from './types.js';

/** Active intercept rules per page. */
const activeRulesByPage = new WeakMap<Page, { type: string; pattern: string }[]>();

function getRules(page: Page): { type: string; pattern: string }[] {
  let rules = activeRulesByPage.get(page);
  if (!rules) {
    rules = [];
    activeRulesByPage.set(page, rules);
  }
  return rules;
}

/**
 * Block specified resource types and/or URL patterns.
 * Use this to speed up page loads by 30-50% by blocking
 * tracking scripts, analytics, images, fonts, etc.
 */
export async function blockResources(
  page: Page,
  config: NetworkBlockConfig,
): Promise<NetworkInterceptResult> {
  const { blockTypes, blockPatterns, allowPatterns } = config;
  const rules = getRules(page);
  let rulesApplied = 0;

  // Block by resource type
  if (blockTypes && blockTypes.length > 0) {
    await page.route('**/*', (route, request) => {
      const resourceType = request.resourceType();

      // Check allow-list first
      if (allowPatterns?.some((p) => matchGlob(request.url(), p))) {
        route.continue().catch(() => { /* intentionally empty */ });
        return;
      }

      if (blockTypes.includes(resourceType as typeof blockTypes[number])) {
        route.abort().catch(() => { /* intentionally empty */ });
      } else {
        route.continue().catch(() => { /* intentionally empty */ });
      }
    });

    rulesApplied++;
    rules.push({ type: 'block-types', pattern: blockTypes.join(',') });
  }

  // Block by URL pattern
  if (blockPatterns && blockPatterns.length > 0) {
    for (const pattern of blockPatterns) {
      await page.route(pattern, (route) => {
        route.abort().catch(() => { /* intentionally empty */ });
      });
      rulesApplied++;
      rules.push({ type: 'block-pattern', pattern });
    }
  }

  return { operation: 'block', rulesApplied, activeRules: [...rules] };
}

/**
 * Inject custom headers into outgoing requests.
 * Useful for adding auth tokens, custom user-agent overrides,
 * or API keys to specific endpoints.
 */
export async function injectHeaders(
  page: Page,
  config: NetworkInjectConfig,
): Promise<NetworkInterceptResult> {
  const { patterns, headers } = config;
  const rules = getRules(page);
  let rulesApplied = 0;

  if (patterns && patterns.length > 0) {
    for (const pattern of patterns) {
      await page.route(pattern, async (route) => {
        const newHeaders = { ...route.request().headers(), ...headers };
        try {
          await route.continue({ headers: newHeaders });
        } catch {
          route.abort().catch(() => { /* intentionally empty */ });
        }
      });
      rulesApplied++;
      rules.push({ type: 'inject-headers', pattern });
    }
  } else {
    // Apply to all requests
    await page.route('**/*', async (route) => {
      const newHeaders = { ...route.request().headers(), ...headers };
      try {
        await route.continue({ headers: newHeaders });
      } catch {
        route.abort().catch(() => { /* intentionally empty */ });
      }
    });
    rulesApplied = 1;
    rules.push({ type: 'inject-headers', pattern: '**/*' });
  }

  return { operation: 'inject', rulesApplied, activeRules: [...rules] };
}

/**
 * Mock or modify API responses.
 * Replace response status, body, and headers for matched requests.
 */
export async function modifyResponse(
  page: Page,
  config: NetworkModifyConfig,
): Promise<NetworkInterceptResult> {
  const rules = getRules(page);
  let rulesApplied = 0;

  for (const pattern of config.patterns) {
    await page.route(pattern, async (route) => {
      const fulfillOptions: Parameters<typeof route.fulfill>[0] = {
        status: config.status ?? 200,
      };
      if (config.body !== undefined) fulfillOptions.body = config.body;
      if (config.headers !== undefined) fulfillOptions.headers = config.headers;
      await route.fulfill(fulfillOptions);
    });
    rulesApplied++;
    rules.push({ type: 'modify-response', pattern });
  }

  return { operation: 'modify', rulesApplied, activeRules: [...rules] };
}

/**
 * Remove all network intercept rules from the page.
 */
export async function removeAllIntercepts(page: Page): Promise<NetworkInterceptResult> {
  const rules = getRules(page);
  const count = rules.length;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  rules.length = 0;
  return { operation: 'unblock', rulesApplied: count, activeRules: [] };
}

/** List all active intercept rules. */
export function listIntercepts(page?: Page): NetworkInterceptResult {
  const rules = page ? getRules(page) : [];
  return {
    operation: 'list-intercepts',
    rulesApplied: rules.length,
    activeRules: [...rules],
  };
}

/** Maximum wildcard segments allowed in a glob pattern to prevent ReDoS. */
const MAX_GLOB_SEGMENTS = 32;
/** Maximum pattern length to guard against extremely long inputs. */
const MAX_GLOB_LENGTH = 1024;

/**
 * Safe glob pattern matching without regex (prevents ReDoS).
 * Supports * (match within a path segment) and ** (match across segments).
 */
function matchGlob(url: string, pattern: string): boolean {
  // Reject overly complex patterns
  if (pattern.length > MAX_GLOB_LENGTH) return false;
  const segmentCount = (pattern.match(/\*{1,2}/g) ?? []).length;
  if (segmentCount > MAX_GLOB_SEGMENTS) return false;

  // Fast path: no wildcards
  if (!pattern.includes('*')) {
    return url === pattern;
  }

  // Fast path: single trailing /**/
  if (pattern === '**/*') return true;

  // Convert glob to segments and match sequentially
  const segments = pattern.split('/');
  const urlSegments = url.split('/');
  let si = 0;
  let ui = 0;

  for (; si < segments.length && ui < urlSegments.length; si++) {
    const seg = segments[si];
    if (!seg) continue;
    if (seg === '**') {
      // Match zero or more segments greedily, then tail-match the rest
      const rest = segments.slice(si + 1);
      if (rest.length === 0) return true; // trailing ** matches everything
      for (let uj = ui; uj <= urlSegments.length - rest.length; uj++) {
        if (segmentsMatch(urlSegments.slice(uj, uj + rest.length), rest)) {
          return true;
        }
      }
      return false;
    } else if (seg.includes('*')) {
      // Segment with single * wildcards: match within one path segment
      if (!singleSegmentMatch(urlSegments[ui] ?? '', seg)) return false;
      ui++;
    } else {
      // Literal segment match
      if (urlSegments[ui] !== seg) return false;
      ui++;
    }
  }

  return si === segments.length && ui === urlSegments.length;
}

/** Match a single URL segment against a glob segment that may contain * wildcards. */
function singleSegmentMatch(urlSeg: string, globSeg: string): boolean {
  let gi = 0;
  let ui = 0;
  while (gi < globSeg.length) {
    if (globSeg[gi] === '*') {
      gi++;
      if (gi >= globSeg.length) return true; // trailing * matches rest
      // Find next literal char after *
      const nextLit = globSeg[gi];
      if (!nextLit) return false;
      const idx = urlSeg.indexOf(nextLit, ui);
      if (idx === -1) return false;
      ui = idx;
    } else {
      if (ui >= urlSeg.length || urlSeg[ui] !== globSeg[gi]) return false;
      gi++;
      ui++;
    }
  }
  return ui === urlSeg.length;
}

/** Match an array of URL segments against an array of literal/glob segments (no **). */
function segmentsMatch(urlParts: string[], globParts: string[]): boolean {
  if (urlParts.length !== globParts.length) return false;
  for (let i = 0; i < globParts.length; i++) {
    const gp = globParts[i];
    const up = urlParts[i];
    if (!gp || !up) return false;
    if (gp.includes('*')) {
      if (!singleSegmentMatch(up, gp)) return false;
    } else {
      if (up !== gp) return false;
    }
  }
  return true;
}
