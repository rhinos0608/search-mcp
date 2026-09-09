export * from './ids.js';
export * from './contracts.js';

// Preserve existing source-policy exports.
export { SourcePolicyRegistry } from './policy/index.js';
export {
  SOURCE_POLICY_VERSION,
  decideSourcePolicy,
  isPolicyPermitted,
  runIfPermitted,
  type PolicyDecision,
  type SourcePolicy,
  type SourcePolicyMode,
  type SourcePolicyState,
} from './policy/index.js';

export {
  PolicyEdgeRequestSchema,
  ResolvePolicyEdgeOptionsSchema,
  resolveExecutionPolicyEdge,
  resolveInformationalPolicyEdge,
  executeIfPolicyPermitted,
  caveatsForInformationalEdges,
  type PolicyEdgeRequest,
  type ResolvePolicyEdgeOptions,
  type PolicyExecutionResult,
} from './policy/index.js';

export {
  ADAPTER_CAPABILITY_CONTRACT_VERSION,
  AdapterCapabilitySchema,
  AdapterEdgeCapabilitySchema,
  type AdapterCapability,
  type AdapterEdgeCapability,
} from './adapterCapability.js';

export { AdapterCapabilityRegistry } from './adapterRegistry.js';

export {
  INDEXED_PROVIDER_ADAPTER_VERSION,
  runIndexedProvider,
  type IndexedProviderRequest,
  type IndexedProviderDeps,
  type IndexedProviderAdapterResult,
  type IndexedProviderPort,
  type IndexedSafeSearch,
  type IndexedSummaryMode,
} from './providers/indexed.js';

export {
  INDEXED_PROVIDER_DEFINITIONS,
  type IndexedProviderDefinition,
  createDefaultIndexedProviderPorts,
  indexedProviderCapabilities,
} from './providers/ports.js';

export {
  JOBSPY_ADAPTER_ID,
  JOBSPY_ADAPTER_VERSION,
  JOBSPY_BOARDS,
  type JobSpyBoard,
  DEFAULT_JOBSPY_BOARDS,
  JOBSPY_CAPABILITY,
  runJobSpyBoard,
  type JobSpyBoardRequest,
  type JobSpyAdapterDeps,
  type JobSpyScrapeResult,
} from './adapters/jobspy.js';

export {
  MANUAL_IMPORT_ADAPTER_ID,
  MANUAL_IMPORT_ADAPTER_VERSION,
  ManualImportRequestSchema,
  ManualImportResultSchema,
  type ManualImportContent,
  type ManualImportRequest,
  type ManualImportResult,
  runManualImport,
} from './adapters/manualImport.js';

// DestinationFetch enrichment (W3-H, explicit additive re-exports).
export {
  DESTINATION_FETCH_ENRICHMENT_VERSION,
  DESTINATION_FETCH_ADAPTER_ID,
  DESTINATION_FETCH_CAPABILITY,
  DestinationFetchEnrichmentOptionsSchema,
  DestinationFetchEnrichmentResultSchema,
  enrichDestinationFetches,
  type DestinationFetchEnrichmentOptions,
  type DestinationFetchEnrichmentDeps,
  type DestinationFetchEnrichmentResult,
  type DestinationFetchCandidateStatus,
  type DestinationFetchAttempt,
  type DestinationFetchBudgetConsumed,
} from './destinationFetch.js';

// Coordinator public envelope schemas/types (W3-G, explicit additive re-exports).
export {
  ACQUISITION_COORDINATOR_VERSION,
  runAcquisition,
  AcquisitionRunBudgetSchema,
  AcquisitionRunOptionsSchema,
  AcquisitionRunStatusSchema,
  AcquisitionSkippedSliceSchema,
  AcquisitionDestinationFetchReviewSchema,
  AcquisitionDuplicateGroupSchema,
  AcquisitionRunResultSchema,
  IndexedSlicePlanItemSchema,
  JobSpySlicePlanItemSchema,
  ManualSlicePlanItemSchema,
  AcquisitionSlicePlanItemSchema,
  type AcquisitionRunBudget,
  type AcquisitionRunOptions,
  type AcquisitionRunDeps,
  type AcquisitionRunStatus,
  type AcquisitionSkippedSlice,
  type AcquisitionDestinationFetchReview,
  type AcquisitionDuplicateGroup,
  type AcquisitionRunResult,
  type IndexedSlicePlanItem,
  type JobSpySlicePlanItem,
  type ManualSlicePlanItem,
  type AcquisitionSlicePlanItem,
} from './coordinator.js';

// W4 source-class architecture.
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
} from './sourceClass/index.js';

export { sourceEvidenceId, sourcePolicyRevision, atsTenantSourceId } from './sourceClass/index.js';

export { rungTemplateDefault, applyModeOverrides } from './sourceClass/index.js';

export { SourceClassRegistry } from './sourceClass/index.js';

export {
  SEEK_SOURCE_ID,
  buildSeekEntry,
  buildSeekManualEntry,
  buildSeekAuthorizedUserBindings,
  informationalSeekEdgesFromEntry,
} from './sourceClass/index.js';
export { SEEK_DESTINATION_CLASS, supportsIndexedDomainFilter } from './destinationClass.js';

export { AtsTenantRegistry } from './sourceClass/index.js';

export { destinationFetchCapabilities } from './sourceClass/index.js';
