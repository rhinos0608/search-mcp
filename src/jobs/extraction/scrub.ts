import { scrubContent, type ScrubResult } from '../../utils/contentScrubber.js';
import type { ExtractionScrubSummary } from './contracts.js';

/**
 * Scrub a text payload and return the cleaned content plus summary.
 * W5 wrapper around `scrubContent` from contentScrubber.ts.
 */
export function extractScrub(raw: string): {
  content: string;
  scrubSummary: ExtractionScrubSummary;
} {
  const result: ScrubResult = scrubContent(raw);
  return {
    content: result.content,
    scrubSummary: {
      clean: result.clean,
      redactions: result.redactions,
      riskScore: result.riskScore,
      threatTypes: result.threats.map((t) => t.type),
    },
  };
}
