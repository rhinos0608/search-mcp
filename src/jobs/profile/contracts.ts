import { z } from 'zod/v4';

export const PROFILE_CONTRACT_VERSION = '1.0.0' as const;

const token = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const semver = z
  .string()
  .max(64)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  );
const evidenceId = z
  .string()
  .regex(
    /^profile-evidence:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
const evidenceRefs = z.array(evidenceId).min(1).max(8);
const category = z.enum([
  'role',
  'capability',
  'qualification',
  'licence',
  'clearance',
  'registration',
  'eligibility',
  'geography',
  'sector',
]);
const hasUriScheme = (value: string) =>
  /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value);

export const ProfileTermRefSchema = z
  .object({
    kind: category,
    packId: token,
    packVersion: semver,
    termId: token,
  })
  .strict();
export type ProfileTermRef = z.infer<typeof ProfileTermRefSchema>;

const terms = (kind: ProfileTermRef['kind']) =>
  z.array(ProfileTermRefSchema.extend({ kind: z.literal(kind) })).max(32);
const primitiveNumber = z.number().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const termPreference = z.discriminatedUnion('dimension', [
  z
    .object({
      kind: z.literal('term'),
      dimension: z.literal('role'),
      value: ProfileTermRefSchema.extend({ kind: z.literal('role') }),
      desired: z.boolean(),
      explicit: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal('term'),
      dimension: z.literal('location'),
      value: ProfileTermRefSchema.extend({ kind: z.literal('geography') }),
      desired: z.boolean(),
      explicit: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal('term'),
      dimension: z.literal('sector'),
      value: ProfileTermRefSchema.extend({ kind: z.literal('sector') }),
      desired: z.boolean(),
      explicit: z.literal(true),
    })
    .strict(),
]);
const preferenceInput = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('work_mode'),
      value: z.enum(['onsite', 'hybrid', 'remote']),
      desired: z.boolean(),
      explicit: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal('employment_type'),
      value: z.enum(['full_time', 'part_time', 'casual', 'contract', 'temporary', 'internship']),
      desired: z.boolean(),
      explicit: z.literal(true),
    })
    .strict(),
  termPreference,
  z
    .object({
      kind: z.literal('minimum_compensation'),
      amount: primitiveNumber.min(0).max(1_000_000_000),
      currency: z.string().regex(/^[A-Z]{3}$/u),
      period: z.enum(['hour', 'day', 'week', 'year']),
      explicit: z.literal(true),
    })
    .strict(),
]);
export const ProfilePreferenceInputSchema = preferenceInput;
export type ProfilePreferenceInput = z.infer<typeof preferenceInput>;

const preference = z.union([
  z
    .object({
      kind: z.literal('work_mode'),
      value: z.enum(['onsite', 'hybrid', 'remote']),
      desired: z.boolean(),
      explicit: z.literal(true),
      evidenceRefs,
    })
    .strict(),
  z
    .object({
      kind: z.literal('employment_type'),
      value: z.enum(['full_time', 'part_time', 'casual', 'contract', 'temporary', 'internship']),
      desired: z.boolean(),
      explicit: z.literal(true),
      evidenceRefs,
    })
    .strict(),
  z
    .object({
      kind: z.literal('term'),
      dimension: z.literal('role'),
      value: ProfileTermRefSchema.extend({ kind: z.literal('role') }),
      desired: z.boolean(),
      explicit: z.literal(true),
      evidenceRefs,
    })
    .strict(),
  z
    .object({
      kind: z.literal('term'),
      dimension: z.literal('location'),
      value: ProfileTermRefSchema.extend({ kind: z.literal('geography') }),
      desired: z.boolean(),
      explicit: z.literal(true),
      evidenceRefs,
    })
    .strict(),
  z
    .object({
      kind: z.literal('term'),
      dimension: z.literal('sector'),
      value: ProfileTermRefSchema.extend({ kind: z.literal('sector') }),
      desired: z.boolean(),
      explicit: z.literal(true),
      evidenceRefs,
    })
    .strict(),
  z
    .object({
      kind: z.literal('minimum_compensation'),
      amount: primitiveNumber.min(0).max(1_000_000_000),
      currency: z.string().regex(/^[A-Z]{3}$/u),
      period: z.enum(['hour', 'day', 'week', 'year']),
      explicit: z.literal(true),
      evidenceRefs,
    })
    .strict(),
]);
export const ProfilePreferenceSchema = z.union([
  z
    .object({
      kind: z.literal('work_mode'),
      value: z.enum(['onsite', 'hybrid', 'remote']),
      desired: z.boolean(),
      explicit: z.literal(true),
      evidenceRefs,
    })
    .strict(),
  z
    .object({
      kind: z.literal('employment_type'),
      value: z.enum(['full_time', 'part_time', 'casual', 'contract', 'temporary', 'internship']),
      desired: z.boolean(),
      explicit: z.literal(true),
      evidenceRefs,
    })
    .strict(),
  z
    .object({
      kind: z.literal('term'),
      dimension: z.literal('role'),
      value: ProfileTermRefSchema.extend({ kind: z.literal('role') }),
      desired: z.boolean(),
      explicit: z.literal(true),
      evidenceRefs,
    })
    .strict(),
  z
    .object({
      kind: z.literal('term'),
      dimension: z.literal('location'),
      value: ProfileTermRefSchema.extend({ kind: z.literal('geography') }),
      desired: z.boolean(),
      explicit: z.literal(true),
      evidenceRefs,
    })
    .strict(),
  z
    .object({
      kind: z.literal('term'),
      dimension: z.literal('sector'),
      value: ProfileTermRefSchema.extend({ kind: z.literal('sector') }),
      desired: z.boolean(),
      explicit: z.literal(true),
      evidenceRefs,
    })
    .strict(),
  z
    .object({
      kind: z.literal('minimum_compensation'),
      amount: primitiveNumber.min(0).max(1_000_000_000),
      currency: z.string().regex(/^[A-Z]{3}$/u),
      period: z.enum(['hour', 'day', 'week', 'year']),
      explicit: z.literal(true),
      evidenceRefs,
    })
    .strict(),
]);
export type ProfilePreference = z.infer<typeof preference>;

const input = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('inline_text'),
      text: z
        .string()
        .trim()
        .min(1)
        .max(4096)
        .refine(
          (v) => !(/^[A-Za-z][A-Za-z0-9+.-]*:\S*$/u.test(v) && !/^[A-Za-z]:[\\/]/.test(v)),
          'URI ingestion is not supported',
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal('structured_profile'),
      profile: z
        .object({
          roleHints: terms('role').optional(),
          capabilities: terms('capability').optional(),
          qualifications: terms('qualification').optional(),
          licences: terms('licence').optional(),
          clearances: terms('clearance').optional(),
          registrations: terms('registration').optional(),
          preferences: z.array(preferenceInput).max(32).optional(),
          requestedEligibility: terms('eligibility').optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('trusted_root_file'),
      path: z
        .string()
        .trim()
        .min(1)
        .max(512)
        .refine((v) => !hasUriScheme(v), 'URI ingestion is not supported'),
      contentType: z.enum(['text/plain', 'text/markdown', 'text/csv', 'application/json']),
      sizeBytes: z.number().int().positive().max(1_048_576),
    })
    .strict(),
]);
export const ProfileInputSchema = input;
export type ProfileInput = z.infer<typeof input>;
export type StructuredProfile = Extract<ProfileInput, { kind: 'structured_profile' }>['profile'];

const fact = z
  .object({
    term: ProfileTermRefSchema,
    origin: z.literal('user_supplied'),
    dataClass: z.literal('job_fact'),
    evidenceRefs,
  })
  .strict();
const facts = (kind: ProfileTermRef['kind']) =>
  z.array(fact.extend({ term: ProfileTermRefSchema.extend({ kind: z.literal(kind) }) })).max(32);
export const ProfileFactSchema = fact;
export type ProfileFact = z.infer<typeof fact>;
const observed = fact.extend({ origin: z.literal('observed') });
export const ObservedCandidateFactSchema = observed;
export type ObservedCandidateFact = z.infer<typeof observed>;

export const MinimizedProfileDraftSchema = z
  .object({
    roleHints: facts('role'),
    capabilities: facts('capability'),
    qualifications: facts('qualification'),
    licences: facts('licence'),
    clearances: facts('clearance'),
    registrations: facts('registration'),
    preferences: z.array(preference).max(32),
    observedCandidateFacts: z.array(observed).max(32),
    requestedEligibility: facts('eligibility'),
    evidenceRefs,
  })
  .strict();
export type MinimizedProfileDraft = z.infer<typeof MinimizedProfileDraftSchema>;

export const ProfileRequestEvidenceSchema = z
  .object({
    evidenceId,
    kind: z.literal('user_statement'),
    scope: z.literal('request'),
    retention: z.literal('ephemeral'),
    rawRetained: z.literal(false),
  })
  .strict();
export type ProfileRequestEvidence = z.infer<typeof ProfileRequestEvidenceSchema>;
const warning = z.string().min(1).max(64);
const minimizedResult = z
  .object({
    status: z.literal('minimized'),
    draft: MinimizedProfileDraftSchema,
    evidence: z.array(ProfileRequestEvidenceSchema).min(1).max(1),
    warnings: z.tuple([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set(value.evidence.map((entry) => entry.evidenceId));
    const check = (candidate: unknown, path: (string | number)[]) => {
      if (!candidate || typeof candidate !== 'object') return;
      for (const [key, child] of Object.entries(candidate)) {
        if (key === 'evidenceRefs' && Array.isArray(child)) {
          child.forEach((id, index) => {
            if (typeof id !== 'string' || !ids.has(id))
              ctx.addIssue({
                code: 'custom',
                path: [...path, key, index],
                message: 'evidence reference must exist',
              });
          });
        } else check(child, [...path, key]);
      }
    };
    check(value.draft, ['draft']);
  });
export const ProfileMinimizationResultSchema = z.discriminatedUnion('status', [
  minimizedResult,
  z
    .object({
      status: z.literal('requires_extractor'),
      inputKind: z.enum(['inline_text', 'trusted_root_file']),
      code: z.literal('VETTED_EXTRACTOR_REQUIRED'),
      rawRetained: z.literal(false),
      warnings: z.tuple([z.literal('free_text_extraction_unavailable')]),
    })
    .strict(),
  z
    .object({
      status: z.literal('rejected'),
      code: z.enum(['INVALID_PROFILE_INPUT', 'UNAPPROVED_PROFILE_TERM']),
      warnings: z.array(warning).min(1).max(4),
    })
    .strict(),
]);
export type ProfileMinimizationResult = z.infer<typeof ProfileMinimizationResultSchema>;

const capability = z.discriminatedUnion('inputKind', [
  z
    .object({
      inputKind: z.literal('structured_profile'),
      ingestion: z.literal('supported'),
      minimization: z.literal('supported'),
    })
    .strict(),
  z
    .object({
      inputKind: z.literal('inline_text'),
      ingestion: z.literal('supported'),
      minimization: z.literal('requires_vetted_extractor'),
    })
    .strict(),
  z
    .object({
      inputKind: z.literal('trusted_root_file'),
      ingestion: z.literal('supported'),
      minimization: z.literal('requires_vetted_extractor'),
    })
    .strict(),
]);
export const ProfileCapabilityReportSchema = z
  .object({
    capabilities: z
      .array(capability)
      .length(3)
      .superRefine((items, ctx) => {
        if (new Set(items.map((item) => item.inputKind)).size !== 3)
          ctx.addIssue({ code: 'custom', message: 'one capability per input kind required' });
      }),
    zeroPersistence: z.literal(true),
    reusableHandle: z.literal(false),
    binaryFiles: z.literal(false),
    urlIngestion: z.literal(false),
  })
  .strict();
export type ProfileCapabilityReport = z.infer<typeof ProfileCapabilityReportSchema>;
export const ProfileCapabilitiesSchema = ProfileCapabilityReportSchema;
export const ProfileDraftSchema = MinimizedProfileDraftSchema;
