/**
 * Content cleanup utilities for web_read and web_crawl output.
 *
 * Two-pass cleanup architecture:
 *   Pass 1 (conservative, always on): Removes individual lines matching clear
 *     boilerplate patterns — cookie/footer/share/signin/search/menu, empty
 *     bullets, repeated button labels, and common noise artifacts.
 *   Pass 2 (aggressive, region-level): Detects contiguous boilerplate blocks
 *     where 60%+ of adjacent lines match boilerplate patterns and strips the
 *     entire region. Only applied when the quality classifier flags the
 *     content as boilerplate-heavy.
 */

import { ALL_BOILERPLATE_PATTERNS } from './markdownQuality.js';

// ── Always-on (conservative) patterns ────────────────────────────────────────

/** Patterns that are safe to remove unconditionally (Pass 1). */
const CONSERVATIVE_LINE_PATTERNS: RegExp[] = [
  // Footer boilerplate
  /^\s*(?:©|copyright|all rights reserved|privacy policy|terms of service|terms of use|cookie policy|sitemap)\b/i,
  // Skip / accessibility links
  /^skip to (?:content|navigation|main|text)/i,
  // Back to top
  /^back to top/i,
  // Social/share headers
  /^\s*(?:share|follow\s+us|share\s+this|connect|social|more\s+from)\s*:/i,
  // Posted / published / updated dates
  /^\s*(?:posted|published|updated|modified|written|authored)\s+(?:on|by|at)\b/i,
  // "Last updated:" lines
  /^\s*last\s+(?:updated|modified|edited)\s*:/i,
  // Powered by / built with
  /^\s*(?:powered by|built with)\b/i,
  // GitHub-specific nav text patterns
  /^(?:navigation menu|toggle navigation|appearance settings|search (?:or jump|code|repositories)|search syntax tips|provide feedback|manage cookies|do not share|include my email|we read every piece)/i,
  // Heading-level nav markers
  /^##\s+(?:navigation menu|provide feedback|footer)/i,
  /^###\s+footer navigation/i,
  // Bracket nav: [Cancel] [Feedback]
  /^\[(?:skip to content|sign\s+(?:in|up)|cancel)\]/i,
  /^\[cancel\]\s*\[feedback\]/i,
  // Sign in / sign up (standalone)
  /^sign\s+(?:in|up)$/i,
  // Toggle navigation
  /^toggle navigation/i,
  // "We read every piece"
  /^we read every piece/i,
  // "Include my email"
  /^include my email/i,
  // Manage cookies / Do not share
  /^(?:\s*[*\-+]\s+)?manage cookies\s*$/i,
  /^(?:\s*[*\-+]\s+)?do not share/i,
];

// ── Aggressive (region-level) patterns ───────────────────────────────────────

/**
 * Check if a line matches any boilerplate pattern.
 * Used for region-level detection in Pass 2.
 */
function lineMatchesBoilerplate(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  for (const entry of ALL_BOILERPLATE_PATTERNS) {
    if (entry.pattern.test(trimmed)) return true;
  }
  return false;
}

/** Keep predefined action/copy phrases that are actually part of legit UI or code docs. */
const FALSE_POSITIVE_PATTERNS: RegExp[] = [
  /^license$/i,
  /^MIT|ISC|Apache-2\.0|BSD|GPL|LGPL|MPL|Unlicense/i,
  /^contributing$/i,
  /^changelog$/i,
  /^code of conduct/i,
  /^examples$/i,
  /^getting started$/i,
];

function isFalsePositive(line: string): boolean {
  const trimmed = line.trim();
  return FALSE_POSITIVE_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Detect contiguous boilerplate blocks.
 * Returns ranges [startLineIndex, endLineIndex] of regions to strip.
 */
function detectBoilerplateBlocks(
  lines: string[],
  minBlockSize = 5,
  requiredRatio = 0.6,
): [number, number][] {
  if (lines.length < minBlockSize) return [];

  const blocks: [number, number][] = [];
  let blockStart: number | null = null;
  let boilerplateCount = 0;
  let totalCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    // Stop block at empty lines or code fences
    if (trimmed.length === 0 || trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      // Check if current block is worth stripping
      if (blockStart !== null && totalCount >= minBlockSize) {
        const ratio = boilerplateCount / totalCount;
        if (ratio >= requiredRatio) {
          blocks.push([blockStart, i - 1]);
        }
      }
      blockStart = null;
      boilerplateCount = 0;
      totalCount = 0;
      continue;
    }

    // Start a new block if not in one
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    if (blockStart === null) {
      blockStart = i;
    }

    totalCount++;
    const isBoilerplate = lineMatchesBoilerplate(trimmed) && !isFalsePositive(trimmed);
    if (isBoilerplate) boilerplateCount++;

    // Check at end of block (paragraph break = empty line)
    // This is handled above when we hit empty lines
  }

  // Check final block
  if (blockStart !== null && totalCount >= minBlockSize) {
    const ratio = boilerplateCount / totalCount;
    if (ratio >= requiredRatio) {
      blocks.push([blockStart, lines.length - 1]);
    }
  }

  // Merge overlapping or adjacent blocks
  return mergeBlocks(blocks);
}

function mergeBlocks(blocks: [number, number][]): [number, number][] {
  if (blocks.length <= 1) return blocks;

  const sorted = [...blocks].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [sorted[0] ?? [0, 0]];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1] ?? [0, 0];
    const current = sorted[i] ?? [0, 0];
    if (current[0] <= last[1] + 1) {
      // Overlapping or adjacent — merge
      last[1] = Math.max(last[1], current[1]);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

// ── Main cleanup functions ───────────────────────────────────────────────────

/**
 * Clean a text string produced by Readability or fallback extraction.
 * Pass 1 (conservative): removes literal escape sequences, normalizes whitespace,
 * strips common navigation/footer/consent boilerplate lines.
 */
export function cleanTextContent(text: string): string {
  if (!text) return '';

  let cleaned = text;

  // 1. Replace literal backslash-n sequences (not actual newlines) with space.
  cleaned = cleaned.replace(/\\n/g, ' ');

  // 2. Replace literal \t, \r, \b with space
  cleaned = cleaned.replace(/\\[trb]/g, ' ');

  // 3. Collapse runs of whitespace within lines
  cleaned = cleaned.replace(/[^\S\n]{2,}/g, ' ');

  // 4. Remove lines that are pure navigation/footer boilerplate (Pass 1)
  const lines = cleaned.split('\n');
  const filtered: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      filtered.push(line);
      continue;
    }

    // Conservative line-level patterns
    if (CONSERVATIVE_LINE_PATTERNS.some((p) => p.test(trimmed))) {
      continue;
    }

    // Breadcrumb: "Home > Category > Page" (short navbar breadcrumbs)
    if (/^[a-z][a-z\s]*\s*>\s*[a-z]/i.test(trimmed) && trimmed.length < 100) continue;

    // All-caps filter (was >=3, now >=5 chars to avoid MIT/GPL/BSD false positives)
    if (/^[A-Z][A-Z\s]{4,}$/.test(trimmed) && trimmed.length < 60) continue;

    filtered.push(line);
  }

  cleaned = filtered.join('\n');

  // 5. Collapse multiple consecutive blank lines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // 6. Remove leading/trailing whitespace
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Strip navigation boilerplate and clean noise from markdown text.
 *
 * Pass 1 (conservative, always on): Individual line removal for known
 * boilerplate patterns (GitHub nav, consent, footer, etc.)
 *
 * Pass 2 (aggressive, region-level): When `aggressive` is true, detects
 * contiguous boilerplate blocks (5+ lines where 60%+ are boilerplate)
 * and strips the entire region.
 *
 * @param markdown The raw markdown content.
 * @param aggressive If true, applies region-level boilerplate block stripping.
 *   Set to true when the quality classifier flags content as boilerplate-heavy.
 */
export function cleanMarkdownContent(markdown: string, aggressive?: boolean): string {
  if (!markdown) return '';

  let cleaned = markdown;

  // ── Phase 0: Escape sequence cleanup ───────────────────────────────────
  cleaned = cleaned.replace(/\\n/g, ' ');
  cleaned = cleaned.replace(/\\[trb]/g, ' ');

  // ── Phase 1: Conservative line-level stripping (always on) ──────────────
  const lines = cleaned.split('\n');
  const pass1Lines: string[] = [];
  let inCodeFence = false;

  for (const line of lines) {
    if (line.trimStart().startsWith('```') || line.trimStart().startsWith('~~~')) {
      inCodeFence = !inCodeFence;
      pass1Lines.push(line);
      continue;
    }

    if (inCodeFence) {
      pass1Lines.push(line);
      continue;
    }

    const trimmed = line.trim();

    // Empty lines pass through
    if (trimmed.length === 0) {
      pass1Lines.push(line);
      continue;
    }

    // GitHub-specific nav section headings
    if (/^##\s+Navigation Menu/i.test(trimmed)) continue;
    if (/^##\s+Footer/i.test(trimmed)) continue;
    if (/^##\s+Provide feedback/i.test(trimmed)) continue;
    if (/^###\s+Footer navigation/i.test(trimmed)) continue;

    // GitHub UI text
    if (/^Toggle navigation/i.test(trimmed)) continue;
    if (/^Appearance settings/i.test(trimmed)) continue;
    if (/^Sign\s+(?:in|up)/i.test(trimmed)) continue;
    if (/^Search (?:or jump|code|repositories)/i.test(trimmed)) continue;
    if (/^Search syntax tips/i.test(trimmed)) continue;
    if (/^Provide feedback/i.test(trimmed)) continue;
    if (/^We read every piece/i.test(trimmed)) continue;
    if (/^Include my email/i.test(trimmed)) continue;
    if (/^(?:\s*[*\-+]\s+)?Manage cookies\s*$/i.test(trimmed)) continue;
    if (/^(?:\s*[*\-+]\s+)?Do not share/i.test(trimmed)) continue;

    // GitHub bracket nav: [Cancel] [Feedback]
    if (/^\[[^\]]+\]\s*\[[^\]]+\]/i.test(trimmed)) continue;

    // Skip to content link
    if (/^\[Skip to content\]\(/i.test(trimmed)) continue;

    // GitHub nav bullet section markers
    if (
      /^\s*[*\-+]\s+(?:Platform|Solutions|Resources|Products|Company|Explore|Learn|More\s+from|Tools|Developer|AI\s+CODE\s+CREATION|DEVELOPER\s+WORKFLOWS|APPLICATION\s+SECURITY|By\s+size|By\s+industry)/i.test(
        trimmed,
      )
    )
      continue;

    // Single footer nav items: * [Terms](url) * [Privacy](url) etc
    if (/^\s*[*\-+]\s+\[[^\]]+\]\([^)]+\)\s*$/.test(trimmed)) continue;

    // Markdown link nav row: 3+ inline links where links dominate the line
    const linkMatches = trimmed.match(/\[[^\]]+\]\([^)]+\)/g);
    if (linkMatches && linkMatches.length >= 3) {
      const linkChars = linkMatches.reduce((sum, m) => sum + m.length, 0);
      if (linkChars / trimmed.length > 0.5) {
        continue;
      }
    }

    // Pure link nav row: [Link] | [Link] • [Link] * [Link]
    if (/^(?:\[[^\]]+\]\([^)]+\)\s*[|•·*/]\s*)*\[[^\]]+\]\([^)]+\)/.test(trimmed)) {
      continue;
    }

    // Apply text content cleaning to non-markdown-structural lines
    if (
      !line.trimStart().startsWith('|') &&
      !line.trimStart().startsWith('>') &&
      !line.trimStart().startsWith('#') &&
      !line.trimStart().startsWith('-') &&
      !line.trimStart().startsWith('*') &&
      !/^\d+\.\s/.test(line.trimStart())
    ) {
      const cleanLine = cleanTextContent(trimmed);
      if (cleanLine.length === 0) continue;
    }

    pass1Lines.push(line);
  }

  // ── Phase 2: Aggressive region-level stripping ───────────────────────────
  // Only applies when `aggressive` is true (set by middleware when classifier
  // flags content as boilerplate-heavy).
  let finalLines = pass1Lines;

  if (aggressive) {
    const blocks = detectBoilerplateBlocks(pass1Lines, 5, 0.6);
    if (blocks.length > 0) {
      // Build a set of line indices to remove
      const removeSet = new Set<number>();
      for (const [start, end] of blocks) {
        for (let i = start; i <= end; i++) {
          removeSet.add(i);
        }
      }
      finalLines = pass1Lines.filter((_, i) => !removeSet.has(i));
    }
  }

  cleaned = finalLines.join('\n');

  // ── Phase 3: Cleanup ────────────────────────────────────────────────────
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}
