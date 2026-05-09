/**
 * V5.0.0 — Content-level quality assessment for source pages.
 *
 * Analyzes markdown content to detect promotional material, thin content,
 * and substantive depth beyond simple domain/source-type checks.
 *
 * Used by worker agents to filter low-quality sources before they enter
 * the extraction pipeline, and by gap analysis to detect thin_coverage
 * and promotional_bias gaps.
 */

import { ContentQualityAssessment } from './types.js';

// ── Pattern constants ────────────────────────────────────────────────────────

const CTA_PATTERNS: RegExp[] = [
  /request\s+a\s+demo/i,
  /contact\s+sales/i,
  /get\s+started\s+free/i,
  /book\s+a\s+call/i,
  /sign\s+up\s+now/i,
  /subscribe\s+today/i,
  /free\s+trial/i,
];

const TESTIMONIAL_PATTERNS: RegExp[] = [
  /what\s+our\s+customers?\s+say/i,
  /case\s+stud(y|ies)/i,
  /success\s+stor(y|ies)/i,
  /customer\s+stor(y|ies)/i,
  /testimonial/i,
];

const PRICING_PATTERNS: RegExp[] = [
  /\$\d+(?:,\d{3})*\s*\/\s*(?:mo|month|year|yr)\b/i,
  /plans?\s+start(?:ing)?\s+at\b/i,
  /enterprise\s+plan/i,
  /starter\s+plan/i,
  /pro\s+plan/i,
];

const PRESS_RELEASE_PATTERNS: RegExp[] = [
  /\bannounces?\b/i,
  /\btoday\s+announced\b/i,
  /\bis\s+pleased\s+to\b/i,
  /\bproud\s+to\s+(?:announce|introduce|launch|present)\b/i,
];

const PAYWALL_PATTERNS: RegExp[] = [
  /subscribe\s+to\s+continue/i,
  /sign\s+in\s+to\s+read/i,
  /subscription\s+required/i,
  /this\s+content\s+is\s+for\s+(?:members|subscribers|paid\s+subscribers)/i,
  /unlock\s+this\s+(?:article|content|story)/i,
  /you['ve]+\s+reached\s+your\s+(?:article|story)\s+limit/i,
  /to\s+(?:read|continue)\s+this\s+(?:article|story|post)/i,
];

const REFERENCE_PATTERNS: RegExp[] = [
  /^#{1,3}\s+(?:references?|footnotes?|works?\s+cited|bibliography|sources?|further\s+reading|see\s+also)\s*$/im,
  /\[ref\]|\[\^/i,
];

/**
 * Numbers with data-oriented units — suggests data/benchmark presence.
 */
const DATA_UNIT_RE =
  /(\d+(?:\.\d+)?)\s*(%|dollars?|\$|€|£|ms|GB|MB|TB|GHz|MHz|km\/h|mph|FPS|fps|px|em|rem|vh|vw|bps|kbps|mbps|gib|mib)/i;

const BENCHMARK_RE =
  /\b(benchmark|performance\s+test|load\s+test|stress\s+test)\b|\d+%\s+(?:faster|slower|better|worse)|scored?\s+\d+/i;

const ATTRIBUTION_PATTERNS: RegExp[] = [
  /according\s+to/i,
  /as\s+reported\s+by/i,
  /source:\s*\S/i,
  /sources\s+say/i,
  /research\s+shows/i,
  /stud(y|ies)\s+(?:find|found|suggest|indicate|show|demonstrat)/i,
  /published\s+in/i,
  /cite(s|d)?\s+\S/i,
];

const COMMON_WORDS = new Set([
  'the',
  'this',
  'that',
  'with',
  'from',
  'what',
  'how',
  'why',
  'when',
  'where',
  'your',
  'our',
  'their',
  'about',
  'will',
  'have',
  'been',
  'some',
  'which',
  'into',
  'than',
  'then',
  'also',
  'only',
  'just',
  'more',
  'very',
  'here',
  'there',
  'they',
  'were',
  'been',
  'like',
  'does',
  'make',
  'made',
  'much',
  'many',
  'each',
  'every',
  'them',
  'would',
  'could',
  'should',
  'shall',
  'might',
  'being',
  'doing',
  'after',
  'before',
  'between',
  'under',
  'over',
  'such',
  'other',
  'while',
  'where',
  'there',
  'their',
  'these',
  'those',
  'must',
]);

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Extract the registered domain from a URL (e.g. "docs.example.com" → "example").
 */
function extractDomainWord(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    // Take the first non-common-tld segment
    const parts = hostname.split('.');
    // Handle co.uk, com.au, etc.
    if (parts.length >= 2) {
      // Return the most specific non-TLD label
      return (parts[parts.length - 2] ?? '').toLowerCase();
    }
    return (parts[0] ?? '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Strip markdown formatting, returning the raw text content.
 */
function stripMarkdown(md: string): string {
  if (!md) return '';
  const text = md
    // Remove code blocks (fenced)
    .replace(/```[\s\S]*?```/g, ' ')
    // Remove inline code
    .replace(/`[^`]+`/g, ' ')
    // Remove images, keep alt text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, ' $1 ')
    // Remove links, keep link text
    .replace(/\[([^\]]*)\]\([^)]+\)/g, '$1')
    // Remove reference-style links
    .replace(/\[([^\]]*)\]\s*\[[^\]]*\]/g, '$1')
    // Remove remaining reference definitions
    .replace(/^\[[^\]]+\]:\s+\S+/gm, '')
    // Remove bold/italic markers
    .replace(/[*_~]{1,3}/g, ' ')
    // Remove HTML tags
    .replace(/<[^>]+>/g, ' ')
    // Remove heading markers
    .replace(/^#{1,6}\s*/gm, '')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Remove blockquote markers
    .replace(/^>\s*/gm, '')
    // Remove list markers (-, *, + at line start)
    .replace(/^[\s]*[-*+]\s+/gm, '')
    // Remove numbered list markers
    .replace(/^\s*\d+\.\s+/gm, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

/**
 * Extract all heading texts from markdown.
 */
function extractHeadings(md: string): string[] {
  const headings: string[] = [];
  const re = /^(#{1,6})\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(md)) !== null) {
    headings.push((match[2] ?? '').trim());
  }
  return headings;
}

/**
 * Count word tokens in plain text (whitespace-separated).
 */
function countWords(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Count substantial code blocks (>100 chars of actual code).
 */
function countCodeBlocks(md: string): number {
  const blockRe = /```(\w*)\n?([\s\S]*?)```/g;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(md)) !== null) {
    const code = (match[2] ?? '').trim();
    if (code.length > 100) count++;
  }
  return count;
}

/**
 * Count markdown table separators (the |---| row) — an approximation for
 * number of tables.  Each table has exactly one separator row.
 */
function countTables(md: string): number {
  return (md.match(/^\|[\s:-]+\|$/gm) ?? []).length;
}

/**
 * Check for ≥2 consecutive numbered list items.
 */
function hasNumberedLists(md: string): boolean {
  const items = md.match(/^\s*\d+\.\s+.+$/gm);
  return (items?.length ?? 0) >= 2;
}

/**
 * Check for ≥2 blockquote lines.
 */
function hasBlockquotes(md: string): boolean {
  const quotes = md.match(/^>\s/gm);
  return (quotes?.length ?? 0) >= 2;
}

/**
 * Compute link density: proportion of non-whitespace characters consumed by
 * markdown inline links `[text](url)`.
 */
function computeLinkDensity(md: string): number {
  const clean = md.replace(/\s+/g, '');
  if (clean.length === 0) return 0;
  const linkMatches = md.match(/\[([^\]]*)\]\([^)]+\)/g);
  if (!linkMatches) return 0;
  const linkChars = linkMatches.reduce((sum, m) => sum + m.length, 0);
  return linkChars / clean.length;
}

/**
 * Count the number of navigation-style inline links in the page.
 * Navigation links include link rows where every word is a link
 * (header/menu bars) and footer link rows.
 *
 * Returns the count of navigation-link-only lines.
 */
function countNavLinkRows(md: string): number {
  let navRows = 0;
  for (const line of md.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const links = trimmed.match(/\[([^\]]+)\]\([^)]+\)/g);
    if (!links || links.length < 3) continue;
    // Compute what fraction of non-whitespace chars are inside links
    const linkChars = links.reduce((s, m) => s + m.length, 0);
    if (linkChars / trimmed.replace(/\s+/g, '').length > 0.5) {
      navRows++;
    }
  }
  return navRows;
}

// ── Assessment sub-routines ──────────────────────────────────────────────────

function assessPromotional(
  md: string,
  url: string,
  title: string,
): { isPromotional: boolean; signals: string[] } {
  const signals: string[] = [];
  const body = md.toLowerCase();

  // CTA patterns
  const ctaMatch = CTA_PATTERNS.find((p) => p.test(body));
  if (ctaMatch) {
    signals.push(`cta: ${ctaMatch.source}`);
  }

  // Testimonial sections
  const testimonialMatch = TESTIMONIAL_PATTERNS.find((p) => p.test(body));
  if (testimonialMatch) {
    signals.push(`testimonials: ${testimonialMatch.source}`);
  }

  // Pricing patterns
  const pricingMatch = PRICING_PATTERNS.find((p) => p.test(body));
  if (pricingMatch) {
    signals.push(`pricing: ${pricingMatch.source}`);
  }

  // Press-release language
  const pressMatch = PRESS_RELEASE_PATTERNS.find((p) => p.test(body));
  if (pressMatch) {
    signals.push(`press_release: ${pressMatch.source}`);
  }

  // Excessive brand mentions (>5 self-references in title/headings)
  const headings = extractHeadings(md);
  if (headings.length > 0) {
    // Collect potential brand terms from title and domain
    const brandTerms: string[] = [];
    if (title) {
      const titleWords = title
        .split(/\s+/)
        .filter((w) => w.length > 3 && !COMMON_WORDS.has(w.toLowerCase()));
      if (titleWords.length > 0) {
        // Most brand-like word from the title (longest significant word)
        brandTerms.push(titleWords.reduce((a, b) => (a.length >= b.length ? a : b)));
      }
    }
    const domainWord = extractDomainWord(url);
    if (domainWord && domainWord.length >= 4 && !brandTerms.includes(domainWord)) {
      brandTerms.push(domainWord);
    }

    for (const term of brandTerms) {
      const lowerTerm = term.toLowerCase();
      const brandCount = headings.filter((h) => h.toLowerCase().includes(lowerTerm)).length;
      if (brandCount > 5) {
        signals.push(
          `excessive_brand_mentions: "${term}" appears ${String(brandCount)}x in headings`,
        );
      }
    }
  }

  return {
    isPromotional: signals.length > 0,
    signals,
  };
}

function assessDepth(md: string): {
  wordCount: number;
  headingCount: number;
  contentDepth: number;
} {
  const text = stripMarkdown(md);
  const wordCount = countWords(text);
  const headings = extractHeadings(md);
  const headingCount = headings.length;

  // Word count → base score
  let wordScore: number;
  if (wordCount < 200) wordScore = 0.1;
  else if (wordCount < 500) wordScore = 0.3;
  else if (wordCount < 1000) wordScore = 0.5;
  else if (wordCount < 3000) wordScore = 0.7;
  else wordScore = 0.9;

  // Heading count → structure score
  let headingScore: number;
  if (headingCount < 2) headingScore = 0.1;
  else if (headingCount <= 5) headingScore = 0.4;
  else if (headingCount <= 10) headingScore = 0.6;
  else headingScore = 0.8;

  // Blend word count and heading structure
  let depth = (wordScore + headingScore) / 2;

  // Structural bonuses
  if (countCodeBlocks(md) > 0) depth += 0.1;
  if (countTables(md) > 0) depth += 0.1;
  if (hasNumberedLists(md)) depth += 0.05;
  if (hasBlockquotes(md)) depth += 0.05;

  return {
    wordCount,
    headingCount,
    contentDepth: Math.max(0, Math.min(1, depth)),
  };
}

function assessData(md: string): boolean {
  if (!md) return false;
  // Tables are a strong data signal
  if (countTables(md) > 0) return true;
  // Numbers with data units
  if (DATA_UNIT_RE.test(md)) return true;
  // Benchmark patterns
  if (BENCHMARK_RE.test(md)) return true;
  return false;
}

function assessCitations(md: string): { hasCitations: boolean; linkCount: number } {
  if (!md) return { hasCitations: false, linkCount: 0 };

  // Count inline markdown links in body text (exclude nav rows)
  let bodyLinkCount = 0;
  const lines = md.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip nav link rows
    const links = trimmed.match(/\[([^\]]+)\]\([^)]+\)/g);
    if (!links) continue;
    const linkChars = links.reduce((s, m) => s + m.length, 0);
    if (linkChars / trimmed.replace(/\s+/g, '').length > 0.5) continue; // nav row
    bodyLinkCount += links.length;
  }

  // Reference/footnote section heading
  const hasRefSection = REFERENCE_PATTERNS.some((p) => p.test(md));

  // Attribution phrases
  const hasAttribution = ATTRIBUTION_PATTERNS.some((p) => p.test(md));

  // Footnote-style links [^n]
  const hasFootnotes = /\[\^\w+\]/.test(md);

  return {
    hasCitations: bodyLinkCount >= 2 || hasRefSection || hasAttribution || hasFootnotes,
    linkCount: bodyLinkCount,
  };
}

function assessPaywall(md: string): boolean {
  return PAYWALL_PATTERNS.some((p) => p.test(md));
}

function determineReadingLevel(
  wordCount: number,
  headingCount: number,
  isPromotional: boolean,
  hasData: boolean,
  hasCitations: boolean,
): 'surface' | 'intermediate' | 'deep' {
  const isSurface = wordCount < 500 || headingCount < 3 || isPromotional;
  const isDeep = wordCount > 2000 && headingCount > 8 && hasData && hasCitations && !isPromotional;

  if (isDeep) return 'deep';
  if (isSurface) return 'surface';
  return 'intermediate';
}

function generateSummary(
  isSubstantive: boolean,
  contentDepth: number,
  isPromotional: boolean,
  wordCount: number,
  headingCount: number,
  hasData: boolean,
  hasCitations: boolean,
  readingLevel: string,
  paywalled: boolean,
  promotionalSignals: string[],
): string {
  const parts: string[] = [];

  if (paywalled) {
    parts.push('Paywalled content');
  } else if (isPromotional) {
    parts.push('Promotional content');
  } else if (isSubstantive) {
    parts.push('Substantive content');
  } else {
    parts.push('Thin content');
  }

  parts.push(`${String(wordCount)} words across ${String(headingCount)} headings`);

  if (hasData) parts.push('includes data');
  if (hasCitations) parts.push('cites sources');

  if (isPromotional && promotionalSignals.length > 0) {
    const cats = promotionalSignals.map((s) => s.split(':')[0]).join(', ');
    parts.push(`promotional signals: ${cats}`);
  }

  parts.push(`depth ${contentDepth.toFixed(2)}, ${readingLevel} level`);

  return parts.join(' — ');
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyze the markdown content of a fetched page and produce a quality
 * assessment used by worker agents and gap analysis.
 *
 * Heuristics cover promotional intent, content depth, data presence,
 * citation behavior, and paywall detection.
 */
export function assessContentQuality(
  markdown: string,
  url: string,
  title: string,
): ContentQualityAssessment {
  // ── Edge case: empty / malformed input ─────────────────────────────────
  if (!markdown || markdown.trim().length === 0) {
    return {
      isSubstantive: false,
      contentDepth: 0,
      isPromotional: false,
      hasData: false,
      hasCitations: false,
      readingLevel: 'surface',
      summary: 'Empty or malformed page content',
    };
  }

  // ── Paywall ────────────────────────────────────────────────────────────
  const paywalled = assessPaywall(markdown);

  // ── Link density check ─────────────────────────────────────────────────
  const linkDensity = computeLinkDensity(markdown);
  const navRows = countNavLinkRows(markdown);
  const isNavHeavy = linkDensity > 0.3 || navRows > 3;

  // ── Promotional ────────────────────────────────────────────────────────
  const { isPromotional, signals: promotionalSignals } = assessPromotional(markdown, url, title);

  // ── Content depth ──────────────────────────────────────────────────────
  const { wordCount, headingCount, contentDepth } = assessDepth(markdown);

  // ── Data presence ──────────────────────────────────────────────────────
  const hasData = assessData(markdown);

  // ── Citations ──────────────────────────────────────────────────────────
  const { hasCitations } = assessCitations(markdown);

  // ── Substantive ────────────────────────────────────────────────────────
  // A page is substantive if it has enough depth and is not promotional.
  // Navigation-heavy and paywalled pages are also not substantive.
  const isSubstantive = contentDepth >= 0.4 && !isPromotional && !isNavHeavy && !paywalled;

  // ── Reading level ──────────────────────────────────────────────────────
  const readingLevel = determineReadingLevel(
    wordCount,
    headingCount,
    isPromotional,
    hasData,
    hasCitations,
  );

  // ── Summary ────────────────────────────────────────────────────────────
  const summary = generateSummary(
    isSubstantive,
    contentDepth,
    isPromotional,
    wordCount,
    headingCount,
    hasData,
    hasCitations,
    readingLevel,
    paywalled,
    promotionalSignals,
  );

  return {
    isSubstantive,
    contentDepth,
    isPromotional,
    hasData,
    hasCitations,
    readingLevel,
    summary,
    ...(isPromotional && promotionalSignals.length > 0 ? { promotionalSignals } : {}),
  };
}

/**
 * Convenience helper for filtering source candidates by quality.
 */
export function isContentSubstantive(quality: ContentQualityAssessment): boolean {
  return quality.isSubstantive;
}

// ── Source Quality Tier Classification ─────────────────────────────────────────

import type { SourceEntry, SourceQualityTier } from './types.js';

/**
 * Tier-1 domains: primary evidence sources.
 * arXiv, official project repos, conference proceedings, official research blogs.
 */
const TIER1_DOMAINS = new Set([
  'arxiv.org',
  'openreview.net',
  'aclanthology.org',
  'proceedings.mlr.press',
  'papers.nips.cc',
  'aaai.org',
  'neurips.cc',
  'acm.org',
  'ieee.org',
  'dl.acm.org',
  'ieeexplore.ieee.org',
  'springer.com',
  'nature.com',
  'science.org',
  'wikipedia.org',
  'pubmed.ncbi.nlm.nih.gov',
]);

/**
 * Domains that get automatic Tier-4 (low-quality / excluded) unless explicitly
 * needed for community reaction.
 */
const TIER4_DOMAIN_PATTERNS: RegExp[] = [
  /(?:^|\.)(?:medium|towardsdatascience|betterprogramming|levelup|javascript-in-plain-english|blog\.devgenius|blog\.bitsrc)\.com$/i,
  /(?:^|\.)reddit\.com$/i,
  /(?:^|\.)youtube\.com$/i,
  /(?:^|\.)tiktok\.com$/i,
  /(?:^|\.)twitter\.com$/i,
  /(?:^|\.)x\.com$/i,
  /(?:^|\.)facebook\.com$/i,
  /(?:^|\.)linkedin\.com\/pulse/i,
  /(?:^|\.)producthunt\.com$/i,
  /(?:^|\.)eventbrite\.com$/i,
  /(?:^|\.)meetup\.com$/i,
  /(?:^|\.)lu\.ma$/i,
];

/**
 * URL path patterns indicating low-quality content.
 * Event calendars, homepages, SEO landing pages.
 */
const LOW_QUALITY_PATH_PATTERNS: RegExp[] = [
  /^\/$/, // bare homepage
  /\/events?\//i, // event pages
  /\/calendar/i, // event calendars
  /\/pricing/i, // pricing pages
  /\/about/i, // about pages
  /\/contact/i, // contact pages
  /\/(?:tag|category|archive)\//i, // SEO category pages
];

/**
 * Classify a source into a quality tier for synthesis gating.
 *
 * Tier 1: Primary evidence — arXiv, official repos, academic publishers, official research/engineering blogs
 * Tier 2: Reputable secondary — established tech publications, official docs, substantive HN
 * Tier 3: Community/ambient — Reddit, YouTube, Medium cross-posts, forum threads
 * Tier 4: Low-quality/excluded — SEO blogs, homepages, event calendars, social posts without substance
 */
export function classifySourceTier(source: SourceEntry): SourceQualityTier {
  const domain = source.domain.toLowerCase();

  // Tier 1: Academic / primary domains
  if (TIER1_DOMAINS.has(domain)) return 1;

  // Tier 1: GitHub repos with deep content (not just READMEs)
  if (source.sourceType === 'github') return 1;

  // Tier 1: Official documentation / research blogs on the project domain
  if (source.sourceType === 'documentation') return 1;

  // Tier 1: Academic source type
  if (source.sourceType === 'academic' || source.sourceType === 'pubmed') return 1;

  // Tier 2: Wiki / Reference
  if (source.sourceType === 'wikipedia') return 2;

  // Tier 4: Domain blocklist (social, content farms)
  for (const pat of TIER4_DOMAIN_PATTERNS) {
    if (pat.test(domain)) return 4;
  }

  // Tier 4: Low-quality path patterns
  try {
    const u = new URL(source.url);
    for (const pat of LOW_QUALITY_PATH_PATTERNS) {
      if (pat.test(u.pathname)) return 4;
    }
  } catch {
    /* ignore */
  }

  // Tier 4: Promotional content from quality assessment
  if (source.qualityScore !== undefined && source.qualityScore < 0.3) return 4;

  // Tier 3: Source types that are inherently community-level
  if (
    source.sourceType === 'reddit' ||
    source.sourceType === 'youtube' ||
    source.sourceType === 'podcast'
  )
    return 3;

  // Tier 2: Established news sources, HN, StackOverflow
  if (
    source.sourceType === 'news' ||
    source.sourceType === 'hackernews' ||
    source.sourceType === 'stackoverflow'
  )
    return 2;

  // Tier 2: Web with high quality score
  if (
    source.sourceType === 'web' &&
    source.qualityScore !== undefined &&
    source.qualityScore >= 0.6
  )
    return 2;

  // Tier 3: Generic web with moderate quality
  if (source.sourceType === 'web') return 3;

  // Default tier
  return 3;
}

/**
 * Filter and curate sources for the evidence section of the final report.
 *
 * No arbitrary cap — the system includes as many sources as it wants, provided they're
 * high quality. Tier 1-3 sources are always included (sorted by relevance). Tier 4
 * sources (social posts, SEO blogs, etc.) are only included if they directly back a
 * finding claim — community reaction sources are useful when cited.
 *
 * @param sources - All discovered sources
 * @param findings - Extracted findings (to find which sources actually back claims)
 */
export function curateEvidenceSources(
  sources: SourceEntry[],
  findings: { sourceIds: string[] }[],
): { source: SourceEntry; tier: SourceQualityTier; findingCount: number }[] {
  // Build a map of sourceId → how many findings cite it
  const sourceFindingCounts = new Map<string, number>();
  for (const f of findings) {
    for (const sid of f.sourceIds) {
      sourceFindingCounts.set(sid, (sourceFindingCounts.get(sid) ?? 0) + 1);
    }
  }

  // Classify and score every source
  const classified = sources.map((s) => ({
    source: s,
    tier: classifySourceTier(s),
    findingCount: sourceFindingCounts.get(s.id) ?? 0,
  }));

  // Sort: tier ascending (best first), then findingCount descending, then qualityScore descending
  classified.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.findingCount !== b.findingCount) return b.findingCount - a.findingCount;
    const qA = a.source.qualityScore ?? 0.5;
    const qB = b.source.qualityScore ?? 0.5;
    return qB - qA;
  });

  // Include all tier 1-3 sources (primary evidence, reputable secondary, community).
  // Exclude tier 4 (low-quality) unless it backs at least one finding.
  const result = classified.filter((c) => {
    if (c.tier <= 3) return true;
    // Tier 4: only include if a finding actually cites this source
    return c.findingCount > 0;
  });

  return result;
}

/**
 * Get the domain patterns that define Tier 4 (for use in prompts/other modules).
 */
export function getTier4DomainPatterns(): RegExp[] {
  return [...TIER4_DOMAIN_PATTERNS];
}

/**
 * Check if a URL matches a Tier-4 domain pattern.
 */
export function isTier4Domain(url: string): boolean {
  try {
    const domain = new URL(url).hostname.toLowerCase();
    return TIER4_DOMAIN_PATTERNS.some((p) => p.test(domain));
  } catch {
    return false;
  }
}
