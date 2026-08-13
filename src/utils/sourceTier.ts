import { isInstitutionalHost } from '../domainFacts/lookup.js';
import { INSTITUTIONAL_SCORE, INSTITUTIONAL_BASIS } from '../domainFacts/types.js';
import { evaluateDomainTrust } from './domainTrust.js';

/**
 * Deterministic, explainable source-credibility tiers for web-search ranking.
 *
 * A technical source's domain authority is used as one ranking signal (never a
 * claim that the source is "true" — only that it is more likely credible for
 * technical queries). Tiers are suffix/subdomain-aware so institutional and
 * research families (IEEE Spectrum + ieee.org, ACM, official docs, government,
 * universities) score higher, while user-generated, publishing-platform, and
 * self-hosted commercial-marketing indicators score lower.
 *
 * Shared by the cross-backend merge, the multi-signal rescore, and the optional
 * semantic-rerank authority floor so all three paths agree on a single score.
 */

export type SourceQuality = 'high' | 'medium' | 'low';

/** High-authority known technical sources (exact host match). */
const EXPLICIT_AUTHORITY: Record<string, number> = {
  // Preprint / reference
  'arxiv.org': 0.9,
  'wikipedia.org': 0.85,
  'scholar.google.com': 0.8,
  'semanticscholar.org': 0.85,
  'pubmed.ncbi.nlm.nih.gov': 0.9,
  'doi.org': 0.8,
  // Code / official docs
  'github.com': 0.8,
  'stackoverflow.com': 0.8,
  'developer.mozilla.org': 0.85,
  'docs.python.org': 0.85,
  'nodejs.org': 0.8,
  'typescriptlang.org': 0.8,
  'golang.org': 0.8,
  'react.dev': 0.75,
  'reactjs.org': 0.75,
  'docs.rs': 0.75,
  'crates.io': 0.75,
  'pypi.org': 0.75,
  'npmjs.com': 0.75,
  'kubernetes.io': 0.8,
  'docs.docker.com': 0.8,
  'learn.microsoft.com': 0.8,
  'developer.apple.com': 0.8,
  'cloud.google.com': 0.8,
  'aws.amazon.com': 0.8,
};

/**
 * Evidence-backed curated hosts with a specific source type. Kept separate from
 * `EXPLICIT_AUTHORITY` so their explainable `source-basis` is a concrete
 * descriptor ("scientific publisher", "official intergovernmental project")
 * rather than the generic "recognized technical authority" label. Suffix/
 * subdomain-aware like the other registries. Only hosts with a defensible,
 * non-invented source type are listed.
 */
interface CuratedHost {
  score: number;
  basis: string;
}

const CURATED_HOSTS: Record<string, CuratedHost> = {
  'nature.com': { score: 0.85, basis: 'scientific publisher' },
  'iter.org': { score: 0.75, basis: 'official intergovernmental project' },
  'generalfusion.com': { score: 0.55, basis: 'official company source' },
  'techcrunch.com': { score: 0.6, basis: 'established technology journalism' },
};

/**
 * Official first-party company channels (exact host match only, after `www.`
 * normalization). These are the vendor's own developer/news/blog domains, not
 * independent authorities. Matched exactly so community/forum subdomains
 * (`community.openai.com`, `forums.developer.nvidia.com`) and arbitrary
 * subdomains never inherit the classification — they stay generic unless
 * known elsewhere.
 */
const OFFICIAL_FIRST_PARTY: Record<string, CuratedHost> = {
  'developer.nvidia.com': { score: 0.75, basis: 'official company source' },
  'nvidia.com': { score: 0.75, basis: 'official company source' },
  'openai.com': { score: 0.75, basis: 'official company source' },
};

/**
 * High-authority families matched by suffix, so `spectrum.ieee.org` and
 * `ieeexplore.ieee.org` inherit the same credibility as `ieee.org`.
 */
const AUTHORITY_FAMILY_SUFFIXES: Record<string, number> = {
  'ieee.org': 0.9,
  'acm.org': 0.9,
  'nature.com': 0.85,
  'science.org': 0.85,
  'cell.com': 0.85,
  'nejm.org': 0.9,
  'lancet.com': 0.85,
  'cambridge.org': 0.8,
  'springer.com': 0.8,
  'wiley.com': 0.8,
  'sciencedirect.com': 0.8,
  'oup.com': 0.8,
  'elsevier.com': 0.8,
};

/**
 * Low-credibility hosts matched by suffix — user-generated content and
 * self-hosted/publishing platforms with weak editorial control or heavy
 * commercial-marketing indicators.
 */
const LOW_AUTHORITY_SUFFIXES: Record<string, number> = {
  'youtube.com': 0.3,
  'youtu.be': 0.3,
  'twitter.com': 0.3,
  'x.com': 0.3,
  'reddit.com': 0.4,
  'blogspot.com': 0.2,
  'wordpress.com': 0.25,
  'tumblr.com': 0.25,
  'wix.com': 0.2,
  'weebly.com': 0.2,
  'squarespace.com': 0.3,
  'shopify.com': 0.3,
  'medium.com': 0.45,
  'substack.com': 0.45,
  'dev.to': 0.4,
  'hackernoon.com': 0.4,
};

/**
 * Registry-suffix fallback tiers applied only when no explicit/family/low host
 * matches. `.edu` is a moderate institutional tier (not maximal) so student
 * pages are not mistaken for top authorities; `.gov`/`.mil` are public-sector.
 */
const SUFFIX_TIERS: { re: RegExp; score: number }[] = [
  { re: /\.gov\.uk$/i, score: 0.85 },
  { re: /\.gov$/i, score: 0.85 },
  { re: /\.mil$/i, score: 0.85 },
  { re: /\.edu$/i, score: 0.7 },
  { re: /\.edu\.[a-z]{2}$/i, score: 0.7 },
  { re: /\.ac\.uk$/i, score: 0.75 },
  { re: /\.ac\.[a-z]{2}$/i, score: 0.7 },
  { re: /\.io$/i, score: 0.45 },
  { re: /\.dev$/i, score: 0.45 },
  { re: /\.org$/i, score: 0.45 },
  { re: /\.com$/i, score: 0.4 },
];

const DEFAULT_AUTHORITY = 0.4;

/**
 * Suffixes that are themselves high-authority registries and must not be
 * downgraded by domain-trust heuristics (`.gov`/`.mil`/`.edu`/`.ac.*`).
 * Mirrors the institutional guard used below so trust only refines the
 * generic `.com`/`.org`/`.io`/`.dev` and default tiers.
 */
const HIGH_TRUST_SUFFIX_RE = /\.(gov|mil|edu|ac\.[a-z]{2})$/i;

/**
 * Government second-level ccTLDs (`gov.au`, `gov.sg`, `gov.in`, …), bare `.gov`,
 * and their military counterparts. An explicit allowlist prevents lookalike
 * domains such as `gov.io`, `gov.co`, or `mil.io` from receiving
 * government-domain scoring. A central bank on `rba.gov.au` must not fall
 * through to the generic-suffix default and be mislabeled low-credibility.
 */
const GOV_SUFFIX_RE =
  /(?:^|\.)(?:gov|mil)(?:\.(?:uk|au|in|sg|my|nz|hk|cn|ph|id|bd|za|ke|ng|gh))?$/i;

/** Short explainable basis per named low-tier platform (mirrors LOW_AUTHORITY_SUFFIXES). */
const LOW_AUTHORITY_BASIS: Record<string, string> = {
  'youtube.com': 'video platform',
  'youtu.be': 'video platform',
  'twitter.com': 'social platform',
  'x.com': 'social platform',
  'reddit.com': 'community platform',
  'blogspot.com': 'hosted blog platform',
  'wordpress.com': 'hosted blog platform',
  'tumblr.com': 'hosted blog platform',
  'wix.com': 'hosted site builder',
  'weebly.com': 'hosted site builder',
  'squarespace.com': 'hosted site builder',
  'shopify.com': 'storefront platform',
  'medium.com': 'hosted publishing platform',
  'substack.com': 'hosted publishing platform',
  'dev.to': 'community platform',
  'hackernoon.com': 'publishing platform',
};

function bareDomain(domain: string): string {
  return domain.replace(/^www\./, '').toLowerCase();
}

function matchesSuffix(domain: string, map: Record<string, number>): number | null {
  for (const suffix of Object.keys(map)) {
    if (domain === suffix || domain.endsWith(`.${suffix}`)) {
      return map[suffix] ?? null;
    }
  }
  return null;
}

function curatedMatch(domain: string): CuratedHost | null {
  for (const host of Object.keys(CURATED_HOSTS)) {
    if (domain === host || domain.endsWith(`.${host}`)) {
      return CURATED_HOSTS[host] ?? null;
    }
  }
  return null;
}

/** Exact-only official first-party match (no suffix inheritance). */
function officialFirstPartyMatch(domain: string): CuratedHost | null {
  return OFFICIAL_FIRST_PARTY[domain] ?? null;
}

/**
 * Deterministic 0–1 credibility score for a host. `category === 'tweet'` keeps
 * x.com/twitter.com out of the low tier (a tweet is a legitimate primary
 * source for that category), per the pre-existing exception.
 */
export function getDomainAuthority(domain: string, category?: string): number {
  const bare = bareDomain(domain);
  if (bare.length === 0) return DEFAULT_AUTHORITY;
  if (category === 'tweet' && (bare === 'x.com' || bare === 'twitter.com')) return 0.95;
  const explicit = EXPLICIT_AUTHORITY[bare];
  if (explicit !== undefined) return explicit;
  const curated = curatedMatch(bare);
  if (curated !== null) return curated.score;
  const official = officialFirstPartyMatch(bare);
  if (official !== null) return official.score;
  if (GOV_SUFFIX_RE.test(bare)) return 0.85;
  const family = matchesSuffix(bare, AUTHORITY_FAMILY_SUFFIXES);
  if (family !== null) return family;
  const low = matchesSuffix(bare, LOW_AUTHORITY_SUFFIXES);
  if (low !== null) return low;
  // ROR-registered education organizations map to the existing institutional
  // 0.70 prior (same value/basis as the `.edu` tier), but only when the domain
  // is not already covered by an equal-or-higher government/academic suffix
  // tier (`.gov`, `.mil`, `.edu`, `.ac.*`) — those keep their existing scores.
  // Consulted only after all manual exact/curated/platform-low rules so those
  // keep highest priority.
  if (isInstitutionalHost(bare) && !/\.(gov|mil|edu|ac\.[a-z]{2})$/i.test(bare)) {
    return INSTITUTIONAL_SCORE;
  }
  for (const tier of SUFFIX_TIERS) {
    if (tier.re.test(bare)) return applyDomainTrustPenalty(bare, tier.score);
  }
  return applyDomainTrustPenalty(bare, DEFAULT_AUTHORITY);
}

/**
 * Optional content-level signals consulted only when the domain-based tier
 * is a generic prior (no explicit/curated/family/platform/institutional match)
 * and the domain carries no negative trust flag. Display-only: these never
 * change the numeric authority score, only the basis label.
 */
export interface ContentSignals {
  contentKind?: 'snippet' | 'full' | 'summary';
  contentLength?: number;
  engineCount?: number;
}

/**
 * Downgrade suspicious/blocked domains that fall through to the generic
 * suffix/default tiers. Domain trust (suspicious TLDs, lookalikes) is never
 * allowed to override an explicit high authority — it only refines the low
 * generic tiers.
 */
function applyDomainTrustPenalty(bare: string, base: number): number {
  if (HIGH_TRUST_SUFFIX_RE.test(bare)) return base;
  const trust = evaluateDomainTrust(`https://${bare}`);
  if (!isNegativeTrust(trust)) return base;
  return trust.tier === 'blocked' ? 0.1 : 0.15;
}

/**
 * A genuine trust threat worth downgrading a generic-tier domain: an explicit
 * blocklist hit, a lookalike of a known brand, or a suspicious TLD. Softer
 * heuristics (odd hyphenation / digit runs, non-HTTPS) are NOT treated as
 * threats here — they flag too many legitimate domains (e.g. `earth911.com`)
 * to justify an authority penalty.
 */
function isNegativeTrust(trust: ReturnType<typeof evaluateDomainTrust>): boolean {
  if (trust.tier === 'blocked') {
    return trust.lookalikeOf !== undefined || trust.reasons.includes('explicit_blocklist');
  }
  if (trust.tier === 'suspicious') {
    return trust.reasons.some((reason) => reason.startsWith('suspicious_tld'));
  }
  return false;
}

/**
 * Honest label derived from `getDomainAuthority`. A high tier never implies the
 * source is correct — only that its domain is a recognized technical authority.
 */
export function getSourceQuality(domain: string, category?: string): SourceQuality {
  const authority = getDomainAuthority(domain, category);
  if (authority >= 0.75) return 'high';
  if (authority >= 0.5) return 'medium';
  return 'low';
}

/**
 * Short explainable basis for a host's credibility tier, or null when the tier
 * rests only on a generic registry suffix / default (no invented semantics).
 * Mirrors `getDomainAuthority` so the basis always matches the score.
 */
export function getSourceBasis(
  domain: string,
  category?: string,
  contentSignals?: ContentSignals,
): string | null {
  const bare = bareDomain(domain);
  if (bare.length === 0) return null;
  if (category === 'tweet' && (bare === 'x.com' || bare === 'twitter.com')) {
    return 'recognized social authority';
  }
  if (Object.prototype.hasOwnProperty.call(EXPLICIT_AUTHORITY, bare)) {
    return 'recognized technical authority';
  }
  const curated = curatedMatch(bare);
  if (curated !== null) return curated.basis;
  const official = officialFirstPartyMatch(bare);
  if (official !== null) return official.basis;
  if (GOV_SUFFIX_RE.test(bare)) {
    return 'government domain';
  }
  if (matchesSuffix(bare, AUTHORITY_FAMILY_SUFFIXES) !== null) {
    return 'recognized technical family';
  }
  const low = lowBasis(bare);
  if (low !== null) return low;
  if (isInstitutionalHost(bare) && !/\.(gov|mil|edu|ac\.[a-z]{2})$/i.test(bare)) {
    return INSTITUTIONAL_BASIS;
  }
  if (
    /\.edu$/i.test(bare) ||
    /\.edu\.[a-z]{2}$/i.test(bare) ||
    /\.ac\.uk$/i.test(bare) ||
    /\.ac\.[a-z]{2}$/i.test(bare)
  ) {
    return 'academic domain';
  }
  // A generic-prior domain that carries a negative trust flag deserves a
  // concrete label instead of the hardcoded "generic domain prior" fallback:
  // suspicious TLDs (.xyz/.buzz/.tk) and lookalike domains.
  const trust = evaluateDomainTrust(`https://${bare}`);
  if (isNegativeTrust(trust)) {
    if (trust.lookalikeOf !== undefined) return 'possible lookalike';
    if (trust.reasons.some((reason) => reason.startsWith('suspicious_tld'))) {
      return 'suspicious TLD';
    }
    return 'suspicious domain';
  }
  // Content-aware qualifier (display-only) for genuine generic domains when
  // content signals are supplied.
  if (contentSignals) {
    const { contentKind, contentLength } = contentSignals;
    if (
      contentKind === 'full' ||
      contentKind === 'summary' ||
      (contentLength !== undefined && contentLength > 500)
    ) {
      return 'substantive content';
    }
    if (contentLength !== undefined && contentLength < 100) {
      return 'thin content';
    }
  }
  return null;
}

function lowBasis(bare: string): string | null {
  for (const suffix of Object.keys(LOW_AUTHORITY_BASIS)) {
    if (bare === suffix || bare.endsWith(`.${suffix}`)) return LOW_AUTHORITY_BASIS[suffix] ?? null;
  }
  return null;
}
