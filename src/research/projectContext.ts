/**
 * ProjectContext — configurable research subject description.
 *
 * Defines what project/ecosystem we're researching so provenance functions
 * can classify source authority, detect entity ownership, and normalize
 * release claims without hardcoded domain/path/repo patterns.
 *
 * Built-in profiles ship for common ecosystems (MCP, Kubernetes, React, etc.).
 * Custom profiles can be passed through the research config.
 */

import type { AuthorityClass } from './types.js';

// ── Domain & Path Rules ─────────────────────────────────────────────────────

/** A rule that matches a domain + optional path prefix → AuthorityClass. */
export interface DomainAuthorityRule {
  /** Exact domain or glob pattern (e.g. "kubernetes.io", "*.k8s.io"). */
  domain: string;
  /**
   * Optional path prefix filter. If set, the URL pathname must start with this.
   * If a second path is also set, the rule fires only when the first pattern holds
   * AND the second pattern is found anywhere in the pathname.
   */
  pathPrefix?: string;
  /**
   * Optional secondary path pattern that must appear somewhere in the pathname
   * (used for "contains /specification AND contains changelog" logic).
   */
  pathContains?: string;
  /** Authority class to assign when this rule matches. */
  authority: AuthorityClass;
  /** Optional: when true, this rule's match also sets the sourceType. */
  sourceType?: string;
}

/** GitHub repo pattern for official repo detection. */
export interface RepoAuthorityRule {
  /** Owner/organization on GitHub (e.g. "kubernetes"). */
  owner: string;
  /** Repo name pattern (glob, e.g. "kubernetes" or "modelcontextprotocol*"). */
  repoPattern: string;
  /** Authority class for matching repos. */
  authority: AuthorityClass;
}

import type { ReleaseEntityType } from './types.js';

/** A known package (npm, PyPI, crates.io, etc.) with ownership metadata. */
export interface KnownPackage {
  /** Full package name (e.g. "@ai-sdk/mcp", "react", "kubernetes-models"). */
  packageName: string;
  /** The organization or individual that owns/maintains this package. */
  owner?: string;
  /** The broader ecosystem this package belongs to (e.g. "AI SDK", "React"). */
  ecosystem?: string;
  /** The canonical project name this package implements (e.g. "Model Context Protocol"). */
  projectCanonicalName?: string;
  /** The type of entity this package represents. */
  entityType?: ReleaseEntityType;
}

/** Registry domain configuration. */
export interface RegistryConfig {
  /** Domain of the package registry (e.g. "npmjs.com", "pypi.org"). */
  domain: string;
  /** Source type to assign for this registry. */
  sourceType: string;
}

// ── Project Context ─────────────────────────────────────────────────────────

export interface ProjectContext {
  /** Canonical name of the project/protocol being researched. */
  canonicalName: string;
  /** Alternative names/aliases (lowercase). Used for text matching in claims. */
  aliases: string[];
  /** Regex for matching this project in free text. Built from aliases if not provided. */
  projectTextPattern?: RegExp;

  /** Domain+path rules for classifying source authority. Checked in order. */
  domainAuthorityRules: DomainAuthorityRule[];
  /** GitHub repo patterns for official repo detection. */
  repoAuthorityRules: RepoAuthorityRule[];
  /** Domains that count as official vendor/ecosystem sources. */
  vendorSdkDomains: DomainAuthorityRule[];

  /** Known packages, keyed by full package name (lowercase). */
  knownPackages: Record<string, KnownPackage>;

  /** Registry configurations. */
  registries: RegistryConfig[];

  /** Source-type inference rules (domain → sourceType). Checked in order. */
  sourceTypeRules: {
    domain: string;
    sourceType: string;
    pathPrefix?: string;
  }[];

  /** Phrases that suggest marketing/rhetoric (should be attributed, not reported as fact). */
  marketingPhrases: RegExp[];
}

// ── Built-in Profiles ───────────────────────────────────────────────────────

/**
 * Build a regex that matches any of the given aliases (case-insensitive, word-boundary).
 * Handles multi-word aliases and acronyms.
 */
export function buildAliasPattern(aliases: string[]): RegExp {
  const escaped = aliases.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`\\b(?:${escaped})\\b`, 'i');
}

/** Empty/default project context — used when no specific project is being researched. */
export function buildDefaultProjectContext(): ProjectContext {
  return {
    canonicalName: 'unknown',
    aliases: [],
    domainAuthorityRules: [],
    repoAuthorityRules: [],
    vendorSdkDomains: [],
    knownPackages: {},
    registries: [
      { domain: 'npmjs.com', sourceType: 'package_registry' },
      { domain: 'pypi.org', sourceType: 'package_registry' },
      { domain: 'crates.io', sourceType: 'package_registry' },
    ],
    sourceTypeRules: [
      { domain: 'github.com', sourceType: 'github' },
      { domain: 'wikipedia.org', sourceType: 'wikipedia' },
      { domain: 'reddit.com', sourceType: 'reddit' },
      { domain: 'news.ycombinator.com', sourceType: 'hackernews' },
      { domain: 'stackoverflow.com', sourceType: 'stackoverflow' },
    ],
    marketingPhrases: [
      /\b(tcp\/ip of|agentic web|game[- ]changer|revolutionary|paradigm shift|most substantial redesign|transformative)\b/i,
    ],
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Check if a domain matches a glob pattern.
 * Supports simple globs: "*" matches any sequence, everything else is literal+case-insensitive.
 */
export function domainMatches(pattern: string, domain: string): boolean {
  if (pattern === domain) return true;
  if (pattern.includes('*')) {
    return globToRegex(pattern).test(domain);
  }
  // Support suffix matching: "*.microsoft.com" patterns
  if (pattern.startsWith('*.')) {
    return domain.endsWith(pattern.slice(1));
  }
  // Support "endsWith" for wikipedia and reddit patterns
  // Handled implicitly by the rules: domain === 'wikipedia.org' || domain.endsWith('.wikipedia.org')
  return false;
}

/**
 * Match a domain authority rule against a domain + path.
 * Returns true if the rule fires.
 */
export function matchDomainRule(rule: DomainAuthorityRule, domain: string, path: string): boolean {
  if (!domainMatches(rule.domain, domain)) return false;
  if (rule.pathPrefix !== undefined && !path.startsWith(rule.pathPrefix)) return false;
  if (rule.pathContains !== undefined && !path.includes(rule.pathContains)) return false;
  return true;
}
