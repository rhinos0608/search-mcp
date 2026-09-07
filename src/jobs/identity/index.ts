export {
  IDENTITY_CONTRACT_VERSION,
  IDENTITY_RESOLVER_VERSION,
  IdentityFeatureNameSchema,
} from './contracts.js';
export type {
  IdentityFeatureName,
  IdentitySubject,
  IdentityFeatureVector,
  PairScore,
  IdentityClusterId,
  IdentityCluster,
} from './contracts.js';
export { extractIdentityFeatures } from './features.js';
export { scoreIdentityPair } from './score.js';
export {
  proposeIdentityDecision,
  clusterFromActiveDecisions,
  supersedeDecision,
  mergeSubjects,
  splitSubjects,
  activeDecisions,
  decisionLineage,
} from './resolve.js';
