import type { JobsEvidenceId } from './contracts.js';
import { jobsEvidenceId } from './ids.js';
import { parseIsoDate, normalizeEmploymentType } from './normalize.js';
import type { ExtractionMethod } from './contracts.js';

// ── JSON-LD extraction ─────────────────────────────────────────────────

interface JsonLdJobPosting {
  title?: string;
  description?: string;
  hiringOrganization?: { name?: string; department?: string };
  datePosted?: string;
  validThrough?: string;
  employmentType?: string;
  jobLocation?: {
    address?: { addressCountry?: string; addressRegion?: string; addressLocality?: string };
  };
  baseSalary?: {
    value?: string | number | Record<string, unknown>;
    minValue?: string | number;
    maxValue?: string | number;
    currency?: string;
    unitText?: string;
  } & Record<string, unknown>;
  url?: string;
}

export interface StructuredFieldValue {
  value: unknown;
  evidenceId: JobsEvidenceId;
  method: ExtractionMethod;
}

export interface StructuredExtractionResult {
  fields: Record<string, StructuredFieldValue>;
  /** Parsed jobLocation address (city/region/country) when present. */
  location?: StructuredFieldValue;
  /** Parsed baseSalary interval (explicit currency only) when present. */
  salary?: StructuredFieldValue;
  warnings: string[];
}

export function extractJsonLdJobPosting(
  jsonData: unknown,
  observationId: string,
): StructuredExtractionResult {
  const posting = jsonData as JsonLdJobPosting;
  const fields: StructuredExtractionResult['fields'] = {};
  const warnings: string[] = [];

  if (posting.title) {
    const evidenceId = jobsEvidenceId(
      observationId,
      'structured_field',
      'title',
      '/jsonld/title',
      null,
      null,
    );
    fields.title = { value: posting.title, evidenceId, method: 'jsonld_jobposting' };
  }

  if (posting.hiringOrganization?.name) {
    const evidenceId = jobsEvidenceId(
      observationId,
      'structured_field',
      'organisation',
      '/jsonld/hiringOrganization.name',
      null,
      null,
    );
    fields.organisation = {
      value: posting.hiringOrganization.name,
      evidenceId,
      method: 'jsonld_jobposting',
    };
  }

  if (posting.hiringOrganization?.department) {
    const evidenceId = jobsEvidenceId(
      observationId,
      'structured_field',
      'organisationUnit',
      '/jsonld/hiringOrganization.department',
      null,
      null,
    );
    fields.organisationUnit = {
      value: posting.hiringOrganization.department,
      evidenceId,
      method: 'jsonld_jobposting',
    };
  }

  if (posting.datePosted) {
    const parsed = parseIsoDate(posting.datePosted);
    if (parsed) {
      const evidenceId = jobsEvidenceId(
        observationId,
        'structured_field',
        'postedAt',
        '/jsonld/datePosted',
        null,
        null,
      );
      fields.postedAt = { value: parsed, evidenceId, method: 'jsonld_jobposting' };
    } else {
      warnings.push('structured_unstructured_conflict');
    }
  }

  if (posting.validThrough) {
    const parsed = parseIsoDate(posting.validThrough);
    if (parsed) {
      const evidenceId = jobsEvidenceId(
        observationId,
        'structured_field',
        'closingAt',
        '/jsonld/validThrough',
        null,
        null,
      );
      fields.closingAt = { value: parsed, evidenceId, method: 'jsonld_jobposting' };
    }
  }

  if (posting.employmentType) {
    const normalized = normalizeEmploymentType(posting.employmentType);
    if (normalized) {
      const evidenceId = jobsEvidenceId(
        observationId,
        'structured_field',
        'employmentType',
        '/jsonld/employmentType',
        null,
        null,
      );
      fields.employmentType = { value: normalized, evidenceId, method: 'jsonld_jobposting' };
    }
  }

  if (posting.description) {
    const capped =
      posting.description.length > 32_768
        ? posting.description.slice(0, 32_768)
        : posting.description;
    const evidenceId = jobsEvidenceId(
      observationId,
      'structured_field',
      'description',
      '/jsonld/description',
      null,
      null,
    );
    fields.description = { value: capped, evidenceId, method: 'jsonld_jobposting' };
  }

  let location: StructuredFieldValue | undefined;
  if (posting.jobLocation?.address) {
    const addr = posting.jobLocation.address;
    const city = typeof addr.addressLocality === 'string' ? addr.addressLocality.trim() : '';
    const region = typeof addr.addressRegion === 'string' ? addr.addressRegion.trim() : '';
    const country = typeof addr.addressCountry === 'string' ? addr.addressCountry.trim() : '';
    if (city.length > 0 || region.length > 0 || country.length > 0) {
      const loc: Record<string, string> = {};
      if (city.length > 0) loc.city = city;
      if (region.length > 0) loc.region = region;
      if (country.length > 0) loc.country = country;
      location = {
        value: loc,
        evidenceId: jobsEvidenceId(
          observationId,
          'structured_field',
          'location',
          '/jsonld/jobLocation',
          null,
          null,
        ),
        method: 'jsonld_jobposting',
      };
    }
  }
  const salaryParsed = parseJsonLdSalary(posting.baseSalary, observationId);
  if (salaryParsed?.warning) warnings.push(salaryParsed.warning);
  if (posting.url) {
    try {
      const url = new URL(posting.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error('unsupported URL scheme');
      if (url.username.length > 0 || url.password.length > 0)
        throw new Error('credential-bearing URL');
      const evidenceId = jobsEvidenceId(
        observationId,
        'structured_field',
        'applyUrl',
        '/jsonld/url',
        null,
        null,
      );
      fields.applyUrl = { value: posting.url, evidenceId, method: 'jsonld_jobposting' };
    } catch {
      // invalid URL — skip structured URL candidate
    }
  }

  const out: StructuredExtractionResult = { fields, warnings };
  if (location) out.location = location;
  if (salaryParsed?.value && salaryParsed.evidenceId && Object.keys(salaryParsed.value).length > 0)
    out.salary = {
      value: salaryParsed.value,
      evidenceId: salaryParsed.evidenceId,
      method: 'jsonld_jobposting',
    };
  return out;
}

// ── JSON-LD baseSalary: explicit currency only, never locale default ──────
// Accepts { value, currency, unitText } and QuantitativeValue-ish shapes.
// Unknown/ambiguous currency (bare $) → unresolved: no salary emitted,
// salary_parse_failed warning instead of a fabricated default.
function parseJsonLdSalary(
  baseSalary: JsonLdJobPosting['baseSalary'] | undefined,
  observationId: string,
): { value?: Record<string, unknown>; evidenceId?: JobsEvidenceId; warning?: string } | undefined {
  // JSON-LD is untrusted input; the type system cannot guarantee the runtime
  // shape, so the null/primitive guard stays even if types say it is dead.
  const rawBase: unknown = baseSalary;
  if (rawBase === null || typeof rawBase !== 'object') return undefined;
  const raw = rawBase as Record<string, unknown>;
  const inner =
    raw.value !== null && typeof raw.value === 'object'
      ? (raw.value as Record<string, unknown>)
      : undefined;
  const source = inner ?? raw;
  const currencyRaw = source.currency ?? raw.currency;
  const unitRaw = source.unitText ?? raw.unitText;
  const currency =
    typeof currencyRaw === 'string' && /^[A-Za-z]{3}$/u.test(currencyRaw.trim())
      ? currencyRaw.trim().toUpperCase()
      : undefined;
  const unitText = typeof unitRaw === 'string' ? unitRaw.trim().toLowerCase() : '';
  const unit = unitText.startsWith('hour')
    ? 'hour'
    : unitText.startsWith('day')
      ? 'day'
      : unitText.startsWith('week')
        ? 'week'
        : unitText.startsWith('month')
          ? 'month'
          : unitText.startsWith('year') || unitText.startsWith('annual')
            ? 'year'
            : undefined;
  if (currency === undefined || unit === undefined) return { warning: 'salary_parse_failed' };
  const parseBound = (value: unknown): number | undefined => {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
    if (typeof value !== 'string' || !/^\s*\d[\d,]*(?:\.\d+)?\s*$/u.test(value)) return undefined;
    const parsed = Number(value.replace(/,/g, '').trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(source, key);
  const min = has('minValue') ? parseBound(source.minValue) : parseBound(source.value);
  const max = has('maxValue') ? parseBound(source.maxValue) : parseBound(source.value);
  if (min === undefined && max === undefined) return { warning: 'salary_parse_failed' };
  if ((has('minValue') && min === undefined) || (has('maxValue') && max === undefined))
    return { warning: 'salary_parse_failed' };
  if (min !== undefined && max !== undefined && min > max)
    return { warning: 'salary_parse_failed' };
  const boundsText =
    min !== undefined && max !== undefined
      ? min !== max
        ? `${String(min)}-${String(max)}`
        : String(min)
      : String(min ?? max ?? '');
  return {
    value: {
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      currency,
      unit,
      period: 'stated',
      raw: `${currency} ${boundsText} per ${unit}`,
    },
    evidenceId: jobsEvidenceId(
      observationId,
      'structured_field',
      'salary',
      '/jsonld/baseSalary',
      null,
      null,
    ),
  };
}
