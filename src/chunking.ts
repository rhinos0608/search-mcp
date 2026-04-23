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

  // Strip shared nav lines across sections before filtering/merging
  if (nodes.length > 1) {
    const lineCounts = new Map<string, number>();
    for (const node of nodes) {
      const seen = new Set<string>();
      for (const line of node.contentLines) {
        const key = line.trim().toLowerCase();
        if (key.length === 0) continue;
        if (!seen.has(key)) {
          seen.add(key);
          lineCounts.set(key, (lineCounts.get(key) ?? 0) + 1);
        }
      }
    }

    const sharedLines = new Set<string>();
    for (const [line, count] of lineCounts) {
      if (count > 1) sharedLines.add(line);
    }

    if (sharedLines.size > 0) {
      for (const node of nodes) {
        node.contentLines = node.contentLines.filter((line) => {
          const key = line.trim().toLowerCase();
          return key.length === 0 || !sharedLines.has(key);
        });
      }
    }
  }

  // Strip breadcrumb and pure-link lines from individual sections
  for (const node of nodes) {
    node.contentLines = node.contentLines.filter(
      (line) => !isBreadcrumbLine(line) && !isPureLinkLine(line),
    );
  }

  // Filter boilerplate sections (check stripped content with full heuristic)
  const contentNodes = nodes.filter((n) => !isBoilerplate(n.contentLines.join('\n')));

  // Merge short sections
  const groups = mergeShortSections(contentNodes);

  // Split groups into chunks
  const allChunks: MarkdownChunk[] = [];
  let runningOffset = 0;
  for (const group of groups) {
    const groupContent = group.map((n) => n.contentLines.join('\n')).join('\n\n').trim();
    const groupChain = group.at(-1)?.chain ?? '';
    const chunks = splitGroup(groupContent, groupChain, url, pageTitle, runningOffset);
    runningOffset += groupContent.length + 2; // +2 for the '\n\n' joiner
    allChunks.push(...chunks);
  }

  // Post-process to ensure floor invariant
  let processed = postProcessChunks(allChunks);

  // Context-aware boilerplate filtering (breadcrumbs, link-heavy, etc.)
  processed = filterBoilerplateWithContext(processed);

  return processed;
}

// --- Boilerplate heuristics ---

const BREADCRUMB_LINK_RATIO = 0.5;
const PURE_LINK_RATIO_THRESHOLD = 0.8;

function isBreadcrumbLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  const linkParts = trimmed.match(/\[([^\]]+)\]\(([^)]+)\)/g);
  if (!linkParts) return false;
  const linkChars = linkParts.reduce((sum, m) => sum + m.length, 0);
  return linkChars / trimmed.length > PURE_LINK_RATIO_THRESHOLD && trimmed.includes('>');
}

function isPureLinkLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  const linkMatch = /\[([^\]]+)\]\(([^)]+)\)/.exec(trimmed);
  if (!linkMatch) return false;
  return linkMatch[0].length / trimmed.length > PURE_LINK_RATIO_THRESHOLD;
}

function isBoilerplateWithBreadcrumbCheck(content: string): boolean {
  if (isBoilerplate(content)) return true;

  const trimmed = content.trim();
  const lines = trimmed.split('\n');
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0);
  if (nonEmptyLines.length === 0) return true;

  // Breadcrumb navigation: >50% of lines are breadcrumb patterns
  const breadcrumbLines = nonEmptyLines.filter(isBreadcrumbLine);
  if (breadcrumbLines.length / nonEmptyLines.length > BREADCRUMB_LINK_RATIO) return true;

  // Short-line + link-heavy: avg words < 3 AND >30% pure link lines
  const totalWords = nonEmptyLines.reduce((sum, l) => sum + l.trim().split(/\s+/).length, 0);
  const avgWordsPerLine = totalWords / nonEmptyLines.length;
  const pureLinkLines = nonEmptyLines.filter(isPureLinkLine);
  if (avgWordsPerLine < 3 && pureLinkLines.length / nonEmptyLines.length > 0.3) return true;

  return false;
}

export function filterBoilerplateWithContext(chunks: MarkdownChunk[]): MarkdownChunk[] {
  if (chunks.length === 0) return chunks;

  // Pass 1: line-level dedup — strip lines that appear in 2+ chunks (repeated nav blocks)
  if (chunks.length > 1) {
    const lineCounts = new Map<string, number>();
    for (const chunk of chunks) {
      const seen = new Set<string>();
      for (const line of chunk.content.split('\n')) {
        const key = line.trim().toLowerCase();
        if (key.length === 0) continue;
        if (!seen.has(key)) {
          seen.add(key);
          lineCounts.set(key, (lineCounts.get(key) ?? 0) + 1);
        }
      }
    }

    const sharedLines = new Set<string>();
    for (const [line, count] of lineCounts) {
      if (count > 1) sharedLines.add(line);
    }

    if (sharedLines.size > 0) {
      chunks = chunks.map((chunk) => {
        const kept = chunk.content
          .split('\n')
          .filter((line) => {
            const key = line.trim().toLowerCase();
            return key.length === 0 || !sharedLines.has(key);
          })
          .join('\n')
          .trim();
        return { ...chunk, content: kept };
      });
    }
  }

  // Pass 2: strip remaining breadcrumb and pure-link lines from chunk content
  chunks = chunks.map((chunk) => {
    const stripped = chunk.content
      .split('\n')
      .filter((line) => !isBreadcrumbLine(line) && !isPureLinkLine(line))
      .join('\n')
      .trim();
    return { ...chunk, content: stripped };
  });

  // Pass 3: individual boilerplate filtering (link-heavy, sidebar, etc.)
  return chunks.filter((c) => c.content.length > 0 && !isBoilerplateWithBreadcrumbCheck(c.content));
}

function isBoilerplate(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return true;

  // Never treat code blocks as boilerplate
  if (trimmed.includes('```')) return false;

  // Count markdown links [text](url)
  const linkMatches = trimmed.match(/\[([^\]]+)\]\(([^)]+)\)/g);
  const linkChars = linkMatches ? linkMatches.reduce((sum, m) => sum + m.length, 0) : 0;
  const linkDensity = trimmed.length > 0 ? linkChars / trimmed.length : 0;

  // Very high link density = nav/footer
  if (linkDensity > 0.5) return true;

  const lines = trimmed.split('\n');
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0);
  if (nonEmptyLines.length === 0) return true;

  // List-item density and short-line density
  const listItemLines = nonEmptyLines.filter(
    (l) => /^\s*[-*+]\s/.test(l) || /^\s*\d+\.\s/.test(l),
  );
  const listDensity = nonEmptyLines.length > 0 ? listItemLines.length / nonEmptyLines.length : 0;
  const shortLineCount = nonEmptyLines.filter((l) => l.length < 40).length;
  const shortLineDensity = shortLineCount / nonEmptyLines.length;

  // Nav menus: mostly short list items with moderate-to-high link density
  if (listDensity > 0.6 && shortLineDensity > 0.7 && linkDensity > 0.2) return true;

  // Plain-text nav/footer lists (no markdown links but very short items)
  if (listDensity > 0.7 && shortLineDensity > 0.8) {
    const avgWordsPerLine =
      nonEmptyLines.reduce((sum, l) => sum + l.trim().split(/\s+/).length, 0) / nonEmptyLines.length;
    if (avgWordsPerLine < 3) return true;
  }

  return false;
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
          current = { depth: 2, heading: '', contentLines: [] };
        } else {
          current?.contentLines.push(line);
        }
      } else if (depth <= 3) {
        if (current) {
          sections.push(current);
        }
        current = { depth, heading, contentLines: [] };
      } else {
        // H4+ — treat as content, not a boundary
        current ??= { depth: 2, heading: '', contentLines: [] };
        current.contentLines.push(line);
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

function splitGroup(content: string, chain: string, url: string, pageTitle: string | null, baseOffset = 0): MarkdownChunk[] {
  const trimmed = content.trim();
  if (trimmed.length === 0) return [];

  const tokens = estimateTokens(trimmed);
  if (tokens <= MAX_TOKENS) {
    return [createChunk(trimmed, chain, url, pageTitle, 0, 1, baseOffset)];
  }

  const maxChars = MAX_TOKENS * TOKEN_RATIO;
  const units = extractAtomicUnits(trimmed);
  const chunks: MarkdownChunk[] = [];
  let start = 0;
  let charOffset = 0;
  let unitIdx = 0;

  while (start < trimmed.length) {
    const remaining = trimmed.length - start;
    if (remaining <= maxChars) {
      const text = trimmed.slice(start).trim();
      if (text.length > 0) {
        chunks.push(createChunk(text, chain, url, pageTitle, chunks.length, 0, baseOffset + charOffset));
      }
      break;
    }

    const splitResult = findSplitPosition(trimmed, start, maxChars, units, unitIdx);
    let splitPos = splitResult.pos;
    unitIdx = splitResult.unitIdx;

    // Ensure we make progress
    if (splitPos <= start) {
      splitPos = Math.min(start + maxChars, trimmed.length);
    }

    const chunkText = trimmed.slice(start, splitPos).trim();
    if (chunkText.length > 0) {
      chunks.push(createChunk(chunkText, chain, url, pageTitle, chunks.length, 0, baseOffset + charOffset));
    }

    // Calculate overlap
    const overlapSize = Math.floor(chunkText.length * OVERLAP_RATIO);
    let nextStart = splitPos - overlapSize;
    if (nextStart < start) nextStart = start;

    // Snap overlap start to next sentence boundary, but never inside an atomic unit
    nextStart = snapToSentenceBoundary(trimmed, nextStart, splitPos);
    if (nextStart >= splitPos || nextStart <= start) {
      nextStart = splitPos;
    } else {
      // Ensure overlap start is not inside an atomic unit
      const unitIdxAtStart = findUnitIndex(nextStart, units);
      if (unitIdxAtStart !== -1) {
        const unit = units[unitIdxAtStart];
        if (unit && nextStart >= unit.start && nextStart < unit.end) {
          nextStart = unit.end;
          if (nextStart >= splitPos) {
            nextStart = splitPos;
          }
        }
      }
    }
    start = nextStart;
    charOffset = start;
  }

  // Two-pass: annotate per-section indices
  return chunks.map((c, i) => ({
    ...c,
    chunkIndex: i,
    totalChunks: chunks.length,
  }));
}

function findSplitPosition(
  content: string,
  start: number,
  maxChars: number,
  units: AtomicUnit[],
  unitIdx: number,
): { pos: number; unitIdx: number } {
  const target = start + maxChars;
  if (target >= content.length) return { pos: content.length, unitIdx };

  // Advance unitIdx to first unit that could overlap the search range
  while (unitIdx < units.length) {
    const u = units[unitIdx];
    if (!u || u.end > start) break;
    unitIdx++;
  }

  // Search backward for blank line outside atomic unit
  let pos = target;
  while (pos > start) {
    if (content[pos] === '\n' && content[pos + 1] === '\n') {
      if (!isInAtomicUnit(pos, units, unitIdx)) {
        return { pos: pos + 1, unitIdx };
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
      if (!isInAtomicUnit(pos, units, unitIdx)) {
        return { pos: pos + 2, unitIdx };
      }
    }
    if (content[pos] === '\n' && content[pos + 1] !== '\n') {
      if (!isInAtomicUnit(pos, units, unitIdx)) {
        return { pos: pos + 1, unitIdx };
      }
    }
    pos++;
  }

  // Fallback: force split at target, but outside atomic unit
  pos = target;
  while (pos < content.length && isInAtomicUnit(pos, units, unitIdx)) {
    pos++;
  }
  return { pos, unitIdx };
}

function findUnitIndex(pos: number, units: AtomicUnit[]): number {
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u && pos >= u.start && pos < u.end) return i;
  }
  return -1;
}

function isInAtomicUnit(pos: number, units: AtomicUnit[], unitIdx: number): boolean {
  // Fast path: advance pointer to relevant unit, then check
  let i = unitIdx;
  while (i < units.length) {
    const u = units[i];
    if (!u) break;
    if (pos < u.start) break;
    if (pos >= u.start && pos < u.end) return true;
    i++;
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
  const targetOverlap = splitPos - rawStart;
  let bestPos = rawStart;
  let bestDiff = Infinity;

  // Search backward from splitPos for the sentence boundary that gives
  // overlap closest to the target. This avoids the old bug where the
  // first boundary in the window produced a tiny overlap.
  for (let pos = splitPos - 1; pos >= 0; pos--) {
    if (
      (content[pos] === '.' || content[pos] === '?' || content[pos] === '!') &&
      content[pos + 1] === ' '
    ) {
      const candidateStart = pos + 2;
      const overlap = splitPos - candidateStart;
      const diff = Math.abs(overlap - targetOverlap);

      if (diff < bestDiff) {
        bestDiff = diff;
        bestPos = candidateStart;
      }
    }

    // Stop once we've searched far enough back that overlap would be >2x target
    if (splitPos - pos > targetOverlap * 2) break;
  }

  return bestPos;
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
          chunkIndex: 0,
          totalChunks: 1,
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
          chunkIndex: 0,
          totalChunks: 1,
        });
        i++; // skip next since we consumed it
      } else {
        result.push(chunk);
      }
    } else {
      result.push(chunk);
    }
  }

  return result;
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
