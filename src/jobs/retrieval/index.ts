// ---------------------------------------------------------------------------
// W8 Retrieval — barrel exports
// ---------------------------------------------------------------------------

export {
  RETRIEVAL_CONTRACT_VERSION,
  LEXICAL_TRANSFORM_VERSION,
  RetrievalChannelIdSchema,
  RetrievalChannelWeightsSchema,
  CandidateRetrievalMetadataSchema,
  RetrievalResultSchema,
  DEFAULT_RETRIEVAL_WEIGHTS,
  DEFAULT_TEXT_FIELD_WEIGHTS,
} from './contracts.js';

export type {
  RetrievalChannelId,
  RetrievalChannelWeights,
  ChannelScoreEntry,
  ChannelResult,
  CandidateRetrievalMetadata,
  RetrievalResult,
  TextFieldWeight,
  RrfConfig,
} from './contracts.js';

export { lexicalTokenize, mergeTokenLists } from './lexical.js';
export { weightedRrfFuse } from './rrf.js';
export type { RrfFusedEntry } from './rrf.js';
export { runRetrieval } from './pipeline.js';
export type { RetrievalPipelineInput } from './pipeline.js';

// Channel scorers
export { scoreTextBm25 } from './channels/textBm25.js';
export type { TextBm25PostingLike } from './channels/textBm25.js';
export { scoreRoleFamily } from './channels/roleFamily.js';
export { scoreCapabilityOverlap } from './channels/capabilityOverlap.js';
export { scoreGeography } from './channels/geography.js';
export { scoreSemantic } from './channels/semantic.js';
