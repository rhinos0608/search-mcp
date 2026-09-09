/**
 * W4 source-class schemas.
 *
 * Evidence, authorization, ladder rungs, registry entries, and edge policies
 * for the source-class architecture. All schemas strict, bounded, unique-array
 * checked. Evidence never contains copied terms, robots body, raw response,
 * credentials, or free-form notes.
 */
import { z } from 'zod/v4';

export const SOURCE_CLASS_CONTRACT_VERSION = '1.0.0' as const;

// ---------------------------------------------------------------------------
// Ladder rungs
// ---------------------------------------------------------------------------

export const LadderRungSchema = z.enum([
  'indexed_discovery',
  'public_direct_retrieval',
  'registered_adapter',
  'authenticated_access',
]);
export type LadderRung = z.infer<typeof LadderRungSchema>;

// ---------------------------------------------------------------------------
// External access status
// ---------------------------------------------------------------------------

export const ExternalAccessStatusSchema = z.enum([
  'public',
  'indexed_only',
  'authenticated',
  'contractually_restricted',
  'technically_blocked',
  'unknown',
]);
export type ExternalAccessStatus = z.infer<typeof ExternalAccessStatusSchema>;

// ---------------------------------------------------------------------------
// Authorization evidence
// ---------------------------------------------------------------------------

export const AuthorizationEvidenceKindSchema = z.enum([
  'robots_metadata',
  'published_access_terms',
  'observed_access_requirement',
  'capability_classification',
]);
export type AuthorizationEvidenceKind = z.infer<typeof AuthorizationEvidenceKindSchema>;

const sha256Ref = z
  .string()
  .max(256)
  .regex(/^sha256:[0-9a-f]{64}$/u, 'must be sha256:hex');

export const AuthorizationEvidenceSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    evidenceId: z.string().min(1).max(256).brand<'SourceEvidenceId'>(),
    sourceId: z.string().min(1).max(256),
    kind: AuthorizationEvidenceKindSchema,
    capturedAt: z.iso.datetime({ offset: true }),
    citationRef: z.string().max(2048).optional(),
    contentHash: sha256Ref.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.citationRef && !v.contentHash) {
      ctx.addIssue({
        code: 'custom',
        message: 'authorization evidence requires citationRef or contentHash',
      });
    }
  });
export type AuthorizationEvidence = z.infer<typeof AuthorizationEvidenceSchema>;
export type SourceEvidenceId = AuthorizationEvidence['evidenceId'];

// ---------------------------------------------------------------------------
// Local authorization
// ---------------------------------------------------------------------------

export const LocalAuthorizationSchema = z
  .object({
    enabledAdapterIds: z.array(z.string().min(1).max(256)).max(32),
    credentialRefs: z.array(z.string().min(1).max(256)).max(32),
    destinationFetchEnabled: z.boolean(),
    riskyModesEnabled: z.array(z.enum(['automatedSearch', 'automatedFetch', 'employerApi'])).max(8),
  })
  .strict();
export type LocalAuthorization = z.infer<typeof LocalAuthorizationSchema>;

// ---------------------------------------------------------------------------
// Execution binding
// ---------------------------------------------------------------------------

export const SourceExecutionBindingSchema = z
  .object({
    rung: LadderRungSchema,
    actor: z
      .object({
        kind: z.enum(['provider', 'adapter', 'user', 'system']),
        namespace: z.string().min(1).max(128),
        id: z.string().min(1).max(256),
      })
      .strict(),
    adapterId: z.string().min(1).max(256),
    operation: z.enum([
      'automatedSearch',
      'automatedFetch',
      'userSuppliedContent',
      'manualImport',
      'employerApi',
    ]),
    route: z.enum(['direct', 'indexed', 'user_supplied']),
    stateOverride: z
      .enum(['blocked', 'requires_configuration', 'requires_review', 'not_supported'])
      .optional(),
  })
  .strict();
export type SourceExecutionBinding = z.infer<typeof SourceExecutionBindingSchema>;

// ---------------------------------------------------------------------------
// Source registry entry
// ---------------------------------------------------------------------------

export const SourceRegistryEntrySchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    sourceId: z.string().min(1).max(256),
    targetKind: z.enum(['discovery_provider', 'publisher', 'board', 'adapter', 'ats_tenant']),
    normalizedHost: z.string().max(253).optional(),
    rungs: z.array(LadderRungSchema).min(1).max(8),
    bindings: z.array(SourceExecutionBindingSchema).max(32),
    externalAccessStatus: ExternalAccessStatusSchema,
    localAuthorization: LocalAuthorizationSchema,
    evidenceRefs: z.array(z.string().min(1).max(256)).max(100),
    reviewedAt: z.iso.datetime({ offset: true }),
    modeOverrides: z
      .partialRecord(
        z.enum([
          'automatedSearch',
          'automatedFetch',
          'userSuppliedContent',
          'manualImport',
          'employerApi',
        ]),
        z.enum(['blocked', 'requires_configuration', 'requires_review', 'not_supported']),
      )
      .optional(),
  })
  .strict();
export type SourceRegistryEntry = z.infer<typeof SourceRegistryEntrySchema>;

// ---------------------------------------------------------------------------
// Materialization context
// ---------------------------------------------------------------------------

export interface SourceMaterializationContext {
  capabilityRegistry: {
    supports(
      adapterId: string,
      edge: { operation: string; route: string; targetKind: string },
    ): boolean;
  };
  availableCredentialRefs: ReadonlySet<string>;
  destinationFetchEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Edge policy (materialized per 7-tuple)
// ---------------------------------------------------------------------------

export const SourceEdgePolicySchema = z
  .object({
    sourceId: z.string().min(1).max(256),
    targetKind: z.enum(['discovery_provider', 'publisher', 'board', 'adapter', 'ats_tenant']),
    actor: z
      .object({
        kind: z.enum(['provider', 'adapter', 'user', 'system']),
        namespace: z.string().min(1).max(128),
        id: z.string().min(1).max(256),
      })
      .strict(),
    operation: z.enum([
      'automatedSearch',
      'automatedFetch',
      'userSuppliedContent',
      'manualImport',
      'employerApi',
    ]),
    route: z.enum(['direct', 'indexed', 'user_supplied']),
    state: z.enum([
      'permitted',
      'blocked',
      'requires_configuration',
      'requires_review',
      'not_supported',
    ]),
    revision: z.string().min(1).max(256),
    evidenceRefs: z.array(z.string().min(1).max(256)).max(100),
    reviewedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type SourceEdgePolicy = z.infer<typeof SourceEdgePolicySchema>;

// ---------------------------------------------------------------------------
// ATS tenant config
// ---------------------------------------------------------------------------

export const AtsTenantConfigSchema = z
  .object({
    sourceId: z.string().min(1).max(256),
    platform: z.enum([
      'workday',
      'greenhouse',
      'lever',
      'ashby',
      'smartrecruiters',
      'workable',
      'pageup',
      'generic',
    ]),
    displayName: z.string().min(1).max(256),
    hosts: z.array(z.string().min(1).max(253)).min(1).max(32),
    enabled: z.boolean(),
    enabledAdapterIds: z.array(z.string().min(1).max(256)).max(32),
    credentialRef: z.string().max(256).optional(),
    evidenceRefs: z.array(z.string().min(1).max(256)).max(100),
    reviewedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type AtsTenantConfig = z.infer<typeof AtsTenantConfigSchema>;

// ---------------------------------------------------------------------------
// Jobs acquisition config
// ---------------------------------------------------------------------------

export const JobsAcquisitionConfigSchema = z
  .object({
    destinationFetchEnabled: z.boolean(),
    atsTenants: z.array(AtsTenantConfigSchema).max(64),
    /** Operator-listed JobSpy boards. Load-time default (when env and file config are unset) is all boards — TEMPORARY local default, revert to strict opt-in before public release. Unknown names are dropped with a warning at load time. Explicit empty list opts out. */
    jobspyBoards: z.array(z.string().min(1).max(64)).max(16).default([]),
    /** Whether JobSpy record descriptions are fetched (cost; keep false unless operator explicitly opts in). */
    jobspyFetchDescription: z.boolean().default(false),
  })
  .strict();
export type JobsAcquisitionConfig = z.infer<typeof JobsAcquisitionConfigSchema>;

export const DEFAULT_JOBS_ACQUISITION_CONFIG: Readonly<JobsAcquisitionConfig> = Object.freeze({
  destinationFetchEnabled: false,
  atsTenants: [],
  jobspyBoards: [],
  jobspyFetchDescription: false,
});
