/**
 * LinkExtractor — Configurable link extraction from HTML and markdown.
 *
 * Inspired by Scrapy's LxmlLinkExtractor pattern.
 * Extracts links from content with allow/deny pattern rules,
 * tag/attribute filtering, relative URL resolution, and dedup.
 */

import type { ExtractedLink, LinkExtractorRule } from './types.js';

/** Default HTML tags to scan for links. */
const DEFAULT_TAGS = ['a', 'area', 'iframe', 'frame', 'link'] as const;

/** Regex to find HTML tags with attributes. */
const LINK_TAG_RE = /<(\w+)\b[^>]*?(?:href|src|data-src)\s*=\s*["']([^"']+)["'][^>]*?>/gi;

/** Regex to find markdown links [text](url). */
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

export class LinkExtractor {
  private readonly rules: LinkExtractorRule[];

  constructor(rules: LinkExtractorRule[] = []) {
    this.rules = rules;
  }

  /** Add a rule. */
  addRule(rule: LinkExtractorRule): void {
    this.rules.push(rule);
  }

  /**
   * Extract links from HTML content.
   */
  extractFromHtml(html: string, baseUrl: string): ExtractedLink[] {
    const links: ExtractedLink[] = [];
    const seen = new Set<string>();

    let match: RegExpExecArray | null;
    LINK_TAG_RE.lastIndex = 0;

    while ((match = LINK_TAG_RE.exec(html)) !== null) {
      const tag = (match[1] ?? '').toLowerCase();
      let url = match[2] ?? '';

      // Filter by tag
      if (!this.isTagAllowed(tag)) continue;

      // Skip anchors, javascript:, data:, mailto:
      if (
        url.startsWith('#') ||
        url.startsWith('javascript:') ||
        url.startsWith('data:') ||
        url.startsWith('mailto:')
      )
        continue;

      // Resolve relative URLs
      try {
        url = new URL(url, baseUrl).href;
      } catch {
        continue; // Unresolvable URL
      }

      // Apply allow/deny rules
      if (!this.isUrlAllowed(url)) continue;

      // Dedup
      const normalized = this.normalizeUrl(url);
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      links.push({ url, text: '' });
    }

    return links;
  }

  /**
   * Extract links from markdown content.
   */
  extractFromMarkdown(markdown: string, baseUrl: string): ExtractedLink[] {
    const links: ExtractedLink[] = [];
    const seen = new Set<string>();

    let match: RegExpExecArray | null;
    MD_LINK_RE.lastIndex = 0;

    while ((match = MD_LINK_RE.exec(markdown)) !== null) {
      const text = match[1] ?? '';
      let url = match[2] ?? '';

      // Skip anchors, javascript:, data:, mailto:
      if (
        url.startsWith('#') ||
        url.startsWith('javascript:') ||
        url.startsWith('data:') ||
        url.startsWith('mailto:')
      )
        continue;

      // Resolve relative URLs
      try {
        url = new URL(url, baseUrl).href;
      } catch {
        continue;
      }

      // Apply allow/deny rules
      if (!this.isUrlAllowed(url)) continue;

      // Dedup
      const normalized = this.normalizeUrl(url);
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      links.push({ url, text });
    }

    return links;
  }

  /**
   * Filter links extracted by Crawl4AI or other sources.
   * Used as a post-processing step on CrawlPageResult.links.
   */
  filterLinks(links: ExtractedLink[]): ExtractedLink[] {
    const seen = new Set<string>();
    return links.filter((link) => {
      if (!this.isUrlAllowed(link.url)) return false;
      const normalized = this.normalizeUrl(link.url);
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }

  /**
   * Apply any allow/deny rules from all configured rulesets.
   */
  private isUrlAllowed(url: string): boolean {
    if (this.rules.length === 0) return true;

    for (const rule of this.rules) {
      // If deny patterns exist and URL matches any, reject
      if (rule.deny) {
        for (const pattern of rule.deny) {
          if (pattern.test(url)) return false;
        }
      }

      // If allow patterns exist, URL must match at least one
      if (rule.allow && rule.allow.length > 0) {
        const matched = rule.allow.some((pattern) => pattern.test(url));
        if (!matched) return false;
      }

      // If no allow or deny patterns, skip this rule (no constraints to enforce)
      if (!rule.allow || rule.allow.length === 0) {
        if (!rule.deny || rule.deny.length === 0) continue;
      }
    }

    return true;
  }

  private isTagAllowed(tag: string): boolean {
    if (this.rules.length === 0) return DEFAULT_TAGS.includes(tag as (typeof DEFAULT_TAGS)[number]);

    for (const rule of this.rules) {
      const tags = rule.tags ?? DEFAULT_TAGS;
      if ((tags as readonly string[]).includes(tag)) return true;
    }
    return false;
  }

  /**
   * Normalize a URL for dedup comparison.
   * Strips trailing slash, protocol-relative, and fragment.
   */
  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      // Remove trailing slash from path for comparison
      if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
        parsed.pathname = parsed.pathname.slice(0, -1);
      }
      return parsed.href;
    } catch {
      return url;
    }
  }
}
