/**
 * EntryLevelClassifier
 *
 * Determines whether a job listing is compatible with entry-level expectations.
 *
 * Uses signals from:
 * - Title keywords (positive: "junior", "graduate", "trainee"; negative: "senior", "lead")
 * - Experience requirements (explicit "X+ years" mentions)
 * - Salary bands (>$100k AUD → not entry level)
 * - Qualification requirements (degree, diploma, certificate IV)
 * - Business structure requirements (ABN, contractor)
 */

import type { EntryLevelResult } from './types.js';
import type { JobListingMvp } from '../types/job.js';

// ── Positive signals ─────────────────────────────────────────────────────────

const ENTRY_LEVEL_KEYWORDS: readonly RegExp[] = [
  /\bno\s+experience\b/i,
  /\bentry[-\s]level\b/i,
  /\bjunior\b/i,
  /\bgraduate\b/i,
  /\btrainee\b/i,
  /\btraineeship\b/i,
  /\bintern\b/i,
  /\binternship\b/i,
  /\bapprentice\b/i,
  /\bapprenticeship\b/i,
  /\bschool[- ]leaver\b/i,
  /\bfresh\s+graduate\b/i,
  /\bnew\s+grad\b/i,
  /\bentry[- ]?grade\b/i,
  /\bcadet\b/i,
  /\bvacation\s+(?:program|work)\b/i,
  /\bwork\s+experience\b/i,
  /\bno\s+degree\s+required\b/i,
  /\bno\s+qualifications?\s+required\b/i,
  /\bfirst\s+job\b/i,
  /\breturn[- ]to[- ]work\b/i,
  /\bpathway\s+(?:program|role)?\b/i,
  /\bstart\s+(?:your\s+)?career\b/i,
  /\bentry\s+administration\b/i,
];

// ── Negative signals ─────────────────────────────────────────────────────────

const SENIORITY_KEYWORDS: readonly RegExp[] = [
  /\b(?:3|4|5|6|7|8|9|10|12|15)\+?\s*\+?\s*years?\s+(?:experience|exp)\b/i,
  /\b(?:2|3|4|5|6)\s*\+?\s*years?\s+experience\b/i,
  /\b(?:minimum|at\s+least|must\s+have|require)\s+(?:\d+)\s*years?\b/i,
  /\bsenior\b(?!\s*(?:assistant|citizen|lecturer))/i,
  /\blead\b/i,
  /\bhead\s+of\b/i,
  /\bmanager\b/i,
  /\bdirector\b/i,
  /\bprincipal\b/i,
  /\bchief\b/i,
  /\bexecutive\b/i,
  /\bvice\s+president\b/i,
  /\bspecialist\b/i,
  /\bexpert\b/i,
  /\bstrategic\b/i,
  /\b(?:10|15|20)\+?\s*\+?\s*years\b/i,
];

const QUALIFICATION_SIGNALS: readonly RegExp[] = [
  /\bABN\s+(?:required|needed|must)\b/i,
  /\bmust\s+have\s+ABN\b/i,
  /\bvalid\s+ABN\b/i,
  /\bCertificate\s+IV\b/i,
  /\bCert\s+IV\b/i,
  /\bdiploma\s+(?:required|essential|must)\b/i,
  /\bdegree\s+(?:required|essential|must)\b/i,
  /\bbachelor['´`]?s?\s+(?:degree|qualification)\b/i,
  /\bmaster['´`]?s?\s+(?:degree|qualification)\b/i,
  /\bPhD\b/i,
  /\bchartered\b/i,
  /\bprofessional\s+(?:certification|certificate|qualification)\b/i,
  /\bregistration\s+(?:required|essential|mandatory)\b/i,
  /\blicense\s+(?:required|essential|must)\b/i,
];

const TECHNICAL_CONTRACTOR_SIGNALS: readonly RegExp[] = [
  /\bscripting\b/i,
  /\bmortgage\s+broking\b/i,
  /\bfinance\s+qualifications?\b/i,
  /\bconstruction\s+(?:project|background|experience)\b/i,
  /\bproject\s+management\b/i,
  /\b(?:150k|200k|250k)\b/i,
  /\$\s*(?:150|200|250)\s*[kK]\b/i,
];

// ── Salary band check ────────────────────────────────────────────────────────

/**
 * Extract the maximum annual salary value from salary raw text.
 * Returns value in AUD (approximately) or undefined.
 */
function extractMaxAnnualSalary(salaryRaw: string | undefined): number | undefined {
  if (!salaryRaw) return undefined;

  const numbers = [...salaryRaw.matchAll(/\d[\d,]*\.?\d*/g)]
    .map((m) => Number.parseFloat(m[0].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (numbers.length === 0) return undefined;

  const maxVal = Math.max(...numbers);

  // If numbers like 50-70, assume k-scale (50k-70k)
  if (maxVal < 1000 && salaryRaw.toLowerCase().includes('k')) {
    return maxVal * 1000;
  }

  // If values are small like 20-40, they're probably hourly
  if (maxVal < 100) return undefined;

  return maxVal;
}

// ── Main classifier ──────────────────────────────────────────────────────────

/**
 * Classify a job listing's entry-level compatibility.
 *
 * Returns an EntryLevelResult with classification:
 * - 'entry': Likely entry-level or junior role
 * - 'mid': Mid-level or unclear
 * - 'senior': Senior or lead role
 * - 'overqualified': Clearly requires experience, qualifications, or contractor setup
 * - 'uncertain': No strong signals either way
 */
export function classifyEntryLevel(listing: JobListingMvp): EntryLevelResult {
  const title = listing.title;
  const description = listing.extractedText ?? '';
  const combined = `${title} ${description}`;

  // ── Count signals ─────────────────────────────────────────────────────
  const positiveCount = ENTRY_LEVEL_KEYWORDS.filter((p) => p.test(combined)).length;
  const negativeSeniorityCount = SENIORITY_KEYWORDS.filter((p) => p.test(combined)).length;
  const negativeQualificationCount = QUALIFICATION_SIGNALS.filter((p) => p.test(combined)).length;
  const negativeContractorCount = TECHNICAL_CONTRACTOR_SIGNALS.filter((p) =>
    p.test(combined),
  ).length;

  // Salary check
  const maxSalary = extractMaxAnnualSalary(listing.salaryRaw);
  const salaryTooHigh = maxSalary !== undefined && maxSalary > 100_000;

  // ── Decision ──────────────────────────────────────────────────────────

  // Strong senior/experienced signals → reject
  if (negativeSeniorityCount >= 2 || (negativeSeniorityCount >= 1 && salaryTooHigh)) {
    const reasons: string[] = [];
    if (negativeSeniorityCount >= 2)
      reasons.push(`Multiple seniority signals (${String(negativeSeniorityCount)})`);
    if (salaryTooHigh) reasons.push(`Salary $${String(maxSalary)} exceeds entry-level threshold`);
    return {
      passed: false,
      classification: 'overqualified',
      confidence: 0.85,
      reasons,
    };
  }

  // Explicit senior title → reject
  if (
    /\b(senior|lead|head\s+of|director|principal|chief|executive|vp|vice\s+president|manager)\b/i.test(
      title,
    ) &&
    !/\b(assistant\s+manager|office\s+manager)\b/i.test(title)
  ) {
    return {
      passed: false,
      classification: 'senior',
      confidence: 0.8,
      reasons: [`Title "${title}" appears senior/managerial`],
    };
  }

  // Contractor / ABN signals → reject
  if (negativeContractorCount >= 1 || negativeQualificationCount >= 2) {
    const reasons: string[] = [];
    if (negativeContractorCount >= 1)
      reasons.push('Contractor/ABN/business structure signals detected');
    if (negativeQualificationCount >= 2)
      reasons.push(`Multiple qualification requirements (${String(negativeQualificationCount)})`);
    return {
      passed: false,
      classification: 'overqualified',
      confidence: 0.7,
      reasons,
    };
  }

  // Salary too high even for mid-level → reject
  if (maxSalary !== undefined && maxSalary > 150_000) {
    return {
      passed: false,
      classification: 'senior',
      confidence: 0.75,
      reasons: [`Salary $${String(maxSalary)} suggests senior/executive role`],
    };
  }

  // Positive entry-level signals present → accept
  if (positiveCount >= 2) {
    return {
      passed: true,
      classification: 'entry',
      confidence: 0.85,
      reasons: [`Multiple entry-level signals detected (${String(positiveCount)})`],
    };
  }

  if (positiveCount === 1) {
    return {
      passed: true,
      classification: 'entry',
      confidence: 0.6,
      reasons: [
        `Entry-level signal detected: "${findFirstMatch(title, ENTRY_LEVEL_KEYWORDS) ?? ''}"`,
      ],
    };
  }

  // Salary in entry-level band
  if (maxSalary !== undefined && maxSalary <= 80_000) {
    return {
      passed: true,
      classification: 'entry',
      confidence: 0.55,
      reasons: [`Salary $${String(maxSalary)} is within entry-level band`],
    };
  }

  // No strong signals either way — let through as uncertain
  return {
    passed: true,
    classification: 'uncertain',
    confidence: 0.3,
    reasons: ['No clear entry-level or senior signals — allowing through'],
  };
}

function findFirstMatch(text: string, patterns: readonly RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return undefined;
}
