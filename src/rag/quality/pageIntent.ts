/**
 * PageIntentClassifier
 *
 * Determines what kind of page a URL / HTML content represents.
 * Only job_listing and job_search_results intents survive the quality gate
 * by default. Career advice, salary guides, login pages, and generic
 * articles are rejected before extraction.
 */

import type { PageIntent, PageIntentResult } from './types.js';

// ── Heuristic signals ────────────────────────────────────────────────────────

/** JSON-LD type check — does the page contain a JobPosting schema? */
const JSONLD_JOB_POSTING_RE = /"@type"\s*:\s*"JobPosting"/i;


/** Page title patterns that indicate a search results page. */
const SEARCH_RESULTS_TITLE_RE = /\b(?:job\s+search|search\s+results|\d+\s+(?:job|result)s?\s+found|jobs?\s+in\b|find\s+your\s+next)\b/i;

/** Page title patterns that indicate career advice / article content. */
const CAREER_ADVICE_TITLE_RE = /\b(?:how\s+to\s+(?:become|get|find|land)|career\s+(?:path|advice|guide|tips)|what\s+(?:is|does)\s+(?:a|an)\s+\w+\s+(?:do|mean)|salary\s+(?:guide|range|survey))\b/i;

/** Page title patterns that indicate salary information pages. */
const SALARY_INFO_TITLE_RE = /\b(?:average\s+salary|pay\s+(?:rate|scale|guide)|salary\s+(?:guide|range|survey|data)|compensation)\b/i;

/** Page title patterns that indicate a login / authentication page. */
const LOGIN_TITLE_RE = /\b(?:sign\s+(?:in|up)|log\s+in|login|register|create\s+(?:an\s+)?account|forgot\s+password|reset\s+password)\b/i;

/** Page title patterns that indicate a company profile / about page. */
const COMPANY_PROFILE_TITLE_RE = /\b(?:about\s+us|company\s+(?:profile|overview|info)|working\s+(?:at|for)|our\s+(?:team|culture|story))\b/i;

/** HTML structural signals for a job listing page. */
function hasJobListingStructure(html: string): boolean {
  // Presence of "Apply" button + company name heading
  const hasApplyButton = /\b(?:apply\s+(?:now|for\s+this\s+job)?|submit\s+application)\b/i.test(html);
  const hasCompanyName = /(?:company|hiringOrganization|employer)\s*[:]/i.test(html);
  const hasJobSchema = JSONLD_JOB_POSTING_RE.test(html);
  return hasJobSchema || (hasApplyButton && hasCompanyName);
}

/** HTML structural signals for a job search results page. */
function hasSearchResultsStructure(html: string, title?: string): boolean {
  // Multiple listing cards or pagination
  const hasPagination = /(?:page\s+\d+\s+of\s+\d+|next\s+page|prev|\d+\s+–\s+\d+\s+of\s+\d+)/i.test(html);
  const hasFilterControls = /(?:filter|sort\s+by|job\s+type|salary\s+range|location\s+filter)/i.test(html);
  const hasResultCount = /(?:\d[\d,]*\s+(?:job|result|position)s?\s+(?:found|showing|of))/i.test(html);
  return (hasPagination || hasResultCount) || (hasFilterControls && (title ? SEARCH_RESULTS_TITLE_RE.test(title) : false));
}

/** HTML structural signals for a login page. */
function hasLoginStructure(html: string): boolean {
  const hasPasswordField = /<input[^>]*type\s*=\s*["']password["'][^>]*>/i.test(html);
  const hasLoginForm = /<form[^>]*>[\s\S]*?(?:sign[- ]?in|log[- ]?in|login)[\s\S]*?<\/form>/i.test(html);
  return hasPasswordField || hasLoginForm;
}

/** HTML structural signals for a career advice / article page. */
function hasArticleStructure(html: string): boolean {
  // Article-like: long prose, no job schema, no listing cards, single heading
  const hasArticleTag = /<article[^>]*>/i.test(html);
  const hasLongProse = (html.match(/\b(?:step\s+\d+|tip|guide|advice|learn\s+how|essential\s+skills|qualifications)\b/gi)?.length ?? 0) > 3;
  return hasArticleTag || hasLongProse;
}

/** Text content from a page after stripping markup, used for fallback intent detection. */
function extractPageText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Main classifier ──────────────────────────────────────────────────────────

/**
 * Classify a page by its URL, title, and HTML content.
 *
 * Priority order:
 * 1. Explicit structural signals (JSON-LD, apply buttons, login forms)
 * 2. Title-based heuristics
 * 3. Structural patterns (pagination, filters, article tags)
 * 4. Fallback to generic_article
 */
export function classifyPageIntent(
  _url: string,
  title: string | undefined,
  html: string,
): PageIntent {
  const pageText = extractPageText(html);
  const effectiveTitle = title ?? extractTitleFromHtml(html);

  // 1. Explicit job listing structure
  if (hasJobListingStructure(html) || JSONLD_JOB_POSTING_RE.test(html)) {
    return 'job_listing';
  }

  // 2. Login pages — catch early before they look like articles
  if (LOGIN_TITLE_RE.test(effectiveTitle) || hasLoginStructure(html)) {
    return 'login';
  }

  // 3. Salary info pages
  if (SALARY_INFO_TITLE_RE.test(effectiveTitle)) {
    return 'salary_info';
  }

  // 4. Search results pages with structural signals
  if (hasSearchResultsStructure(html, effectiveTitle)) {
    return 'job_search_results';
  }

  // 5. Career advice — title match or article structure
  if (CAREER_ADVICE_TITLE_RE.test(effectiveTitle) || hasArticleStructure(html)) {
    return 'career_advice';
  }

  // 6. Company profile
  if (COMPANY_PROFILE_TITLE_RE.test(effectiveTitle)) {
    return 'company_profile';
  }

  // 7. Search results via title alone
  if (SEARCH_RESULTS_TITLE_RE.test(effectiveTitle)) {
    return 'job_search_results';
  }

  // 8. Short pages with login-like content
  if (pageText.length < 300 && /\b(?:loading|sign[- ]?in|login|register)\b/i.test(pageText)) {
    return 'login';
  }

  // 9. Generic content with article-like patterns
  if (pageText.length > 500 && /\b(?:read\s+more|related\s+(?:articles|posts)|published|updated)\b/i.test(pageText)) {
    return 'generic_article';
  }

  // 10. Fallback: small pages are probably not real listings
  if (pageText.length < 100) {
    return 'login'; // treat as non-content
  }

  return 'generic_article';
}

/**
 * Evaluate whether a page intent is acceptable for job search.
 * By default, only job_listing and job_search_results pass.
 */
export function evaluatePageIntent(
  intent: PageIntent,
  requireJobListing: boolean,
): PageIntentResult {
  const passed = requireJobListing
    ? intent === 'job_listing' || intent === 'job_search_results'
    : true;

  const reasons: string[] = [];
  let confidence = 0;

  switch (intent) {
    case 'job_listing':
      confidence = 0.95;
      reasons.push('Page is a job listing (JSON-LD + apply structure)');
      break;
    case 'job_search_results':
      confidence = 0.85;
      reasons.push('Page is a job search results page');
      break;
    case 'career_advice':
      confidence = 0.7;
      reasons.push('Page is career advice / article, not a job listing');
      break;
    case 'salary_info':
      confidence = 0.8;
      reasons.push('Page is salary information, not a job listing');
      break;
    case 'login':
      confidence = 0.9;
      reasons.push('Page is a login / authentication page');
      break;
    case 'generic_article':
      confidence = 0.6;
      reasons.push('Page is a generic article, not a job listing');
      break;
    case 'company_profile':
      confidence = 0.7;
      reasons.push('Page is a company profile, not a job listing');
      break;
  }

  if (!passed) {
    reasons.push(`Intent "${intent}" rejected by quality gate (requireJobListing=${String(requireJobListing)})`);
  }

  return {
    passed,
    confidence,
    reasons,
    intent,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractTitleFromHtml(html: string): string {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return match?.[1]?.trim() ?? '';
}
