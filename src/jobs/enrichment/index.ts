export const ENRICHMENT_CONTRACT_VERSION = '1.0.0' as const;

export { EnrichmentError, type EnrichmentErrorCode } from './errors.js';

export {
  deterministicEnrichmentId,
  ENRICHMENT_ID_MAX_PARTS,
  ENRICHMENT_ID_MAX_PREIMAGE_BYTES,
  type EnrichmentArtifactKind,
} from './ids.js';

export {
  EnrichmentRequestSchema,
  EnrichmentResultSchema,
  EnrichmentStatusSchema,
  EnrichmentWarningSchema,
  ExtractedFieldSnapshotSchema,
  VerifiedEmployerRecordSchema,
  VerifiedEmployerCatalogSchema,
  EnrichmentBudgetSchema,
  QualitySignalSchema,
  SalaryNormalizationResultSchema,
  ClassificationMappingResultSchema,
  type EnrichmentRequest,
  type EnrichmentResult,
  type EnrichmentStatus,
  type EnrichmentWarning,
  type ExtractedFieldSnapshot,
  type VerifiedEmployerRecord,
  type VerifiedEmployerCatalog,
  type EnrichmentBudget,
  type QualitySignal,
} from './contracts.js';

export { enrichKnowledge } from './pipeline.js';
export { enrichListing } from './listing.js';
export { interpretAttachments } from './attachment.js';
export { interpretFramework } from './framework.js';
export { enrichEmployer } from './employer.js';
export { normalizeSalary } from './salary.js';
export { mapClassification } from './classification.js';
export { deriveQualitySignals } from './quality.js';
