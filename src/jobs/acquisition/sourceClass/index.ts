/**
 * W4 source-class barrel exports.
 */
export {
  SOURCE_CLASS_CONTRACT_VERSION,
  LadderRungSchema,
  ExternalAccessStatusSchema,
  AuthorizationEvidenceKindSchema,
  AuthorizationEvidenceSchema,
  LocalAuthorizationSchema,
  SourceExecutionBindingSchema,
  SourceRegistryEntrySchema,
  SourceEdgePolicySchema,
  AtsTenantConfigSchema,
  JobsAcquisitionConfigSchema,
  DEFAULT_JOBS_ACQUISITION_CONFIG,
  type LadderRung,
  type ExternalAccessStatus,
  type AuthorizationEvidenceKind,
  type AuthorizationEvidence,
  type SourceEvidenceId,
  type LocalAuthorization,
  type SourceExecutionBinding,
  type SourceRegistryEntry,
  type SourceMaterializationContext,
  type SourceEdgePolicy,
  type AtsTenantConfig,
  type JobsAcquisitionConfig,
} from './contracts.js';

export { sourceEvidenceId, sourcePolicyRevision, atsTenantSourceId } from './ids.js';

export { rungTemplateDefault, applyModeOverrides } from './templates.js';

export { SourceClassRegistry } from './registry.js';

export {
  SEEK_SOURCE_ID,
  buildSeekEntry,
  buildSeekManualEntry,
  buildSeekAuthorizedUserBindings,
  informationalSeekEdgesFromEntry,
} from './seek.js';

export { AtsTenantRegistry } from './atsTenants.js';

export { destinationFetchCapabilities } from './destinationFetchFlag.js';
