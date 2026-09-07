// ---------------------------------------------------------------------------
// W9 Assessment — barrel exports
// ---------------------------------------------------------------------------

export {
  ASSESSMENT_CONTRACT_VERSION,
  ScoreGroupSchema,
  SCORE_GROUPS,
  DEFAULT_GROUP_WEIGHTS,
  ComponentScoreSchema,
  AssessmentGroupSchema,
  EligibilityStatusSchema,
  EligibilityGateSchema,
  EligibilityVerdictSchema,
  PersonalAdaptationDeltaSchema,
  CandidateAssessmentSchema,
  AssessmentResultSchema,
  GroupWeightsSchema,
  W11_DELTA_RANGE,
} from './contracts.js';

export type {
  ScoreGroup,
  ComponentScore,
  AssessmentGroup,
  EligibilityStatus,
  EligibilityGate,
  EligibilityVerdict,
  PersonalAdaptationDelta,
  CandidateAssessment,
  AssessmentResult,
  GroupWeights,
} from './contracts.js';

export { assessCandidate, computeUtilityScore, processPersonalAdaptationDelta } from './scorer.js';
export type { AssessmentInput } from './scorer.js';
