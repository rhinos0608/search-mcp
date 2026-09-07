import type { Requirement } from '../domain/posting.js';
import type { ExtractionPackContext, ExtractedRequirement } from './contracts.js';

/**
 * Interpret extracted requirements through pack terminology.
 * Output length ≤ input length. No new rawText.
 */
export function interpretRequirements(
  requirements: readonly ExtractedRequirement[],
  packs: ExtractionPackContext,
): readonly Requirement[] {
  if (!packs.domain && !packs.locale) {
    // Empty packs: identity transform aside from schema parse
    return requirements.map(extractedToRequirement);
  }

  return requirements.map((req) => {
    let result = extractedToRequirement(req);
    let provenanceChanged = false;

    // Domain pack: requirementTerminology mapping
    const domain = packs.domain;
    if (domain) {
      const terminology = domain.requirementTerminology;
      const normalized = req.rawText.trim().toLowerCase();
      // Check exact key match or contained token
      for (const [key, mappedCategory] of Object.entries(terminology)) {
        const keyLower = key.toLowerCase();
        if (normalized === keyLower || normalized.includes(keyLower)) {
          result = { ...result, category: mappedCategory as Requirement['category'] };
          provenanceChanged = true;
          break;
        }
      }
    }

    if (provenanceChanged && domain) {
      result = {
        ...result,
        interpretationProvenance: `pack:domain:${domain.id}:${domain.version}:terminology`,
      };
    }

    return result;
  });
}

function extractedToRequirement(req: ExtractedRequirement): Requirement {
  return {
    rawText: req.rawText,
    category: req.category,
    force: req.force,
    semanticCapability: req.semanticCapability,
    years: req.years,
    qualification: req.qualification,
    licence: req.licence,
    clearance: req.clearance,
    registration: req.registration,
    evidenceRefs: req.evidenceRefs as Requirement['evidenceRefs'],
    confidence: req.confidence,
    interpretationProvenance: req.interpretationProvenance,
  };
}
