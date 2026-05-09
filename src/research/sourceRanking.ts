import type { SourceEntry, SourceType } from './types.js';

const AUTHORITY_DOMAINS = new Set<string>([
  'arxiv.org',
  'github.com',
  'wikipedia.org',
  'docs.python.org',
  'developer.mozilla.org',
  'react.dev',
  'nextjs.org',
  'kubernetes.io',
  'docker.com',
  'aws.amazon.com',
  'cloud.google.com',
  'learn.microsoft.com',
  'pytorch.org',
  'tensorflow.org',
  'nodejs.org',
  'npmjs.com',
  'stackoverflow.com',
  'jstor.org',
  'cambridge.org',
  'academic.oup.com',
  'tandfonline.com',
  'sagepub.com',
  'wiley.com',
  'springer.com',
  'science.org',
  'nature.com',
  'irs.gov',
  'justice.gov',
  'courtlistener.com',
  'law.justia.com',
  'archive.org',
]);

const OFFICIAL_DOCS_DOMAINS = new Set<string>([
  'docs.python.org',
  'developer.mozilla.org',
  'react.dev',
  'nextjs.org',
  'kubernetes.io',
  'learn.microsoft.com',
  'pytorch.org',
]);

export interface SourceScore {
  readPriorityScore: number; // Should we read this URL next?
  evidenceWeight: number; // How much to trust findings from this URL?
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function domainAuthorityScore(domain: string): number {
  if (AUTHORITY_DOMAINS.has(domain)) return 0.85;
  if (domain.endsWith('.edu') || domain.endsWith('.gov')) return 0.8;
  if (domain.includes('blog.') || domain.includes('engineering.')) return 0.65;
  if (domain.includes('medium.com')) return 0.45;
  return 0.5;
}

function freshnessScore(source: SourceEntry): number {
  if (!source.publishedDate) return 0.5;
  const age = Date.now() - new Date(source.publishedDate).getTime();
  const days = age / 86_400_000;
  if (days < 30) return 1.0;
  if (days < 90) return 0.9;
  if (days < 365) return 0.7;
  if (days < 730) return 0.4;
  return 0.2;
}

function pathDepthPenalty(url: string): number {
  try {
    const depth = new URL(url).pathname.split('/').filter(Boolean).length;
    return Math.pow(0.95, depth);
  } catch {
    return 1;
  }
}

/**
 * Compute dual scores for a source.
 *
 * readPriorityScore: higher = read this next.
 *   Factors: semantic relevance, freshness, path depth, frequency backup.
 *
 * evidenceWeight: higher = trust findings more.
 *   Factors: domain authority, source type base confidence, isPrimary flag.
 */
export function rankSource(
  source: SourceEntry,
  frequency?: number, // How many times this normalized URL appeared
): SourceScore {
  const domain = extractDomain(source.url);

  // Read-priority score: how urgent is it to read this?
  const freshness = freshnessScore(source);
  const depthPenalty = pathDepthPenalty(source.url);
  const freqBoost = frequency && frequency > 1 ? 1 + (frequency - 1) * 0.1 : 1;

  const readPriorityScore = Math.min(
    1,
    (freshness * 0.4 + depthPenalty * 0.3 + (source.isPrimary ? 0.3 : 0)) * freqBoost,
  );

  // Evidence-weight score: how much to trust extracted findings?
  const authority = domainAuthorityScore(domain);
  const typeBase = sourceTypeBaseWeight(source.sourceType);

  const evidenceWeight = Math.min(
    1,
    authority * 0.4 + typeBase * 0.4 + (source.isPrimary ? 0.2 : 0),
  );

  return { readPriorityScore, evidenceWeight };
}

/**
 * Get max-per-hostname limit. Official docs domains get higher limit.
 */
export function maxPerHostname(domain: string): number {
  return OFFICIAL_DOCS_DOMAINS.has(domain) ? 4 : 2;
}

function sourceTypeBaseWeight(type: SourceType): number {
  switch (type) {
    case 'academic':
      return 0.9;
    case 'github':
      return 0.8;
    case 'documentation':
      return 0.8;
    case 'news':
      return 0.6;
    case 'stackoverflow':
      return 0.6;
    case 'web':
      return 0.5;
    case 'reddit':
      return 0.4;
    case 'hackernews':
      return 0.4;
    case 'youtube':
      return 0.4;
    case 'podcast':
      return 0.4;
    case 'producthunt':
      return 0.4;
    case 'patent':
      return 0.7;
    default:
      return 0.5;
  }
}
