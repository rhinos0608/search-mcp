/**
 * Research policy normalization and prompt-building pipeline.
 *
 * Normalizes loosely-typed user-facing research configuration into a
 * strongly-typed internal policy, then constructs mode-appropriate system prompts.
 */

import type { ResearchDepth } from './types.js';

// Re-export ResearchDepth so callers can reference it without importing from types.ts
export type { ResearchDepth };

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Research mode — governs prompt style, source-type priorities, and output format.
 */
export type ResearchMode = 'general' | 'code' | 'company' | 'similar' | 'deep';

/**
 * Loosely-typed raw user input. All fields are optional and typed as unknown
 * to accommodate multiple naming conventions and serialization formats.
 */
export interface RawResearchPolicy {
  mode?: unknown;
  type?: unknown;
  livecrawl?: unknown;
  category?: unknown;
  country?: unknown;
  includeDomains?: unknown;
  excludeDomains?: unknown;
  includeText?: unknown;
  excludeText?: unknown;
  preferredDomains?: unknown;
  seedUrls?: unknown;
  customInstruction?: unknown;
  instructions?: unknown;
  instruction?: unknown;
  numResults?: unknown;
  maxHops?: unknown;
  startPublishedDate?: unknown;
  endPublishedDate?: unknown;
  [key: string]: unknown;
}

/**
 * Strongly-typed normalized research policy. All fields have safe defaults.
 */
export interface NormalizedResearchPolicy {
  advanced: boolean;
  mode: ResearchMode;
  includeDomains: string[];
  excludeDomains: string[];
  includeText: string[];
  excludeText: string[];
  preferredDomains: string[];
  seedUrls: string[];
  customInstruction: string | null;
  requestedMaxPages: number | null;
  requestedMaxHops: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseList(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof input === 'string') {
    return input
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

// ── Normalization ──────────────────────────────────────────────────────────────

/**
 * Normalize a RawResearchPolicy into a strongly-typed NormalizedResearchPolicy.
 *
 * Default behaviour:
 * - `mode` falls back to `'general'`
 * - `numResults` is clamped 0–40, `maxHops` is clamped 0–8
 * - List fields are parsed from comma-separated strings or arrays
 * - `advanced` is set to true when any non-default value is present
 */
export function normalizeResearchPolicy(raw?: RawResearchPolicy): NormalizedResearchPolicy {
  const r = raw ?? {};

  // Mode — normalise from 'type' or 'mode' field
  const rawMode = r.mode ?? r.type;
  let modeStr = 'general';
  if (typeof rawMode === 'string') {
    modeStr = rawMode.toLowerCase();
  }
  let mode: ResearchMode = 'general';
  switch (modeStr) {
    case 'code':
    case 'company':
    case 'similar':
    case 'deep':
      mode = modeStr;
      break;
  }

  // List fields — parse comma-separated strings or arrays
  const includeDomains = parseList(r.includeDomains);
  const excludeDomains = parseList(r.excludeDomains);
  const includeText = parseList(r.includeText);
  const excludeText = parseList(r.excludeText);
  const preferredDomains = parseList(r.preferredDomains);
  const seedUrls = parseList(r.seedUrls);

  // Numeric fields — parse and clamp
  // Note: `|| null` is only used as a fallback when the field was not provided.
  // If the user explicitly passed 0, clamp(0, 0, 40) returns 0 and we return 0.
  let requestedMaxPages: number | null;
  if (r.numResults === undefined) {
    requestedMaxPages = null;
  } else if (typeof r.numResults === 'number') {
    requestedMaxPages = clamp(r.numResults, 0, 40);
  } else if (typeof r.numResults === 'string') {
    const parsed = parseInt(r.numResults, 10);
    requestedMaxPages = Number.isNaN(parsed) ? null : clamp(parsed, 0, 40);
  } else {
    requestedMaxPages = null;
  }

  let requestedMaxHops: number | null;
  if (r.maxHops === undefined) {
    requestedMaxHops = null;
  } else if (typeof r.maxHops === 'number') {
    requestedMaxHops = clamp(r.maxHops, 0, 8);
  } else if (typeof r.maxHops === 'string') {
    const parsed = parseInt(r.maxHops, 10);
    requestedMaxHops = Number.isNaN(parsed) ? null : clamp(parsed, 0, 8);
  } else {
    requestedMaxHops = null;
  }

  // Custom instruction — prefer 'customInstruction', fall back to 'instructions' or 'instruction'
  const rawInstruction = r.customInstruction ?? r.instructions ?? r.instruction ?? null;
  const customInstruction =
    typeof rawInstruction === 'string' && rawInstruction.trim().length > 0
      ? rawInstruction.trim()
      : null;

  // Advanced flag — true when any non-default value is set
  const advanced =
    includeDomains.length > 0 ||
    excludeDomains.length > 0 ||
    includeText.length > 0 ||
    excludeText.length > 0 ||
    preferredDomains.length > 0 ||
    seedUrls.length > 0 ||
    customInstruction !== null ||
    requestedMaxPages !== null ||
    requestedMaxHops !== null ||
    mode !== 'general';

  return {
    advanced,
    mode,
    includeDomains,
    excludeDomains,
    includeText,
    excludeText,
    preferredDomains,
    seedUrls,
    customInstruction,
    requestedMaxPages,
    requestedMaxHops,
  };
}

// ── Prompt building ────────────────────────────────────────────────────────────

/**
 * Construct a system prompt for deep research from a normalized policy.
 *
 * @param policy  - Normalized research policy
 * @param query   - The user's research question
 * @param pageBudget  - Hard limit on crawl pages
 * @param hopLimit    - Hard limit on link-follow hops
 */
export function buildResearchPrompt(
  policy: NormalizedResearchPolicy,
  query: string,
  pageBudget: number,
  hopLimit: number,
): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push(
    `You are an exhaustive deep research agent conducting thorough multi-source investigation.`,
  );
  lines.push(`Today: ${today}`);
  lines.push(``);
  lines.push(`Research question: ${query}`);
  lines.push(``);

  // Output format — mode-dependent
  if (policy.mode === 'deep') {
    lines.push(`OUTPUT FORMAT:`);
    lines.push(
      `Structure your answer with clear headings, sections for each major sub-topic, and a list of sources at the end.`,
    );
    lines.push(`Each claim should be traceable to a specific source.`);
  } else {
    lines.push(`OUTPUT FORMAT:`);
    lines.push(`Use the SOURCES block format. After your analysis, include a section like:`);
    lines.push(``);
    lines.push(`SOURCES:`);
    lines.push(`[1] <title> — <URL>`);
    lines.push(`[2] <title> — <URL>`);
    lines.push(``);
    lines.push(`Cite sources using [N] notation within the text.`);
  }
  lines.push(``);

  // Budget constraints
  lines.push(`BUDGET CONSTRAINTS:`);
  lines.push(`- Page limit: ${String(pageBudget)} pages (do not exceed)`);
  lines.push(`- Link-hop limit: ${String(hopLimit)} hops from seed URLs`);
  lines.push(``);

  // Domain filters
  if (policy.includeDomains.length > 0) {
    lines.push(`ALLOWED DOMAINS only: ${policy.includeDomains.join(', ')}`);
    lines.push(``);
  }
  if (policy.excludeDomains.length > 0) {
    lines.push(`BLOCKED DOMAINS: ${policy.excludeDomains.join(', ')}`);
    lines.push(``);
  }
  if (policy.preferredDomains.length > 0) {
    lines.push(
      `PREFERRED DOMAINS: ${policy.preferredDomains.join(', ')} (search here first when relevant)`,
    );
    lines.push(``);
  }

  // Seed URLs
  if (policy.seedUrls.length > 0) {
    lines.push(`SEED URLS (start here, then branch out):`);
    for (const url of policy.seedUrls) {
      lines.push(`  - ${url}`);
    }
    lines.push(``);
  }

  // Mode-specific workflow instructions
  switch (policy.mode) {
    case 'code':
      lines.push(`WORKFLOW:`);
      lines.push(
        `Prioritise GitHub repositories, documentation sites, Stack Overflow, and package registries.`,
      );
      lines.push(`Look for code examples, API references, version histories, and changelogs.`);
      lines.push(``);
      break;
    case 'company':
      lines.push(`WORKFLOW:`);
      lines.push(
        `Prioritise official company blogs, press releases, Crunchbase, LinkedIn, and financial filings.`,
      );
      lines.push(`Cross-reference claims across independent sources.`);
      lines.push(``);
      break;
    case 'similar':
      lines.push(`WORKFLOW:`);
      lines.push(
        `Start from the provided seed URLs and discover related content by following in-links,`,
      );
      lines.push(`related-article suggestions, and similar-domain recommendations.`);
      lines.push(``);
      break;
    case 'deep':
    case 'general':
    default:
      lines.push(`WORKFLOW:`);
      lines.push(`1. Decompose the question into distinct sub-topics.`);
      lines.push(
        `2. Search across multiple source types (academic, web, community, documentation).`,
      );
      lines.push(`3. Read at least one high-quality source per sub-topic in depth.`);
      lines.push(`4. Cross-reference important claims across different sources.`);
      lines.push(`5. Synthesise findings into a coherent, well-structured answer.`);
      lines.push(``);
      break;
  }

  // Custom instruction override
  if (policy.customInstruction !== null) {
    lines.push(`CUSTOM INSTRUCTION:`);
    lines.push(policy.customInstruction);
    lines.push(``);
  }

  // Citation grounding rule
  lines.push(
    `CITATION RULE: Cite only URLs you actually browsed. Do not cite search results you did not read.`,
  );

  return lines.join('\n');
}
