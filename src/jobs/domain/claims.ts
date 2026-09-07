import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/v4';
import { ClaimCandidateIdSchema, EvidenceRefSchema, InstantSchema } from './ids.js';

export const ClaimOriginSchema = z.enum([
  'observed',
  'user_supplied',
  'deterministic_derived',
  'model_derived',
]);
export const ClaimProvenanceSchema = z
  .object({
    component: z.string().min(1),
    version: z.string().min(1),
    model: z.string().min(1).optional(),
    promptVersion: z.string().min(1).optional(),
    producedAt: InstantSchema,
  })
  .strict();
export const ClaimCandidateSchema = z
  .object({
    candidateId: ClaimCandidateIdSchema,
    value: z.unknown(),
    evidenceRefs: z.array(EvidenceRefSchema),
    confidence: z.number().min(0).max(1),
    origin: ClaimOriginSchema,
    method: z.string().min(1),
    provenance: ClaimProvenanceSchema,
  })
  .strict()
  .superRefine((candidate, ctx) => {
    if (candidate.origin === 'observed' && candidate.evidenceRefs.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidenceRefs'],
        message: 'observed claims require evidence',
      });
    }
  });
export type ClaimCandidate<T> = Omit<z.infer<typeof ClaimCandidateSchema>, 'value'> & { value: T };
export const ResolvedClaimStateSchema = z.enum(['resolved', 'conflicting', 'unresolved']);
const ResolvedClaimWithSelectionSchema = z
  .object({
    state: z.enum(['resolved', 'conflicting']),
    selected: ClaimCandidateSchema,
    alternatives: z.array(ClaimCandidateSchema),
  })
  .strict();
const UnresolvedClaimSchema = z
  .object({
    state: z.literal('unresolved'),
    alternatives: z.array(ClaimCandidateSchema),
  })
  .strict();
export const ResolvedClaimSchema = z.discriminatedUnion('state', [
  ResolvedClaimWithSelectionSchema,
  UnresolvedClaimSchema,
]);
type ReplaceClaimValue<C, T> = C extends { value: unknown } ? Omit<C, 'value'> & { value: T } : C;
type ReplaceResolvedClaimValues<C, T> = C extends {
  selected: infer Selected;
  alternatives: infer Alternatives;
}
  ? Omit<C, 'selected' | 'alternatives'> & {
      selected: ReplaceClaimValue<Selected, T>;
      alternatives: ReplaceClaimValue<
        Alternatives extends readonly unknown[] ? Alternatives[number] : never,
        T
      >[];
    }
  : C extends { alternatives: infer Alternatives }
    ? Omit<C, 'alternatives'> & {
        alternatives: ReplaceClaimValue<
          Alternatives extends readonly unknown[] ? Alternatives[number] : never,
          T
        >[];
      }
    : C;
export type ResolvedClaim<T> = ReplaceResolvedClaimValues<z.infer<typeof ResolvedClaimSchema>, T>;

const priority = (origin: ClaimCandidate<unknown>['origin']) =>
  origin === 'observed'
    ? 4
    : origin === 'user_supplied'
      ? 3
      : origin === 'deterministic_derived'
        ? 2
        : 1;
const equal = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);

/** Selects a representative without allowing model-derived values to replace observed values. */
export function resolveClaim<T>(candidates: readonly ClaimCandidate<T>[]): ResolvedClaim<T> {
  const evidenced = candidates.filter(
    (candidate) => candidate.origin !== 'observed' || candidate.evidenceRefs.length > 0,
  );
  if (evidenced.length === 0) return { state: 'unresolved', alternatives: [] };
  const selected = [...evidenced]
    .sort((a, b) => priority(b.origin) - priority(a.origin) || b.confidence - a.confidence)
    .at(0);
  if (!selected) return { state: 'unresolved', alternatives: [] };
  const conflicting = evidenced.some((candidate) => !equal(candidate.value, selected.value));
  const result = {
    state: conflicting ? ('conflicting' as const) : ('resolved' as const),
    selected,
    alternatives: [...evidenced],
  };
  ResolvedClaimSchema.parse(result);
  return result;
}
