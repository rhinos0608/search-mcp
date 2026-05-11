/**
 * Quality assessment for crawled markdown content.
 *
 * This module re-exports from the comprehensive markdownQuality module.
 * Kept for backward compatibility — all new code should import directly
 * from './markdownQuality.js'.
 *
 * @deprecated Import from './markdownQuality.js' for full API access.
 */

export {
  assessMarkdownQuality,
  assessMarkdownBatchQuality,
  compareQuality,
} from './markdownQuality.js';

export type {
  MarkdownQualityAssessment,
  QualityClassification,
  QualitySignal,
  QualityScore,
  RecoveryRecommendation,
  PlatformHintResult,
  BoilerplateFamily,
  PlatformHint,
  AssessmentContext,
  QualityComparison,
} from './markdownQuality.js';
