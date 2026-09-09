/**
 * Frozen operator-reviewed policy evidence records.
 *
 * Conclusions encode operator policy, not legal holdings.
 * Dates on SEEK terms/robots are cited document publication metadata,
 * not a claim that this process captured bytes. contentHash omitted.
 */
import { sourceEvidenceId } from '../ids.js';
import { AuthorizationEvidenceSchema, type AuthorizationEvidence } from '../contracts.js';
import { SEEK_SOURCE_ID } from '../seek.js';
import { MANUAL_IMPORT_ADAPTER_ID } from '../../adapters/manualImport.js';

const ADR_011 = 'docs/jobs/adr/ADR-011-source-policy.md';
const ADR_012 = 'docs/jobs/adr/ADR-012-seek-manual-import.md';
const OPERATOR_REVIEWED_AT = '2026-01-01T00:00:00.000Z';
const SEEK_TERMS_AT = '2026-07-20T00:00:00.000Z';
const REVIEWER = 'jobs-policy/1';

function record(input: {
  sourceId: string;
  kind: AuthorizationEvidence['kind'];
  capturedAt: string;
  citationRef: string;
  documentTitle?: string;
  reviewedAt: string;
  conclusion: NonNullable<AuthorizationEvidence['conclusion']>;
  appliesTo?: AuthorizationEvidence['appliesTo'];
}): AuthorizationEvidence {
  const evidenceId = sourceEvidenceId(
    input.sourceId,
    input.kind,
    input.capturedAt,
    input.citationRef,
    undefined,
  );
  const body: Record<string, unknown> = {
    schemaVersion: '1.0.0',
    evidenceId,
    sourceId: input.sourceId,
    kind: input.kind,
    capturedAt: input.capturedAt,
    citationRef: input.citationRef,
    reviewedAt: input.reviewedAt,
    reviewerId: REVIEWER,
    conclusion: input.conclusion,
  };
  if (input.documentTitle !== undefined) body.documentTitle = input.documentTitle;
  if (input.appliesTo !== undefined) body.appliesTo = input.appliesTo;
  return AuthorizationEvidenceSchema.parse(body);
}

function seekApplies(
  operation: 'automatedSearch' | 'automatedFetch',
): NonNullable<AuthorizationEvidence['appliesTo']> {
  return {
    sourceId: SEEK_SOURCE_ID,
    operation,
    route: 'direct',
    targetKind: 'board',
    policyMode: operation,
  };
}

export const SEEK_TERMS_SEARCH_EVIDENCE: AuthorizationEvidence = record({
  sourceId: SEEK_SOURCE_ID,
  kind: 'published_access_terms',
  capturedAt: SEEK_TERMS_AT,
  citationRef: 'https://au.seek.com/terms/en',
  documentTitle: 'SEEK Website Terms',
  reviewedAt: SEEK_TERMS_AT,
  conclusion: 'direct_automated_access_blocked',
  appliesTo: seekApplies('automatedSearch'),
});

/**
 * Dedicated SEEK automatedFetch evidence. Distinct citation anchor and
 * sourceEvidenceId from the search terms record; cited on the blocked
 * SEEK fetch edge. Anchor is a section reference in the cited document,
 * not a byte-capture claim.
 */
export const SEEK_TERMS_FETCH_EVIDENCE: AuthorizationEvidence = record({
  sourceId: SEEK_SOURCE_ID,
  kind: 'published_access_terms',
  capturedAt: SEEK_TERMS_AT,
  citationRef: 'https://au.seek.com/terms/en#automated-access',
  documentTitle: 'SEEK Website Terms',
  reviewedAt: SEEK_TERMS_AT,
  conclusion: 'direct_automated_access_blocked',
  appliesTo: seekApplies('automatedFetch'),
});

export const SEEK_ROBOTS_EVIDENCE: AuthorizationEvidence = record({
  sourceId: SEEK_SOURCE_ID,
  kind: 'robots_metadata',
  capturedAt: SEEK_TERMS_AT,
  citationRef: 'https://www.seek.com.au/robots.txt',
  reviewedAt: SEEK_TERMS_AT,
  conclusion: 'direct_automated_access_blocked',
  appliesTo: seekApplies('automatedSearch'),
});

export const SEEK_POLICY_EVIDENCE: readonly AuthorizationEvidence[] = [
  SEEK_TERMS_SEARCH_EVIDENCE,
  SEEK_TERMS_FETCH_EVIDENCE,
  SEEK_ROBOTS_EVIDENCE,
];

export function indexedProviderEvidence(providerId: string): AuthorizationEvidence {
  const citationRef =
    providerId === 'search-provider:exa'
      ? 'https://docs.exa.ai/reference/search'
      : providerId === 'search-provider:tavily'
        ? 'https://docs.tavily.com/documentation/api-reference/endpoint/search'
        : ADR_011;
  return record({
    sourceId: providerId,
    kind: 'capability_classification',
    capturedAt: OPERATOR_REVIEWED_AT,
    citationRef,
    reviewedAt: OPERATOR_REVIEWED_AT,
    conclusion: 'indexed_provider_operator_authorized',
    appliesTo: {
      sourceId: providerId,
      operation: 'automatedSearch',
      route: 'indexed',
      targetKind: 'discovery_provider',
      policyMode: 'automatedSearch',
    },
  });
}

export function manualImportEvidence(): AuthorizationEvidence {
  return record({
    sourceId: MANUAL_IMPORT_ADAPTER_ID,
    kind: 'capability_classification',
    capturedAt: OPERATOR_REVIEWED_AT,
    citationRef: ADR_012,
    reviewedAt: OPERATOR_REVIEWED_AT,
    conclusion: 'manual_import_user_supplied',
    appliesTo: {
      sourceId: MANUAL_IMPORT_ADAPTER_ID,
      operation: 'manualImport',
      route: 'user_supplied',
      targetKind: 'adapter',
      policyMode: 'manualImport',
    },
  });
}

export function requireLiveEvidenceRefs(sourceId: string, evidenceRefs: readonly string[]): void {
  if (evidenceRefs.length === 0) {
    throw new Error(`live policy ${sourceId} missing reviewed evidence`);
  }
}

export function boardPolicyEvidence(board: string): AuthorizationEvidence {
  return record({
    sourceId: `board:${board}`,
    kind: 'operator_configured_board_search',
    capturedAt: OPERATOR_REVIEWED_AT,
    citationRef: ADR_011,
    reviewedAt: OPERATOR_REVIEWED_AT,
    conclusion: 'operator_configured_board_search',
    appliesTo: {
      sourceId: `board:${board}`,
      operation: 'automatedSearch',
      route: 'direct',
      targetKind: 'board',
      policyMode: 'automatedSearch',
    },
  });
}
