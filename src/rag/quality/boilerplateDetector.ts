/**
 * BoilerplateDetector
 *
 * Detects and strips job-board-specific UI chrome, navigation elements,
 * CTAs, and non-content artifacts from crawled job page text.
 *
 * Operates on the extracted text of a listing after initial extraction.
 * Produces a content ratio (meaningful content / total text) used by the
 * quality gate to reject heavily boilerplate-dominated pages.
 */

import type { BoilerplateResult } from './types.js';
import type { JobListingMvp } from '../types/job.js';

// ── Job-board boilerplate patterns ───────────────────────────────────────────

const NAVIGATION_PATTERNS: readonly RegExp[] = [
  /\bCommunity\b/i,
  /\bJobs\b(?!\s+(?:search|listing|in|near|at)\b)/i,
  /\bCompanies\b/i,
  /\bSalaries\b/i,
  /\bFor\s+employers\b/i,
  /\bEmployers?\s+?(?:post|home)\b/i,
  /\bSearch\b(?:\s+(?:jobs?|companies?|salaries))?/i,
  /\bNotifications?\b/i,
  /\bMessages?\b/i,
  /\bProfile\b/i,
  /\bDashboard\b/i,
  /\bSettings\b/i,
  /\bSign\s+out\b/i,
  /\bLog\s+out\b/i,
  /\bMy\s+(?:applications|jobs|favorites?|saved|account|profile|settings)\b/i,
  /\bMenu\b/i,
  /\bNavigation\b/i,
];

const CTA_PATTERNS: readonly RegExp[] = [
  /\bUpload\s+your\s+CV\b/i,
  /\bUpload\s+resume\b/i,
  /\bCreate\s+job\s+alert\b/i,
  /\bGet\s+job\s+alerts?\b/i,
  /\bSave\s+this\s+job\b/i,
  /\bApply\s+(?:now|today|for\s+this\s+job)\b/i,
  /\bEasy\s+Apply\b/i,
  /\bQuick\s+Apply\b/i,
  /\bApply\s+on\s+company\s+site\b/i,
  /\bSign\s+in\s+to\s+apply\b/i,
  /\bRegister\s+to\s+apply\b/i,
  /\bCreate\s+account\b/i,
  /\bSign\s+up\b/i,
  /\bLog\s+in\b/i,
  /\bSubscribe\b/i,
  /\bFollow\s+(?:us|this\s+company)\b/i,
  /\bShare\s+(?:this|job)\b/i,
  /\bReport\s+(?:this\s+)?job\b/i,
  /\bFlag\s+(?:this\s+)?job\b/i,
];

const DISCOVER_PATTERNS: readonly RegExp[] = [
  /\bDiscover\s+more\b/i,
  /\bRelated\s+(?:jobs?|searches?|companies?|salaries?|articles?)\b/i,
  /\bSimilar\s+(?:jobs?|roles?|positions?|companies?)\b/i,
  /\bPeople\s+also\s+(?:viewed|searched|applied)\b/i,
  /\bYou\s+may\s+also\s+(?:like|be\s+interested\s+in|consider)\b/i,
  /\bRecommended\s+(?:jobs?|roles?)\b/i,
  /\bSuggested\s+(?:jobs?|roles?)\b/i,
  /\bFeatured\s+(?:jobs?|employers?|companies?)\b/i,
  /\bPromoted\b/i,
  /\bSponsored\b/i,
  /\bAdvertisment?\b/i,
  /\bTrending\s+(?:now|today|this\s+week)\b/i,
  /\bPopular\s+(?:searches?|categories?|employers?)\b/i,
];

const SITE_CHROME_PATTERNS: readonly RegExp[] = [
  /\bLoading\b/i,
  /\bLoading\.\.\./i,
  /\bNext\s+route\s+announcer\b/i,
  /\bSkip\s+to\s+content\b/i,
  /\bPrivacy\s+policy\b/i,
  /\bCookie\s+(?:policy|settings|preferences)\b/i,
  /\bTerms\s+(?:of\s+)?(?:service|use|conditions?)\b/i,
  /\bAccessibility\b/i,
  /\bHelp\b/i,
  /\bFAQ\b/i,
  /\bContact\s+us\b/i,
  /\bAbout\s+us\b/i,
  /\bSitemap\b/i,
  /\bAll\s+rights\s+reserved\b/i,
  /\bCopyright\b/i,
];

// ── Line-level analysis ──────────────────────────────────────────────────────

interface LineClass {
  text: string;
  isBoilerplate: boolean;
  reason: string | undefined;
}

/**
 * Analyse a page's text line by line, classifying each line as
 * content or boilerplate.
 */
function analyseLines(text: string): {
  lines: LineClass[];
  meaningfulLineCount: number;
  totalLineCount: number;
} {
  const rawLines = text.split('\n');
  const lines: LineClass[] = [];
  let meaningfulLineCount = 0;

  for (const raw of rawLines) {
    const trimmed = raw.trim();

    // Empty lines are structural, not boilerplate
    if (trimmed.length === 0) {
      lines.push({ text: raw, isBoilerplate: false, reason: undefined });
      continue;
    }

    let isBoilerplate = false;
    let reason: string | undefined;

    // Check against all boilerplate pattern groups
    const checks: { patterns: readonly RegExp[]; label: string }[] = [
      { patterns: NAVIGATION_PATTERNS, label: 'nav' },
      { patterns: CTA_PATTERNS, label: 'cta' },
      { patterns: DISCOVER_PATTERNS, label: 'discover' },
      { patterns: SITE_CHROME_PATTERNS, label: 'chrome' },
    ];

    for (const check of checks) {
      for (const pattern of check.patterns) {
        if (pattern.test(trimmed) && trimmed.length < 120) {
          isBoilerplate = true;
          reason = check.label;
          break;
        }
      }
      if (isBoilerplate) break;
    }

    // Very short lines that are just icons/numbers
    if (!isBoilerplate && trimmed.length <= 2) {
      isBoilerplate = true;
      reason = 'too_short';
    }

    // SVG / icon-only lines (no alphabetic characters)
    if (!isBoilerplate && /^[\s\d\W]+$/.test(trimmed) && trimmed.length < 50) {
      isBoilerplate = true;
      reason = 'icon_only';
    }

    lines.push({ text: raw, isBoilerplate, reason });
    if (!isBoilerplate) meaningfulLineCount++;
  }

  return {
    lines,
    meaningfulLineCount,
    totalLineCount: lines.length,
  };
}

// ── Main detector ────────────────────────────────────────────────────────────

/**
 * Detect and quantify boilerplate content in a job listing's extracted text.
 *
 * Returns a BoilerplateResult with:
 * - passed: true if contentRatio >= minContentRatio
 * - contentRatio: meaningful / total lines
 * - confidence: how reliable the estimate is
 * - reasons: list of boilerplate categories detected
 */
export function detectBoilerplate(
  listing: JobListingMvp,
  minContentRatio: number,
): BoilerplateResult {
  const text = listing.extractedText;

  // Very short or empty text is common for JobSpy / search-result records
  // that haven't been enriched yet. Pass through with low confidence
  // rather than hard-rejecting.
  if (text.length < 50) {
    return {
      passed: true,
      contentRatio: text.length > 0 ? 0.5 : 0,
      confidence: 0.3,
      reasons: ['Limited extracted text — allowing through for enrichment'],
    };
  }

  const analysis = analyseLines(text);
  const contentRatio =
    analysis.totalLineCount > 0 ? analysis.meaningfulLineCount / analysis.totalLineCount : 0;

  // Collect detected categories
  const categories = new Set<string>();
  for (const line of analysis.lines) {
    if (line.isBoilerplate && line.reason) {
      categories.add(line.reason);
    }
  }

  const reasons: string[] = [];
  if (categories.has('nav')) reasons.push('Navigation elements detected');
  if (categories.has('cta')) reasons.push('CTA elements detected (apply, sign in)');
  if (categories.has('discover')) reasons.push('Related/discover content links detected');
  if (categories.has('chrome')) reasons.push('Site chrome elements detected');
  if (categories.has('too_short')) reasons.push('Many very short/empty lines');
  if (categories.has('icon_only')) reasons.push('Non-text content (icons, symbols) detected');

  const passed = contentRatio >= minContentRatio;

  if (!passed) {
    reasons.push(
      `Content ratio ${String(Math.round(contentRatio * 100))}% below minimum ${String(Math.round(minContentRatio * 100))}%`,
    );
  }

  // Confidence depends on total line count (more lines = more reliable)
  const confidence = clamp(Math.min(analysis.totalLineCount / 100, 1) * 0.8 + 0.2, 0, 1);

  return {
    passed,
    contentRatio,
    confidence,
    reasons,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
