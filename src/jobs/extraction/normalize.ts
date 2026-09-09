import type { ExtractionMethod } from './contracts.js';

// ── Employment type normalization ──────────────────────────────────────

const EMPLOYMENT_TYPE_MAP: Record<
  string,
  'full_time' | 'part_time' | 'casual' | 'contract' | 'temporary' | 'internship'
> = {
  'full-time': 'full_time',
  'full time': 'full_time',
  fulltime: 'full_time',
  permanent: 'full_time',
  'part-time': 'part_time',
  'part time': 'part_time',
  parttime: 'part_time',
  casual: 'casual',
  contract: 'contract',
  contractor: 'contract',
  temporary: 'temporary',
  temp: 'temporary',
  intern: 'internship',
  internship: 'internship',
  'graduate intern': 'internship',
};

export function normalizeEmploymentType(
  raw: string,
): 'full_time' | 'part_time' | 'casual' | 'contract' | 'temporary' | 'internship' | undefined {
  return EMPLOYMENT_TYPE_MAP[raw.trim().toLowerCase()];
}

// ── Work mode normalization ────────────────────────────────────────────

const WORK_MODE_MAP: Record<string, 'onsite' | 'hybrid' | 'remote'> = {
  'on-site': 'onsite',
  onsite: 'onsite',
  'in-office': 'onsite',
  'in office': 'onsite',
  hybrid: 'hybrid',
  remote: 'remote',
  'work from home': 'remote',
  wfh: 'remote',
};

export function normalizeWorkMode(raw: string): 'onsite' | 'hybrid' | 'remote' | undefined {
  return WORK_MODE_MAP[raw.trim().toLowerCase()];
}

// ── Title normalization ────────────────────────────────────────────────

export function normalizeTitle(title: string): string {
  return title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

// ── Date parsing ───────────────────────────────────────────────────────

export function parseIsoDate(raw: string): string | undefined {
  const trimmed = raw.trim();
  // Date-only YYYY-MM-DD → midnight UTC
  const dateOnlyMatch = /^(\d{4}-\d{2}-\d{2})$/.exec(trimmed);
  if (dateOnlyMatch) {
    const datePart = dateOnlyMatch[1];
    if (!datePart) return undefined;
    return `${datePart}T00:00:00Z`;
  }
  // Full ISO with offset
  try {
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) return undefined;
    return parsed.toISOString();
  } catch {
    return undefined;
  }
}

// ── JSON-LD field mapping ─────────────────────────────────────────────

export interface JsonLdFieldMapping {
  jsonLdPath: string;
  fieldPath: string;
  method: ExtractionMethod;
}

export const JSONLD_FIELD_MAPPINGS: readonly JsonLdFieldMapping[] = [
  { jsonLdPath: 'title', fieldPath: 'title', method: 'jsonld_jobposting' },
  { jsonLdPath: 'hiringOrganization.name', fieldPath: 'organisation', method: 'jsonld_jobposting' },
  {
    jsonLdPath: 'hiringOrganization.department',
    fieldPath: 'organisationUnit',
    method: 'jsonld_jobposting',
  },
  { jsonLdPath: 'datePosted', fieldPath: 'postedAt', method: 'jsonld_jobposting' },
  { jsonLdPath: 'validThrough', fieldPath: 'closingAt', method: 'jsonld_jobposting' },
  { jsonLdPath: 'description', fieldPath: 'description', method: 'jsonld_jobposting' },
  { jsonLdPath: 'url', fieldPath: 'applyUrl', method: 'jsonld_jobposting' },
];

// ── Unstructured title extraction ──────────────────────────────────────

const TEXT_LABEL_PREFIX = /^(Title|Location|Company|Organisation|Employer|Salary|Description):\s*/i;

export function extractTitleFromText(text: string): string | undefined {
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim().replace(TEXT_LABEL_PREFIX, '');
    if (trimmed.length > 0 && trimmed.length <= 200 && !trimmed.startsWith('#')) {
      return trimmed;
    }
  }
  // Also try first heading
  for (const line of lines) {
    const match = /^#+\s+(.+)$/.exec(line);
    const heading = match?.[1];
    if (heading && heading.length <= 200) {
      return heading.trim();
    }
  }
  return undefined;
}

// ── Unstructured organisation extraction ───────────────────────────────

/**
 * Parse a free-text `Location:` label into a Location object (comma-separated
 * city, region, country). Deterministic heuristic; no geo resolution.
 */
export function extractLocationFromText(
  text: string,
): { city?: string; region?: string; country?: string } | undefined {
  const match = /^Location:\s*(.+)$/im.exec(text);
  const value = match?.[1];
  if (value === undefined) return undefined;
  const parts = value
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, 3);
  const [first, second, third] = parts;
  if (first === undefined) return undefined;
  if (second !== undefined && third !== undefined) {
    return { city: first, region: second, country: third };
  }
  if (second !== undefined) return { city: first, region: second };
  return { city: first };
}

// ── Unstructured organisation extraction ───────────────────────────────

export function extractOrganisationFromText(text: string): string | undefined {
  const patterns = [/(?:Company|Organisation|Employer):\s*(.+)/i];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

// ── Work mode token extraction ─────────────────────────────────────────

export function extractWorkModeFromText(text: string): 'onsite' | 'hybrid' | 'remote' | undefined {
  const lower = text.toLowerCase();
  if (/\bremote\b/.test(lower) || /\bwork\s+from\s+home\b/.test(lower) || /\bwfh\b/.test(lower))
    return 'remote';
  if (/\bhybrid\b/.test(lower)) return 'hybrid';
  if (/\bon[- ]?site\b/.test(lower) || /\bin[- ]?office\b/.test(lower)) return 'onsite';
  return undefined;
}

// ── Employment type token extraction ───────────────────────────────────

export function extractEmploymentTypeFromText(
  text: string,
): 'full_time' | 'part_time' | 'casual' | 'contract' | 'temporary' | 'internship' | undefined {
  const lower = text.toLowerCase();
  if (/\bfull[- ]?time\b/.test(lower) || /\bpermanent\b/.test(lower)) return 'full_time';
  if (/\bpart[- ]?time\b/.test(lower)) return 'part_time';
  if (/\bcasual\b/.test(lower)) return 'casual';
  if (/\bcontract(?:or)?\b/.test(lower)) return 'contract';
  if (/\btemporary\b/.test(lower) || /\btemp\b/.test(lower)) return 'temporary';
  if (/\bintern(?:ship)?\b/.test(lower) || /\bgraduate\s+intern\b/.test(lower)) return 'internship';
  return undefined;
}

// ── Salary regex (conservative) ────────────────────────────────────────

const SALARY_PATTERN =
  /(?:AUD|USD|GBP|EUR|\$|£|€)\s*(\d[\d,]*(?:\.\d+)?)\s*(?:to|[-–—])\s*(?:AUD|USD|GBP|EUR|\$|£|€)?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:per\s+)?(hour|day|week|month|year)/i;

const SALARY_SINGLE_PATTERN =
  /(?:AUD|USD|GBP|EUR|\$|£|€)\s*(\d[\d,]*(?:\.\d+)?)\s*(?:per\s+)?(hour|day|week|month|year)/i;

export function extractSalaryFromText(
  text: string,
): { min?: number; max?: number; currency?: string; unit: string; raw: string } | undefined {
  const rangeMatch = SALARY_PATTERN.exec(text);
  if (rangeMatch) {
    const raw = rangeMatch[0];
    const minStr = rangeMatch[1];
    const maxStr = rangeMatch[2];
    const unitStr = rangeMatch[3];
    if (!minStr || !maxStr || !unitStr) return undefined;
    const min = parseFloat(minStr.replace(/,/g, ''));
    const max = parseFloat(maxStr.replace(/,/g, ''));
    if (!Number.isNaN(min) && !Number.isNaN(max) && min <= max) {
      const currency = extractCurrency(raw);
      return {
        min,
        max,
        ...(currency !== undefined ? { currency } : {}),
        unit: normalizeSalaryUnit(unitStr),
        raw: raw.trim(),
      };
    }
    // min>max → return raw span only for fallback
    if (!Number.isNaN(min) && !Number.isNaN(max)) {
      const currency = extractCurrency(raw);
      return {
        ...(currency !== undefined ? { currency } : {}),
        unit: normalizeSalaryUnit(unitStr),
        raw: raw.trim(),
      };
    }
  }
  const singleMatch = SALARY_SINGLE_PATTERN.exec(text);
  if (singleMatch) {
    const raw = singleMatch[0];
    const valStr = singleMatch[1];
    const unitStr = singleMatch[2];
    if (!valStr || !unitStr) return undefined;
    const value = parseFloat(valStr.replace(/,/g, ''));
    if (!Number.isNaN(value)) {
      const currency = extractCurrency(raw);
      return {
        min: value,
        max: value,
        ...(currency !== undefined ? { currency } : {}),
        unit: normalizeSalaryUnit(unitStr),
        raw: raw.trim(),
      };
    }
  }
  return undefined;
}

// Generic core: only explicit currency tokens resolve. Bare `$` is ambiguous
// (USD/AUD/CAD/MXN/...) so currency stays unresolved rather than defaulting.
function extractCurrency(match: string): string | undefined {
  if (/\bUSD\b/i.test(match)) return 'USD';
  if (/\bGBP\b/i.test(match) || match.includes('£')) return 'GBP';
  if (/\bEUR\b/i.test(match) || match.includes('€')) return 'EUR';
  if (/\bAUD\b/i.test(match)) return 'AUD';
  return undefined;
}

function normalizeSalaryUnit(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (lower.startsWith('hour')) return 'hour';
  if (lower.startsWith('day')) return 'day';
  if (lower.startsWith('week')) return 'week';
  if (lower.startsWith('month')) return 'month';
  if (lower.startsWith('year')) return 'year';
  return 'year';
}
