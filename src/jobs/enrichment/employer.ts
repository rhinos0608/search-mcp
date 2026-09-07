import type {
  EnrichmentWarning,
  ExtractedFieldSnapshot,
  VerifiedEmployerCatalog,
} from './contracts.js';

export interface EmployerEnrichmentResult {
  readonly employerMatch: {
    readonly employerRecordId?: string | undefined;
    readonly legalName?: string | undefined;
    readonly sector?: string | undefined;
    readonly organisationUnit?: string | undefined;
    readonly match: 'exact' | 'alias' | 'none' | 'ambiguous';
    readonly evidenceRefs: string[];
  };
  readonly warnings: EnrichmentWarning[];
}

function normalizeOrg(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function enrichEmployer(
  snapshot: ExtractedFieldSnapshot,
  catalog: VerifiedEmployerCatalog | undefined,
  _clock: { producedAt: string },
): EmployerEnrichmentResult {
  const warnings: EnrichmentWarning[] = [];

  if (!snapshot.organisation || !catalog) {
    return {
      employerMatch: { match: 'none', evidenceRefs: [] },
      warnings,
    };
  }

  const orgNorm = normalizeOrg(snapshot.organisation);
  const exactMatch = catalog.records.find((r) => normalizeOrg(r.legalName) === orgNorm);
  if (exactMatch) {
    return {
      employerMatch: {
        employerRecordId: exactMatch.employerRecordId,
        legalName: exactMatch.legalName,
        sector: exactMatch.sector,
        organisationUnit: exactMatch.organisationUnit,
        match: 'exact',
        evidenceRefs: [...exactMatch.evidenceRefs],
      },
      warnings,
    };
  }

  const aliasMatches = catalog.records.filter((r) =>
    r.aliases.some((a) => normalizeOrg(a) === orgNorm),
  );
  if (aliasMatches.length > 1) {
    warnings.push({ code: 'EMPLOYER_AMBIGUOUS' });
    return { employerMatch: { match: 'ambiguous', evidenceRefs: [] }, warnings };
  }
  const aliasMatch = aliasMatches[0];
  if (aliasMatch) {
    return {
      employerMatch: {
        employerRecordId: aliasMatch.employerRecordId,
        legalName: aliasMatch.legalName,
        sector: aliasMatch.sector,
        organisationUnit: aliasMatch.organisationUnit,
        match: 'alias',
        evidenceRefs: [...aliasMatch.evidenceRefs],
      },
      warnings,
    };
  }

  warnings.push({ code: 'EMPLOYER_UNMATCHED' });
  return { employerMatch: { match: 'none', evidenceRefs: [] }, warnings };
}
