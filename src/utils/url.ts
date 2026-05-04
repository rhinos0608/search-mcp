import { createHash } from 'node:crypto';
import { logger } from '../logger.js';
import type { CrawlPageResult } from '../types.js';

/** Known tracking / attribution query params that don't affect page content. */
export const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'ref',
  'source',
  'mc_cid',
  'mc_eid',
  // Job board tracking / redirect params
  'guid',
  'jrtk',
  'cb',
  'cpc',
  'ao',
  'src',
  'pos',
  'jrt',
  'trk',
  'trkd',
  '_gl',
  '_ga',
  'wt_mc',
  'wt_zmc',
  'wt_zs',
]);

/** Normalize a URL for dedup: lowercase hostname, strip default ports,
 *  trailing slash, fragments, and tracking query params. */
export function normalizeUrl(raw: string): string {
  if (!raw) return '';

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // Malformed URL — do best-effort normalization without URL parser
    logger.debug({ url: raw }, 'web_crawl dedup: malformed URL, using raw form');
    return raw.replace(/\/+$/, '').toLowerCase();
  }

  u.hostname = u.hostname.toLowerCase();

  // Strip www. prefix
  if (u.hostname.startsWith('www.')) {
    u.hostname = u.hostname.slice(4);
  }

  // Remove default ports
  if (
    (u.protocol === 'http:' && u.port === '80') ||
    (u.protocol === 'https:' && u.port === '443')
  ) {
    u.port = '';
  }

  // Strip trailing slash (but keep root "/")
  if (u.pathname !== '/' && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  // Strip fragments — same page content regardless of anchor
  u.hash = '';

  // Strip known tracking params, keep everything else
  const toDelete: string[] = [];
  u.searchParams.forEach((_val, key) => {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      toDelete.push(key);
    }
  });
  for (const key of toDelete) {
    u.searchParams.delete(key);
  }

  return u.toString();
}

/**
 * Deduplicate pages by normalized URL, keeping the first occurrence.
 * Call before `dedupPagesByContent` for two-pass dedup (URL then content).
 */
export function dedupPages(pages: CrawlPageResult[]): CrawlPageResult[] {
  const seen = new Set<string>();
  const out: CrawlPageResult[] = [];
  for (const page of pages) {
    const key = normalizeUrl(page.url);
    // Skip empty-URL pages from dedup set (e.g. failed pages with no URL)
    if (key === '') {
      out.push(page);
      continue;
    }
    if (!seen.has(key)) {
      seen.add(key);
      out.push(page);
    }
  }
  return out;
}

/**
 * Deduplicate pages by SHA-256 content hash, keeping the first occurrence.
 * Empty-markdown pages (error pages) are always kept — they're not deduplicated.
 * Call this *after* `dedupPages` so URL-level dedup is already done.
 */
export function dedupPagesByContent(pages: CrawlPageResult[]): CrawlPageResult[] {
  const seen = new Set<string>();
  const out: CrawlPageResult[] = [];
  for (const page of pages) {
    // Skip empty-markdown pages (error pages) — keep them all
    if (page.markdown === '') {
      out.push(page);
      continue;
    }
    const hash = createHash('sha256').update(page.markdown).digest('hex');
    if (!seen.has(hash)) {
      seen.add(hash);
      out.push(page);
    }
  }
  return out;
}

// ── Job-URL canonicalization ─────────────────────────────────────────────────

/**
 * Known glassdoor partner URL pattern for extracting job ID.
 */
const GLASSDOOR_PARTNER_RE = /\/partner\/jobListing\.htm/i;
const GLASSDOOR_JOBID_RE = /[?&]jobListingId=(\d+)/i;
const INDEED_JK_RE = /[?&]jk=([^&]+)/i;

/**
 * Additional tracking / redirect parameters specific to job board URLs.
 */
const JOB_TRACKING_PARAMS = new Set([
  'guid',
  'jrtk',
  'cb',
  'cpc',
  'ao',
  'src',
  'pos',
  'jrt',
  'trk',
  'trkd',
  'adid',
  'siteid',
  'cfp',
  'v4p',
  'vs',
  'vsk',
  'exp',
]);

/**
 * Canonicalize a job listing URL by stripping tracking parameters
 * and reconstructing stable URLs from known partner/redirect patterns.
 *
 * Handles:
 * - Glassdoor partner/jobListing.htm tracker URLs
 * - Indeed redirect URLs with ?jk= key
 * - Generic tracking param stripping
 */
export function canonicalizeJobUrl(raw: string): string {
  if (!raw) return '';

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }

  const hostname = u.hostname.toLowerCase();

  // Glassdoor partner URL — extract jobListingId, reconstruct stable URL
  if (GLASSDOOR_PARTNER_RE.test(u.pathname)) {
    const jobIdMatch = raw.match(GLASSDOOR_JOBID_RE);
    if (jobIdMatch?.[1]) {
      return `https://www.glassdoor.com/job-listing/${jobIdMatch[1]}`;
    }
  }

  // Indeed URL — extract jk param, reconstruct clean URL
  if (hostname.includes('indeed.com')) {
    const jkMatch = raw.match(INDEED_JK_RE);
    if (jkMatch?.[1]) {
      const jk = encodeURIComponent(jkMatch[1]);
      return `https://www.indeed.com/viewjob?jk=${jk}`;
    }
  }

  // Generic tracking param stripping
  const toDelete: string[] = [];
  u.searchParams.forEach((_val, key) => {
    if (JOB_TRACKING_PARAMS.has(key.toLowerCase())) {
      toDelete.push(key);
    }
  });
  for (const key of toDelete) {
    u.searchParams.delete(key);
  }

  return u.toString();
}

