const PLACEHOLDER_PATTERNS = [
  /^loading\.?\.?\.?$/i,
  /^please wait$/i,
  /^just a moment$/i,
  /^enable javascript$/i,
  /^you need to enable javascript$/i,
  /^this page requires javascript$/i,
  /^loading content$/i,
];

const MIN_MEANINGFUL_CHARS = 40;

export interface MarkdownQualityAssessment {
  meaningful: boolean;
  reasons: string[];
}

export function assessMarkdownQuality(markdown: string): MarkdownQualityAssessment {
  const normalized = markdown.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    return { meaningful: false, reasons: ['empty content'] };
  }

  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { meaningful: false, reasons: ['placeholder content'] };
  }

  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const hasMarkdownStructure = /(^|\n)#{1,6}\s|(^|\n)(?:[-*+]\s|\d+\.\s)|\|.*\|/m.test(markdown);
  if (normalized.length < MIN_MEANINGFUL_CHARS && !hasMarkdownStructure) {
    return {
      meaningful: false,
      reasons: [
        `too little content (${String(normalized.length)} chars, ${String(wordCount)} words)`,
      ],
    };
  }

  return { meaningful: true, reasons: [] };
}

export function assessMarkdownBatchQuality(markdowns: string[]): MarkdownQualityAssessment {
  const nonEmpty = markdowns.filter((markdown) => markdown.trim().length > 0);
  if (nonEmpty.length === 0) {
    return { meaningful: false, reasons: ['no successful markdown content'] };
  }

  const assessments = nonEmpty.map((markdown) => assessMarkdownQuality(markdown));
  const meaningful = assessments.some((assessment) => assessment.meaningful);
  const reasons = assessments.flatMap((assessment) => assessment.reasons);

  return meaningful
    ? { meaningful: true, reasons: [] }
    : {
        meaningful: false,
        reasons: reasons.length > 0 ? reasons : ['no meaningful content detected'],
      };
}
