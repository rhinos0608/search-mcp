export interface MarkdownChunk {
  content: string;
  section: string;
  url: string;
  pageTitle: string | null;
  chunkIndex: number;
  totalChunks: number;
  tokenEstimate: number;
  charOffset: number;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const MAX_TOKENS = 400;
const MIN_TOKENS = 50;
const TOKEN_RATIO = 4;
const OVERLAP_RATIO = 0.2;

interface Section {
  depth: number;
  heading: string;
  contentLines: string[];
}

interface SectionNode extends Section {
  chain: string;
  tokens: number;
}

export function chunkMarkdown(markdown: string, url: string): MarkdownChunk[] {
  const lines = markdown.split('\n');
  const { sections, pageTitle } = parseSections(lines);

  // Build section nodes with chains
  const nodes: SectionNode[] = [];
  const parentStack: Section[] = [];

  for (const section of sections) {
    if (section.depth === 1) continue;

    while (parentStack.length > 0) {
      const last = parentStack[parentStack.length - 1];
      if (last && last.depth >= section.depth) {
        parentStack.pop();
      } else {
        break;
      }
    }

    const chain = buildChain(pageTitle, section, parentStack);
    const content = section.contentLines.join('\n').trim();
    nodes.push({
      ...section,
      chain,
      tokens: estimateTokens(content),
      contentLines: content.length > 0 ? content.split('\n') : [],
    });

    parentStack.push(section);
  }

  // Merge short sections
  const groups = mergeShortSections(nodes);

  // Split groups into chunks
  let allChunks: MarkdownChunk[] = [];
  for (const group of groups) {
    const groupContent = group.map((n) => n.contentLines.join('\n')).join('\n\n').trim();
    const groupChain = group.at(-1)?.chain ?? '';
    const chunks = splitGroup(groupContent, groupChain, url, pageTitle);
    allChunks = allChunks.concat(chunks);
  }

  // Post-process to ensure floor invariant
  allChunks = postProcessChunks(allChunks);

  // Annotate global indices
  return allChunks.map((c, i) => ({
    ...c,
    chunkIndex: i,
    totalChunks: allChunks.length,
  }));
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_RATIO);
}

function parseSections(lines: string[]): { sections: Section[]; pageTitle: string | null } {
  const sections: Section[] = [];
  let current: Section | null = null;
  let inCodeFence = false;
  let pageTitle: string | null = null;

  for (const line of lines) {
    // Toggle code fence state
    if (line.trimStart().startsWith('```')) {
      inCodeFence = !inCodeFence;
    }

    const m = !inCodeFence ? HEADING_RE.exec(line) : null;

    if (m) {
      const depth = (m[1] ?? '').length;
      const heading = (m[2] ?? '').trim();

      if (depth === 1) {
        if (pageTitle === null) {
          pageTitle = heading;
          if (current) {
            sections.push(current);
          }
          // Synthetic section to capture content under this H1
          current = { depth: 2, heading: '', contentLines: [] };
        } else {
          // Subsequent H1s are treated as regular content
          current?.contentLines.push(line);
        }
      } else {
        if (current) {
          sections.push(current);
        }
        current = { depth, heading, contentLines: [] };
      }
    } else {
      current ??= { depth: 2, heading: '', contentLines: [] };
      current.contentLines.push(line);
    }
  }

  if (current) {
    sections.push(current);
  }

  return { sections, pageTitle };
}

function buildChain(pageTitle: string | null, section: Section, parentStack: Section[]): string {
  const parts: string[] = [];
  if (pageTitle) parts.push(`# ${pageTitle}`);
  for (const parent of parentStack) {
    parts.push(parent.heading ? `${'#'.repeat(parent.depth)} ${parent.heading}` : '#'.repeat(parent.depth));
  }
  parts.push(section.heading ? `${'#'.repeat(section.depth)} ${section.heading}` : '#'.repeat(section.depth));
  return parts.join(' > ');
}

function mergeShortSections(nodes: SectionNode[]): SectionNode[][] {
  if (nodes.length === 0) return [];

  const groups: SectionNode[][] = nodes.map((n) => [n]);

  let i = 0;
  while (i < groups.length) {
    const group = groups[i];
    if (!group) {
      i++;
      continue;
    }
    const tokens = group.reduce((sum, n) => sum + n.tokens, 0);
    if (tokens >= MIN_TOKENS) {
      i++;
      continue;
    }

    if (i + 1 < groups.length) {
      // Merge forward into next group
      const nextGroup = groups[i + 1];
      if (nextGroup) {
        groups[i + 1] = group.concat(nextGroup);
      }
      groups.splice(i, 1);
      // Stay at same i to check the merged group
    } else if (i > 0) {
      // Merge backward into previous group
      const prevGroup = groups[i - 1];
      if (prevGroup) {
        groups[i - 1] = prevGroup.concat(group);
      }
      groups.splice(i, 1);
      break;
    } else {
      // Only group and it's sub-floor; keep it
      i++;
    }
  }

  return groups;
}

function splitGroup(content: string, chain: string, url: string, pageTitle: string | null): MarkdownChunk[] {
  const trimmed = content.trim();
  if (trimmed.length === 0) return [];

  const tokens = estimateTokens(trimmed);
  if (tokens <= MAX_TOKENS) {
    return [createChunk(trimmed, chain, url, pageTitle, 0, 1, 0)];
  }

  const maxChars = MAX_TOKENS * TOKEN_RATIO;
  const chunks: MarkdownChunk[] = [];
  let start = 0;
  let charOffset = 0;

  while (start < trimmed.length) {
    const remaining = trimmed.length - start;
    if (remaining <= maxChars) {
      const text = trimmed.slice(start).trim();
      if (text.length > 0) {
        chunks.push(createChunk(text, chain, url, pageTitle, chunks.length, 0, charOffset));
      }
      break;
    }

    let splitPos = findSplitPosition(trimmed, start, maxChars);

    // Ensure we make progress
    if (splitPos <= start) {
      splitPos = Math.min(start + maxChars, trimmed.length);
    }

    const chunkText = trimmed.slice(start, splitPos).trim();
    if (chunkText.length > 0) {
      chunks.push(createChunk(chunkText, chain, url, pageTitle, chunks.length, 0, charOffset));
    }

    // Calculate overlap
    const overlapSize = Math.floor(chunkText.length * OVERLAP_RATIO);
    let nextStart = splitPos - overlapSize;
    if (nextStart < start) nextStart = start;

    // Snap overlap start to next sentence boundary
    nextStart = snapToSentenceBoundary(trimmed, nextStart, splitPos);
    if (nextStart >= splitPos || nextStart <= start) {
      nextStart = splitPos;
    }

    start = nextStart;
    charOffset = start;
  }

  return chunks;
}

function findSplitPosition(content: string, start: number, maxChars: number): number {
  const target = start + maxChars;
  if (target >= content.length) return content.length;

  const units = extractAtomicUnits(content);

  // Search backward for blank line outside atomic unit
  let pos = target;
  while (pos > start) {
    if (content[pos] === '\n' && content[pos + 1] === '\n') {
      if (!isInAtomicUnit(pos, units)) {
        return pos + 1;
      }
    }
    pos--;
  }

  // Search forward for sentence boundary
  pos = target;
  while (pos < content.length) {
    if (
      (content[pos] === '.' || content[pos] === '?' || content[pos] === '!') &&
      content[pos + 1] === ' '
    ) {
      if (!isInAtomicUnit(pos, units)) {
        return pos + 2;
      }
    }
    if (content[pos] === '\n' && content[pos + 1] !== '\n') {
      if (!isInAtomicUnit(pos, units)) {
        return pos + 1;
      }
    }
    pos++;
  }

  // Fallback: force split at target, but outside atomic unit
  pos = target;
  while (pos < content.length && isInAtomicUnit(pos, units)) {
    pos++;
  }
  return pos;
}

function isInAtomicUnit(pos: number, units: AtomicUnit[]): boolean {
  for (const u of units) {
    if (pos >= u.start && pos < u.end) return true;
  }
  return false;
}

interface AtomicUnit {
  start: number;
  end: number;
}

function extractAtomicUnits(content: string): AtomicUnit[] {
  const units: AtomicUnit[] = [];
  const lines = content.split('\n');
  let i = 0;
  let charOffset = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;

    // Code fence
    if (line.trimStart().startsWith('```')) {
      const start = charOffset;
      i++;
      charOffset += line.length + 1;
      while (i < lines.length) {
        const innerLine = lines[i];
        if (innerLine === undefined) break;
        if (innerLine.trimStart().startsWith('```')) break;
        charOffset += innerLine.length + 1;
        i++;
      }
      if (i < lines.length) {
        const closeLine = lines[i];
        if (closeLine !== undefined) {
          charOffset += closeLine.length + 1;
        }
        i++;
      }
      units.push({ start, end: charOffset });
      continue;
    }

    // Table
    if (line.trimStart().startsWith('|')) {
      const start = charOffset;
      while (i < lines.length) {
        const tableLine = lines[i];
        if (!tableLine?.trimStart().startsWith('|')) break;
        charOffset += tableLine.length + 1;
        i++;
      }
      units.push({ start, end: charOffset });
      continue;
    }

    // Indented code block
    if (line.startsWith('    ') || line.startsWith('\t')) {
      const start = charOffset;
      while (i < lines.length) {
        const codeLine = lines[i];
        if (codeLine === undefined) break;
        if (!codeLine.startsWith('    ') && !codeLine.startsWith('\t') && codeLine.length > 0) break;
        charOffset += codeLine.length + 1;
        i++;
      }
      units.push({ start, end: charOffset });
      continue;
    }

    charOffset += line.length + 1;
    i++;
  }

  return units;
}

function snapToSentenceBoundary(content: string, rawStart: number, splitPos: number): number {
  let pos = rawStart;
  while (pos < splitPos) {
    if (
      (content[pos] === '.' || content[pos] === '?' || content[pos] === '!') &&
      content[pos + 1] === ' '
    ) {
      return pos + 2;
    }
    if (content[pos] === '\n') {
      return pos + 1;
    }
    pos++;
  }
  // No sentence boundary found; keep the raw overlap
  return rawStart;
}

function postProcessChunks(chunks: MarkdownChunk[]): MarkdownChunk[] {
  if (chunks.length <= 1) return chunks;

  const result: MarkdownChunk[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    if (chunk.tokenEstimate >= MIN_TOKENS) {
      result.push(chunk);
      continue;
    }

    // Sub-floor chunk
    if (result.length > 0) {
      // Merge backward into previous chunk
      const prev = result.at(-1);
      if (prev) {
        const mergedContent = prev.content + '\n\n' + chunk.content;
        result[result.length - 1] = {
          ...prev,
          content: mergedContent,
          tokenEstimate: estimateTokens(mergedContent),
        };
      } else {
        result.push(chunk);
      }
    } else if (i + 1 < chunks.length) {
      // Merge forward into next chunk
      const next = chunks[i + 1];
      if (next) {
        const mergedContent = chunk.content + '\n\n' + next.content;
        result.push({
          ...chunk,
          content: mergedContent,
          tokenEstimate: estimateTokens(mergedContent),
          totalChunks: 0,
        });
        i++; // skip next since we consumed it
      } else {
        result.push(chunk);
      }
    } else {
      result.push(chunk);
    }
  }

  return result.map((c, idx) => ({
    ...c,
    chunkIndex: idx,
    totalChunks: result.length,
  }));
}

function createChunk(
  content: string,
  section: string,
  url: string,
  pageTitle: string | null,
  chunkIndex: number,
  totalChunks: number,
  charOffset: number
): MarkdownChunk {
  return {
    content,
    section,
    url,
    pageTitle,
    chunkIndex,
    totalChunks,
    tokenEstimate: estimateTokens(content),
    charOffset,
  };
}
