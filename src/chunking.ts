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
  const sections = parseSections(lines);
  const pageTitle = sections.find((s) => s.depth === 1)?.heading ?? null;

  // Build section nodes with chains
  const nodes: SectionNode[] = [];
  const parentStack: Section[] = [];

  for (const section of sections) {
    if (section.depth === 1) continue;

    while (parentStack.length > 0 && parentStack[parentStack.length - 1]!.depth >= section.depth) {
      parentStack.pop();
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
    const groupChain = group[group.length - 1]!.chain;
    const chunks = splitGroup(groupContent, groupChain, url, pageTitle);
    allChunks = allChunks.concat(chunks);
  }

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

function parseSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      const depth = m[1]!.length;
      const heading = m[2]!.trim();
      if (current) sections.push(current);
      current = { depth, heading, contentLines: [] };
    } else if (current) {
      current.contentLines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

function buildChain(pageTitle: string | null, section: Section, parentStack: Section[]): string {
  const parts: string[] = [];
  if (pageTitle) parts.push(`# ${pageTitle}`);
  for (const parent of parentStack) {
    parts.push(`${'#'.repeat(parent.depth)} ${parent.heading}`);
  }
  parts.push(`${'#'.repeat(section.depth)} ${section.heading}`);
  return parts.join(' > ');
}

function mergeShortSections(nodes: SectionNode[]): SectionNode[][] {
  const groups: SectionNode[][] = [];
  let currentGroup: SectionNode[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;

    // If depth changes, finalize current group before starting new one
    if (currentGroup.length > 0 && node.depth !== currentGroup[0]!.depth) {
      finalizeGroup(currentGroup, groups);
      currentGroup = [];
    }

    currentGroup.push(node);
    const groupTokens = currentGroup.reduce((sum, n) => sum + n.tokens, 0);
    const nextNode = nodes[i + 1];

    if (groupTokens >= MIN_TOKENS) {
      groups.push(currentGroup);
      currentGroup = [];
    } else if (!nextNode || nextNode.depth !== currentGroup[0]!.depth) {
      // No more same-depth siblings to chain into; finalize now
      finalizeGroup(currentGroup, groups);
      currentGroup = [];
    }
  }

  if (currentGroup.length > 0) {
    finalizeGroup(currentGroup, groups);
  }

  return groups;
}

function finalizeGroup(group: SectionNode[], groups: SectionNode[][]): void {
  const groupTokens = group.reduce((sum, n) => sum + n.tokens, 0);

  if (groupTokens >= MIN_TOKENS) {
    groups.push(group);
    return;
  }

  // Try to merge backward into previous group of same depth
  if (groups.length > 0) {
    const lastGroup = groups[groups.length - 1]!;
    if (lastGroup[0]!.depth === group[0]!.depth) {
      groups[groups.length - 1] = lastGroup.concat(group);
      return;
    }
  }

  // Entire document (or this sibling group) is one chunk
  groups.push(group);
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
    const line = lines[i]!;

    // Code fence
    if (line.trimStart().startsWith('```')) {
      const start = charOffset;
      i++;
      charOffset += line.length + 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) {
        charOffset += lines[i]!.length + 1;
        i++;
      }
      if (i < lines.length) {
        charOffset += lines[i]!.length + 1;
        i++;
      }
      units.push({ start, end: charOffset });
      continue;
    }

    // Table
    if (line.trimStart().startsWith('|')) {
      const start = charOffset;
      while (i < lines.length && lines[i]!.trimStart().startsWith('|')) {
        charOffset += lines[i]!.length + 1;
        i++;
      }
      units.push({ start, end: charOffset });
      continue;
    }

    // Indented code block
    if (line.startsWith('    ') || line.startsWith('\t')) {
      const start = charOffset;
      while (
        i < lines.length &&
        (lines[i]!.startsWith('    ') || lines[i]!.startsWith('\t') || lines[i]!.length === 0)
      ) {
        charOffset += lines[i]!.length + 1;
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
  return splitPos;
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
