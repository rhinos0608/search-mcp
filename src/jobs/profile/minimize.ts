import { randomUUID } from 'node:crypto';
import {
  MinimizedProfileDraftSchema,
  ProfileInputSchema,
  ProfileMinimizationResultSchema,
  ProfileRequestEvidenceSchema,
  ProfileTermRefSchema,
  type MinimizedProfileDraft,
  type ProfileMinimizationResult,
  type ProfilePreference,
  type ProfileTermRef,
} from './contracts.js';

export const canonicalProfileTermKey = (term: ProfileTermRef): string =>
  JSON.stringify([term.kind, term.packId, term.packVersion, term.termId]);

const MAX_ITEMS = 32;
export interface MinimizeProfileOptions {
  allowedTermRefs: ReadonlySet<string>;
  createEvidenceId?: () => string;
}
const key = canonicalProfileTermKey;
const reject = (
  code: 'INVALID_PROFILE_INPUT' | 'UNAPPROVED_PROFILE_TERM',
): ProfileMinimizationResult =>
  ProfileMinimizationResultSchema.parse({
    status: 'rejected',
    code,
    warnings: [
      code === 'INVALID_PROFILE_INPUT' ? 'invalid_profile_input' : 'unapproved_profile_term',
    ],
  });
const dedupe = <T>(values: readonly T[], getKey: (value: T) => string): T[] =>
  [...new Map(values.map((value) => [getKey(value), value])).values()].slice(0, MAX_ITEMS);

export function minimizeProfile(
  input: unknown,
  options: MinimizeProfileOptions,
): ProfileMinimizationResult {
  const parsed = ProfileInputSchema.safeParse(input);
  if (!parsed.success) return reject('INVALID_PROFILE_INPUT');
  if (parsed.data.kind !== 'structured_profile') {
    return ProfileMinimizationResultSchema.parse({
      status: 'requires_extractor',
      inputKind: parsed.data.kind,
      code: 'VETTED_EXTRACTOR_REQUIRED',
      rawRetained: false,
      warnings: ['free_text_extraction_unavailable'],
    });
  }
  const profile = parsed.data.profile;
  const refs = [
    ...(profile.roleHints ?? []),
    ...(profile.capabilities ?? []),
    ...(profile.qualifications ?? []),
    ...(profile.licences ?? []),
    ...(profile.clearances ?? []),
    ...(profile.registrations ?? []),
    ...(profile.requestedEligibility ?? []),
  ];
  const preferences = profile.preferences ?? [];
  const preferenceTerms = preferences.filter((p) => p.kind === 'term').map((p) => p.value);
  if (
    [...refs, ...preferenceTerms].some(
      (term) =>
        !ProfileTermRefSchema.safeParse(term).success || !options.allowedTermRefs.has(key(term)),
    )
  )
    return reject('UNAPPROVED_PROFILE_TERM');
  const createEvidenceId = options.createEvidenceId ?? (() => `profile-evidence:${randomUUID()}`);
  const id = createEvidenceId();
  const evidenceResult = ProfileRequestEvidenceSchema.safeParse({
    evidenceId: id,
    kind: 'user_statement',
    scope: 'request',
    retention: 'ephemeral',
    rawRetained: false,
  });
  if (!evidenceResult.success) return reject('INVALID_PROFILE_INPUT');
  const evidenceRefs = [id] as [string, ...string[]];
  const fact = (term: ProfileTermRef) => ({
    term,
    origin: 'user_supplied' as const,
    dataClass: 'job_fact' as const,
    evidenceRefs,
  });
  const withEvidence = (p: (typeof preferences)[number]): ProfilePreference => ({
    ...p,
    evidenceRefs,
  });
  const draft: MinimizedProfileDraft = MinimizedProfileDraftSchema.parse({
    roleHints: dedupe((profile.roleHints ?? []).map(fact), (p) => key(p.term)),
    capabilities: dedupe((profile.capabilities ?? []).map(fact), (p) => key(p.term)),
    qualifications: dedupe((profile.qualifications ?? []).map(fact), (p) => key(p.term)),
    licences: dedupe((profile.licences ?? []).map(fact), (p) => key(p.term)),
    clearances: dedupe((profile.clearances ?? []).map(fact), (p) => key(p.term)),
    registrations: dedupe((profile.registrations ?? []).map(fact), (p) => key(p.term)),
    requestedEligibility: dedupe((profile.requestedEligibility ?? []).map(fact), (p) =>
      key(p.term),
    ),
    preferences: dedupe(preferences.map(withEvidence), (p) => JSON.stringify(p)),
    observedCandidateFacts: [],
    evidenceRefs,
  });
  return ProfileMinimizationResultSchema.parse({
    status: 'minimized',
    draft,
    evidence: [evidenceResult.data],
    warnings: [],
  });
}
