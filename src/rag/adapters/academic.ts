import type { RawDocument, RagChunk } from '../types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AcademicChunk extends RagChunk {
  paperId: string;
  title: string;
  authors: string[];
  abstract: string;
  section:
    | 'abstract'
    | 'introduction'
    | 'related'
    | 'method'
    | 'results'
    | 'discussion'
    | 'references';
  equations: string[];
  figures: string[];
  citations: string[];
  venue?: string;
  year?: number;
  doi?: string;
  arxivId?: string;
}

export interface AcademicAdapterOptions {
  includeAbstract?: boolean;
  includeFullText?: boolean;
  sectionChunkSize?: number;
  preserveEquations?: boolean;
  minSectionLength?: number;
}

export interface PaperMetadata {
  paperId: string;
  title: string;
  authors: string[];
  abstract: string;
  venue?: string;
  year?: number;
  doi?: string;
  arxivId?: string;
  url?: string;
}

// ── Section detection ────────────────────────────────────────────────────────

const SECTION_HEADERS: { type: AcademicChunk['section']; patterns: RegExp[] }[] = [
  {
    type: 'abstract',
    patterns: [/^\s*abstract\b/im, /^\s*summary\b/im],
  },
  {
    type: 'introduction',
    patterns: [/^\s*introduction\b/im, /^\s*1\.?\s+introduction\b/im],
  },
  {
    type: 'related',
    patterns: [
      /^\s*related\s+work\b/im,
      /^\s*background\b/im,
      /^\s*literature\s+review\b/im,
      /^\s*2\.?\s+related\s+work\b/im,
    ],
  },
  {
    type: 'method',
    patterns: [
      /^\s*method\b/im,
      /^\s*methods\b/im,
      /^\s*methodology\b/im,
      /^\s*approach\b/im,
      /^\s*3\.?\s+method\b/im,
    ],
  },
  {
    type: 'results',
    patterns: [
      /^\s*results\b/im,
      /^\s*experiments\b/im,
      /^\s*evaluation\b/im,
      /^\s*4\.?\s+results\b/im,
    ],
  },
  {
    type: 'discussion',
    patterns: [
      /^\s*discussion\b/im,
      /^\s*conclusion\b/im,
      /^\s*future\s+work\b/im,
      /^\s*5\.?\s+discussion\b/im,
    ],
  },
  {
    type: 'references',
    patterns: [/^\s*references\b/im, /^\s*bibliography\b/im, /^\s*acknowledgments\b/im],
  },
];

export function detectSections(paperContent: string): {
  type: AcademicChunk['section'];
  start: number;
  end: number;
  content: string;
}[] {
  const sections: {
    type: AcademicChunk['section'];
    start: number;
    end: number;
    content: string;
  }[] = [];
  const lines = paperContent.split('\n');
  let currentSection: { type: AcademicChunk['section']; startLine: number } | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;

    let detected: AcademicChunk['section'] | undefined;
    for (const section of SECTION_HEADERS) {
      if (section.patterns.some((p) => p.test(line))) {
        detected = section.type;
        break;
      }
    }

    if (detected) {
      if (currentSection) {
        sections.push({
          type: currentSection.type,
          start: currentSection.startLine,
          end: i,
          content: lines.slice(currentSection.startLine, i).join('\n').trim(),
        });
      }
      currentSection = { type: detected, startLine: i };
    }
  }

  if (currentSection) {
    sections.push({
      type: currentSection.type,
      start: currentSection.startLine,
      end: lines.length,
      content: lines.slice(currentSection.startLine).join('\n').trim(),
    });
  }

  return sections;
}

// ── Content extraction ─────────────────────────────────────────────────────

export function extractCitations(text: string): string[] {
  const citations: string[] = [];

  // Match [1], [2,3], [1-5] style citations
  const bracketRegex = /\[(\d+(?:[,\s-]+\d+)*)\]/g;
  let match;
  while ((match = bracketRegex.exec(text)) !== null) {
    const raw = match[1];
    if (raw) {
      citations.push(raw);
    }
  }

  // Match Author et al. (2023) style
  const etAlRegex = /([A-Z][a-z]+(?:\s+et\s+al\.?)?\s*\(\d{4}\))/g;
  let etMatch;
  while ((etMatch = etAlRegex.exec(text)) !== null) {
    citations.push(etMatch[0]);
  }

  return [...new Set(citations)];
}

export function extractEquations(text: string): string[] {
  const equations: string[] = [];

  // Match inline $...$ and display $$...$$
  const inlineRegex = /\$([^$]+)\$/g;
  let match;
  while ((match = inlineRegex.exec(text)) !== null) {
    const eq = match[1];
    if (eq && eq.trim().length > 2) {
      equations.push(eq.trim());
    }
  }

  // Match \begin{equation}...\end{equation}
  const envRegex = /\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/g;
  let envMatch;
  while ((envMatch = envRegex.exec(text)) !== null) {
    const eq = envMatch[1];
    if (eq) {
      equations.push(eq.trim());
    }
  }

  return equations;
}

export function extractFigures(text: string): string[] {
  const figures: string[] = [];

  // Match \begin{figure}...\end{figure}
  const envRegex = /\\begin\{figure\*?\}([\s\S]*?)\\end\{figure\*?\}/g;
  let envMatch;
  while ((envMatch = envRegex.exec(text)) !== null) {
    const fig = envMatch[1];
    if (fig) {
      figures.push(fig.trim());
    }
  }

  // Match "Figure 1: ..." or "Fig. 1 — ..." descriptions
  const descRegex = /(?:Figure|Fig\.)\s*\d+[.:]\s*(.+?)(?=\n\n|\n(?:Figure|Fig\.|Table|Tbl\.)|$)/gi;
  let descMatch;
  while ((descMatch = descRegex.exec(text)) !== null) {
    const desc = descMatch[1];
    if (desc) {
      figures.push(desc.trim());
    }
  }

  return figures;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createAcademicAdapter(options?: AcademicAdapterOptions): {
  type: 'academic';
  options: Required<AcademicAdapterOptions>;
  chunk: (docs: RawDocument[]) => AcademicChunk[];
  detectSections: (paperContent: string) => ReturnType<typeof detectSections>;
  extractCitations: (text: string) => string[];
  extractEquations: (text: string) => string[];
  extractFigures: (text: string) => string[];
  buildAbstractChunk: (paper: PaperMetadata) => AcademicChunk;
  buildSectionChunk: (
    paper: PaperMetadata,
    section: { type: string; content: string },
  ) => AcademicChunk[];
} {
  const opts: Required<AcademicAdapterOptions> = {
    includeAbstract: options?.includeAbstract ?? true,
    includeFullText: options?.includeFullText ?? true,
    sectionChunkSize: options?.sectionChunkSize ?? 400,
    preserveEquations: options?.preserveEquations ?? true,
    minSectionLength: options?.minSectionLength ?? 50,
  };

  return {
    type: 'academic',
    options: opts,
    detectSections,
    extractCitations,
    extractEquations,
    extractFigures,

    chunk: (docs: RawDocument[]): AcademicChunk[] => {
      const chunks: AcademicChunk[] = [];

      for (const doc of docs) {
        const meta = doc.metadata ?? {};
        const paper = meta.paper as PaperMetadata | undefined;
        if (!paper) continue;

        // Always include abstract chunk
        if (opts.includeAbstract && paper.abstract) {
          chunks.push({
            text: paper.abstract,
            url: doc.url,
            section: 'abstract',
            charOffset: 0,
            chunkIndex: chunks.length,
            totalChunks: 0,
            metadata: doc.metadata,
            paperId: paper.paperId,
            title: paper.title,
            authors: paper.authors,
            abstract: paper.abstract,
            equations: opts.preserveEquations ? extractEquations(paper.abstract) : [],
            figures: [],
            citations: extractCitations(paper.abstract),
            ...(paper.venue !== undefined ? { venue: paper.venue } : {}),
            ...(paper.year !== undefined ? { year: paper.year } : {}),
            ...(paper.doi !== undefined ? { doi: paper.doi } : {}),
            ...(paper.arxivId !== undefined ? { arxivId: paper.arxivId } : {}),
          });
        }

        // Full text sections
        if (opts.includeFullText && doc.text) {
          const sections = detectSections(doc.text);
          for (const section of sections) {
            if (section.content.length < opts.minSectionLength) continue;

            const sectionChunks = splitSection(section.content, opts.sectionChunkSize);
            for (const sub of sectionChunks) {
              if (!sub) continue;
              chunks.push({
                text: sub,
                url: doc.url,
                section: section.type,
                charOffset: 0,
                chunkIndex: chunks.length,
                totalChunks: 0,
                metadata: doc.metadata,
                paperId: paper.paperId,
                title: paper.title,
                authors: paper.authors,
                abstract: paper.abstract,
                equations: opts.preserveEquations ? extractEquations(sub) : [],
                figures: extractFigures(sub),
                citations: extractCitations(sub),
                ...(paper.venue !== undefined ? { venue: paper.venue } : {}),
                ...(paper.year !== undefined ? { year: paper.year } : {}),
                ...(paper.doi !== undefined ? { doi: paper.doi } : {}),
                ...(paper.arxivId !== undefined ? { arxivId: paper.arxivId } : {}),
              });
            }
          }
        }
      }

      for (const chunk of chunks) {
        chunk.totalChunks = chunks.length;
      }

      return chunks;
    },

    buildAbstractChunk: (paper: PaperMetadata): AcademicChunk => ({
      text: paper.abstract,
      url: paper.url ?? '',
      section: 'abstract',
      charOffset: 0,
      chunkIndex: 0,
      totalChunks: 1,
      paperId: paper.paperId,
      title: paper.title,
      authors: paper.authors,
      abstract: paper.abstract,
      equations: opts.preserveEquations ? extractEquations(paper.abstract) : [],
      figures: [],
      citations: extractCitations(paper.abstract),
      ...(paper.venue !== undefined ? { venue: paper.venue } : {}),
      ...(paper.year !== undefined ? { year: paper.year } : {}),
      ...(paper.doi !== undefined ? { doi: paper.doi } : {}),
      ...(paper.arxivId !== undefined ? { arxivId: paper.arxivId } : {}),
    }),

    buildSectionChunk: (
      paper: PaperMetadata,
      section: { type: string; content: string },
    ): AcademicChunk[] => {
      const chunks: AcademicChunk[] = [];
      const sectionType = section.type as AcademicChunk['section'];
      const subChunks = splitSection(section.content, opts.sectionChunkSize);

      for (const [i, sub] of subChunks.entries()) {
        if (!sub) continue;
        chunks.push({
          text: sub,
          url: paper.url ?? '',
          section: sectionType,
          charOffset: 0,
          chunkIndex: i,
          totalChunks: subChunks.length,
          paperId: paper.paperId,
          title: paper.title,
          authors: paper.authors,
          abstract: paper.abstract,
          equations: opts.preserveEquations ? extractEquations(sub) : [],
          figures: extractFigures(sub),
          citations: extractCitations(sub),
          ...(paper.venue !== undefined ? { venue: paper.venue } : {}),
          ...(paper.year !== undefined ? { year: paper.year } : {}),
          ...(paper.doi !== undefined ? { doi: paper.doi } : {}),
          ...(paper.arxivId !== undefined ? { arxivId: paper.arxivId } : {}),
        });
      }

      return chunks;
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function splitSection(content: string, chunkSize: number): string[] {
  if (content.length <= chunkSize) return [content];

  const chunks: string[] = [];
  let start = 0;

  while (start < content.length) {
    let end = start + chunkSize;

    // Try to break at paragraph boundary
    if (end < content.length) {
      const paragraphBreak = content.lastIndexOf('\n\n', end);
      if (paragraphBreak > start) {
        end = paragraphBreak;
      }
    }

    const chunk = content.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    start = end;
  }

  return chunks;
}

// ── Document conversion ──────────────────────────────────────────────────────

export function academicResultToRawDocument(paper: PaperMetadata, fullText?: string): RawDocument {
  return {
    id: paper.paperId,
    adapter: 'academic' as const,
    text: fullText ?? paper.abstract,
    url: paper.url ?? '',
    title: paper.title,
    metadata: {
      paper: {
        paperId: paper.paperId,
        title: paper.title,
        authors: paper.authors,
        abstract: paper.abstract,
        ...(paper.venue !== undefined ? { venue: paper.venue } : {}),
        ...(paper.year !== undefined ? { year: paper.year } : {}),
        ...(paper.doi !== undefined ? { doi: paper.doi } : {}),
        ...(paper.arxivId !== undefined ? { arxivId: paper.arxivId } : {}),
        url: paper.url,
      },
    },
  };
}
