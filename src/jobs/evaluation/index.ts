export { canonicalJson, sha256Hex, computeManifestHash } from './hashes.js';
export { freezeCorpus, loadFrozenCorpus, verifyManifest, assertNoLeakage } from './corpus.js';
export {
  precisionAtK,
  recallAtK,
  ndcgAtK,
  fixedBudgetRecall,
  pairwiseAccuracy,
  evaluateQuery,
  evaluateSuite,
} from './metrics.js';
export { evaluateQualityGates } from './gates.js';
export type {
  EVALUATION_CONTRACT_VERSION,
  EvalSuiteId,
  CorpusStatus,
  LabelKind,
  GradedRelevance,
  FrozenDocument,
  BinaryLabel,
  GradedLabel,
  PairwiseLabel,
  EvalLabel,
  EvalQuery,
  EvalManifestRevisions,
  EvalManifest,
  FrozenCorpus,
  RankedItem,
  QueryMetrics,
  SuiteMetrics,
  GateSeverity,
  GateFinding,
  CheckpointEvidence,
  QualityGateReport,
  Sha256Hex,
  Instant,
} from './types.js';
