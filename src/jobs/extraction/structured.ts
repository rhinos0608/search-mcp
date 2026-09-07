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
  baseSalary?: { value?: string | number; currency?: string; unitText?: string };
  url?: string;
}

export interface StructuredExtractionResult {
  fields: Record<string, { value: unknown; evidenceId: JobsEvidenceId; method: ExtractionMethod }>;
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

  if (posting.url) {
    try {
      new URL(posting.url);
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

  return { fields, warnings };
}
