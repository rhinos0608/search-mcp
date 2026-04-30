export interface DomainTrustResult {
  domain: string;
  tier: 'trusted' | 'standard' | 'suspicious' | 'blocked';
  score: number;
  reasons: string[];
  https: boolean;
  lookalikeOf?: string;
}

export interface DomainTrustOptions {
  trustedDomains?: string[];
  blockedDomains?: string[];
}

const ESTABLISHED_DOMAINS = new Set([
  'arxiv.org',
  'github.com',
  'githubusercontent.com',
  'gnu.org',
  'microsoft.com',
  'openai.com',
  'anthropic.com',
  'wikipedia.org',
  'wikimedia.org',
  'stackoverflow.com',
  'serverfault.com',
  'superuser.com',
  'reddit.com',
  'news.ycombinator.com',
  'ycombinator.com',
  'npmjs.com',
  'pypi.org',
  'mozilla.org',
  'developer.mozilla.org',
  'oracle.com',
  'docs.rs',
  'crates.io',
  'go.dev',
  'pkg.go.dev',
  'python.org',
  'docs.python.org',
  'nodejs.org',
  'learn.microsoft.com',
  'cloud.google.com',
  'google.com',
  'amazon.com',
  'apple.com',
  'intel.com',
  'ibm.com',
  'nvidia.com',
  'datadoghq.com',
  'hashicorp.com',
  'docker.com',
  'kubernetes.io',
  'cncf.io',
  'elastic.co',
  'postgresql.org',
  'sqlite.org',
  'redis.io',
  'fastapi.tiangolo.com',
  'react.dev',
  'vuejs.org',
  'svelte.dev',
  'typescriptlang.org',
]);

const KNOWN_BRANDS = [
  'google',
  'github',
  'openai',
  'anthropic',
  'microsoft',
  'apple',
  'amazon',
  'reddit',
  'wikipedia',
  'stackoverflow',
  'nodejs',
  'python',
  'docker',
  'kubernetes',
  'sqlite',
  'postgres',
  'redis',
  'npm',
  'rust',
  'typescript',
];

const SUSPICIOUS_TLDS = new Set([
  'buzz',
  'click',
  'cf',
  'club',
  'ga',
  'gq',
  'icu',
  'info',
  'kim',
  'link',
  'loan',
  'ml',
  'online',
  'party',
  'pw',
  'quest',
  'shop',
  'site',
  'space',
  'support',
  'top',
  'tk',
  'today',
  'vip',
  'win',
  'work',
  'xyz',
]);

function normalizeHost(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
}

function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isTrustedDomain(hostname: string, trustedDomains: string[]): boolean {
  for (const domain of trustedDomains) {
    if (domainMatches(hostname, domain)) return true;
  }
  return false;
}

function isBlockedDomain(hostname: string, blockedDomains: string[]): boolean {
  for (const domain of blockedDomains) {
    if (domainMatches(hostname, domain)) return true;
  }
  return false;
}

function getRegistrableLabels(hostname: string): string[] {
  return normalizeHost(hostname)
    .split('.')
    .filter((part) => part.length > 0);
}

function getTld(hostname: string): string {
  const labels = getRegistrableLabels(hostname);
  return labels.at(-1) ?? '';
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const previous: number[] = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(insertion, deletion, substitution));
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

function detectLookalike(hostname: string, brands: string[] = KNOWN_BRANDS): string | undefined {
  const labels = getRegistrableLabels(hostname);
  const candidates = new Set<string>();
  if (labels.length > 0) candidates.add(labels[0] ?? '');
  if (labels.length > 1) candidates.add(labels[labels.length - 2] ?? '');

  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    for (const brand of brands) {
      if (candidate === brand) continue;
      const distance = levenshtein(candidate, brand);
      const threshold = brand.length <= 5 ? 1 : 2;
      if (distance > 0 && distance <= threshold) {
        return brand;
      }
      if (
        candidate.includes(brand) &&
        candidate.length <= brand.length + 2 &&
        candidate.length >= Math.max(brand.length - 1, 1)
      ) {
        return brand;
      }
    }
  }

  return undefined;
}

export function evaluateDomainTrust(
  url: string,
  options: DomainTrustOptions = {},
): DomainTrustResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      domain: url,
      tier: 'blocked',
      score: 0,
      reasons: ['invalid_url'],
      https: false,
    };
  }

  const hostname = normalizeHost(parsed.hostname);
  const trustedDomains = [...ESTABLISHED_DOMAINS, ...(options.trustedDomains ?? [])];
  const blockedDomains = [...(options.blockedDomains ?? [])];
  const https = parsed.protocol === 'https:';
  const tld = getTld(hostname);
  const reasons: string[] = [];

  if (isBlockedDomain(hostname, blockedDomains)) {
    reasons.push('explicit_blocklist');
    return { domain: hostname, tier: 'blocked', score: 0, reasons, https };
  }

  const lookalikeOf = detectLookalike(hostname);
  if (lookalikeOf !== undefined) {
    reasons.push(`lookalike:${lookalikeOf}`);
    if (!https) reasons.push('non_https');
    return {
      domain: hostname,
      tier: 'blocked',
      score: 0,
      reasons,
      https,
      lookalikeOf,
    };
  }

  const trusted = isTrustedDomain(hostname, trustedDomains);
  const suspiciousTld = SUSPICIOUS_TLDS.has(tld);
  const hasOddHyphenation = hostname.includes('--') || /\d{3,}/.test(hostname);

  if (trusted) reasons.push('trusted_domain');
  if (suspiciousTld) reasons.push(`suspicious_tld:${tld}`);
  if (!https) reasons.push('non_https');
  if (hasOddHyphenation) reasons.push('hostname_pattern');

  if (trusted && https && !suspiciousTld && !hasOddHyphenation) {
    return { domain: hostname, tier: 'trusted', score: 1, reasons, https };
  }

  if (trusted) {
    return {
      domain: hostname,
      tier: 'suspicious',
      score: https ? 0.9 : 0.8,
      reasons,
      https,
    };
  }

  if (suspiciousTld || hasOddHyphenation || !https) {
    return {
      domain: hostname,
      tier: 'suspicious',
      score: https ? 0.65 : 0.55,
      reasons,
      https,
    };
  }

  return {
    domain: hostname,
    tier: 'standard',
    score: 0.85,
    reasons,
    https,
  };
}

export function isBlockedUrl(url: string): boolean {
  return evaluateDomainTrust(url).tier === 'blocked';
}

export { ESTABLISHED_DOMAINS, KNOWN_BRANDS, SUSPICIOUS_TLDS };
