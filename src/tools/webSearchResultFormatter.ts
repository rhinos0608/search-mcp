/**
 * web_search markdown result formatter.
 *
 * Converts the ranked `SearchResult[]` produced by `webSearch()` into a single
 * bare-Markdown string (no XML/JSON/hybrid envelope):
 *
 * ```
 * # Web search results
 *
 * ## [1] Title
 * url: https://example.com/page
 * via: Exa (content), DuckDuckGo · published: 2026-01-01 · quality: low — video platform
 *
 * Prose paragraph with several sentences. [1-1]
 *
 * - list item with all its sentences [1-2]
 *
 * ```ts
 * code block
 * ```
 *  [1-3]
 *
 * ### AI summary
 *
 * Generated summary text.   (only when aiSummary=yes)
 * ```
 *
 * Every SEMANTIC BLOCK (prose paragraph, list item, blockquote paragraph, code
 * fence, or table) carries exactly one stable trailing citation `[N-M]` (N =
 * result index, M = sequential citation within the result). A block is never
 * partially emitted: if it exceeds the remaining byte/prose budget it is
 * skipped whole, so the citation sequence never has gaps. Headings are never
 * cited. The metadata line is compact (`via` lists every deduped MCP backend
 * that surfaced the URL with the content donor marked `(content)`;
 * publication/fetch origin, content kind, and an explainable source-credibility
 * `quality` tier). The artifact full-render uses the same format without the
 * inline byte/prose caps. Indivisible code/table blocks get a single trailing
 * citation on their own line. A native generated summary is emitted separately
 * under `### AI summary` when `aiSummary=yes`; `only` already returns
 * summary-only content in the body.
 *
 * The formatter enforces deterministic output budgets: a total cap (default
 * 192 KiB) and an adaptive per-document cap that scales with the result count
 * between an 8 KiB floor and a 24 KiB ceiling (a data-rich document gets more
 * room when few results share the total). Trimming only happens at whole-block
 * / sentence boundaries and appends a truncation note.
 */
import { stripNavigationMarkdown } from '../chunking.js';
import type { SearchResult } from '../types.js';
import type { AiSummaryMode } from './webSearch.js';

export const DEFAULT_TOTAL_BUDGET_BYTES = 192 * 1024;
/** Adaptive per-document floor: every result is guaranteed at least this budget. */
export const DEFAULT_DOCUMENT_BUDGET_BYTES = 8 * 1024;
/** Adaptive per-document ceiling: a data-rich result may grow up to this budget. */
export const DOCUMENT_BUDGET_CEILING_BYTES = 24 * 1024;
/** Fraction of the total budget an adaptive allocation targets, leaving headroom
 * so all N documents fit without a total-budget cut on the final result. */
const ADAPTIVE_TOTAL_UTILIZATION = 0.9;
/** Maximum prose/list/quote sentences emitted for a snippet-like document. */
export const MAX_SNIPPET_PROSE_SENTENCES = 6;
/** Maximum prose/list/quote sentences emitted for a generated summary. */
const MAX_SUMMARY_PROSE_SENTENCES = 3;
/** Lower per-document cap for YouTube results (never emit lengthy transcripts). */
export const YOUTUBE_DOCUMENT_BUDGET_BYTES = 4 * 1024;
export const TRANSCRIPT_NOTE = '> [Long transcript trimmed — showing first lines only.]';
export const TRUNCATION_NOTE = '> Content truncated at output budget.';

export interface MarkdownFormatOptions {
  /** `yes` emits each result's `generatedSummary` under `### AI summary`. */
  aiSummary?: AiSummaryMode;
  /** Total output budget in UTF-8 bytes (default 192 KiB). */
  totalBudgetBytes?: number;
  /** Per-document budget in UTF-8 bytes. Default: rank-skewed (8–24 KiB by rank). */
  documentBudgetBytes?: number;
  /**
   * Render complete documents: no per-document snippet/Youtube/prose caps, and
   * the default total budget becomes the hard artifact cap. Used to produce
   * the sanitized full-rendering overflow artifact.
   */
  full?: boolean;
  /**
   * Suppress the trailing `> Content truncated at output budget.` note. The
   * `truncated` flag is still returned; the caller owns emitting a richer
   * notice (e.g. the web_search assembly path's unified `Showing N of M` line).
   */
  suppressTruncationNote?: boolean;
}

type BlockType = 'heading' | 'code' | 'table' | 'blockquote' | 'list' | 'prose';

/**
 * Per-document byte budget scaled to the number of results, so a data-rich
 * document (e.g. a full statistical table) is not truncated at a fixed 8 KiB
 * cap when few results share the total budget, while many results each stay
 * within a bounded share. Clamped to [floor, ceiling]; the total budget still
 * caps the overall output. Used only when the caller does not pass an explicit
 * documentBudgetBytes.
 */
export function adaptiveDocumentBudget(resultCount: number, totalBudget: number): number {
  if (resultCount <= 0) return DEFAULT_DOCUMENT_BUDGET_BYTES;
  const share = Math.floor((totalBudget * ADAPTIVE_TOTAL_UTILIZATION) / resultCount);
  if (share < DEFAULT_DOCUMENT_BUDGET_BYTES) return DEFAULT_DOCUMENT_BUDGET_BYTES;
  if (share > DOCUMENT_BUDGET_CEILING_BYTES) return DOCUMENT_BUDGET_CEILING_BYTES;
  return share;
}

/**
 * Per-rank document byte budget with a descending skew: rank-1 gets ~1.5x the
 * average share tapering linearly to ~0.6x for the last rank, so the most
 * important top-ranked results get more room before the sequential-fill spill
 * truncates them. Weights are normalized to the same utilization as the uniform
 * allocation, so the pre-clamp total targets `totalBudget * ADAPTIVE_TOTAL_UTILIZATION`.
 * Each share is clamped to [floor, ceiling]; when many results are clamped to
 * the floor the aggregate may exceed the target — callers should apply
 * clamp-aware normalization when the sum of all rank budgets matters.
 * Used when the caller does not pass an explicit `documentBudgetBytes`.
 */
export function rankDocumentBudget(rank: number, resultCount: number, totalBudget: number): number {
  if (resultCount <= 0) return DEFAULT_DOCUMENT_BUDGET_BYTES;
  const topWeight = 1.5;
  const bottomWeight = 0.6;
  const weight =
    resultCount === 1
      ? (topWeight + bottomWeight) / 2
      : topWeight + (bottomWeight - topWeight) * (rank / (resultCount - 1));
  const weightSum = resultCount * ((topWeight + bottomWeight) / 2);
  const share = Math.floor((totalBudget * ADAPTIVE_TOTAL_UTILIZATION * weight) / weightSum);
  if (share < DEFAULT_DOCUMENT_BUDGET_BYTES) return DEFAULT_DOCUMENT_BUDGET_BYTES;
  if (share > DOCUMENT_BUDGET_CEILING_BYTES) return DOCUMENT_BUDGET_CEILING_BYTES;
  return share;
}

interface Block {
  type: BlockType;
  text: string;
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Convert / strip raw HTML into markdown (scripts/styles/nav removed first). */
function stripRawHtml(markdown: string): string {
  let text = markdown;
  // Remove genuinely unsafe/structural subtrees — never rendered (scripts,
  // styles, navigation, inert template blocks) — and strong site chrome
  // (header branding, footers, forms). `<aside>` is deliberately NOT removed
  // wholesale: it frequently carries meaningful secondary/highlighted content
  // (e.g. an experimental-limitation note) which must survive as safe plain
  // text. Its visible text still flows through the same tag-stripping and
  // entity re-escaping below, so it can never become active HTML.
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  text = text.replace(/<nav\b[^>]*>[\s\S]*?<\/nav\s*>/gi, '');
  text = text.replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, '');
  text = text.replace(/<header\b[^>]*>[\s\S]*?<\/header\s*>/gi, '');
  text = text.replace(/<footer\b[^>]*>[\s\S]*?<\/footer\s*>/gi, '');
  text = text.replace(/<form\b[^>]*>[\s\S]*?<\/form\s*>/gi, '');
  // Block boundaries to newlines (headings handled before the generic close so
  // `</h2>` is not consumed before the heading conversion).
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // Headings to markdown first — needs the closing `</hN>` tag intact.
  text = text.replace(
    /<h([1-6])\b[^>]*>(.*?)<\/h\1\s*>/gi,
    (_m: string, level: string, inner: string) => {
      const content = inner.replace(/<[^>]+>/g, '').trim();
      return `\n\n${'#'.repeat(Number(level))} ${content}\n\n`;
    },
  );
  text = text.replace(/<\/(?:p|div|li|tr)\s*>/gi, '\n');
  // Links: only http(s) targets become markdown links; anything else renders
  // its visible label only, so no active javascript:/data:/file: link is
  // ever generated from raw HTML.
  text = text.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a\s*>/gi,
    (_m: string, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, '').trim();
      const trimmedHref = href.trim();
      return /^https?:\/\//i.test(trimmedHref) ? `[${label}](${trimmedHref})` : label;
    },
  );
  // Inline emphasis / code.
  text = text.replace(/<(?:strong|b)\b[^>]*>(.*?)<\/(?:strong|b)\s*>/gi, '**$1**');
  text = text.replace(/<(?:em|i)\b[^>]*>(.*?)<\/(?:em|i)\s*>/gi, '*$1*');
  text = text.replace(/<code\b[^>]*>(.*?)<\/code\s*>/gi, '`$1`');
  // Strip any remaining tags.
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, '');
  // Decode common entities after tag removal. Re-escape any `<`/`>` that
  // survive so a decoded `&lt;img ...&gt;` can never reactivate as raw active
  // HTML in the output — it stays inert escaped text.
  return (
    text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Restore line-leading `&gt;` (a markdown blockquote marker) back to `>`.
      // Mid-line `&gt;` stays escaped; only a blockquote marker at line start is
      // reinstated, which is inert markdown and never an HTML tag.
      .replace(/^&gt;(?=\s|$)/gm, '>')
  );
}

interface InlineLinkScan {
  link: { label: string; url: string; end: number } | null;
  /** Index one past the furthest character examined (valid even when `link` is null). */
  scannedTo: number;
}

/**
 * Scan a markdown inline link `[label](url)` starting at `text[start]` (which
 * must be `[`). Handles nested bracket labels (`[a [b] c]`) and parenthesized
 * URLs (`(https://x/a(b)c)`) with backslash escapes. Returns the label, url
 * and the end index of the closing `)`, or `null` when the construct is not a
 * complete markdown link. `scannedTo` reports how far the scan advanced so
 * callers can skip re-scanning a region already proven to contain no link.
 */
function scanInlineLink(text: string, start: number): InlineLinkScan {
  // Balance nested `[`/`]` to locate the label's closing `]`, honouring
  // backslash escapes (`\]` is a literal `]` inside the label, not the closer).
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    const c = text[i] ?? '';
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (i >= text.length || text[i] !== ']') {
    return { link: null, scannedTo: text.length };
  }
  const labelEnd = i;
  if (text[labelEnd + 1] !== '(') {
    return { link: null, scannedTo: labelEnd + 1 };
  }

  // Balance `(`/`)` (honouring `\(` / `\)`) to locate the URL's closing `)`.
  const urlStart = labelEnd + 2;
  let parenDepth = 0;
  let j = urlStart;
  for (; j < text.length; j++) {
    const c = text[j] ?? '';
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '(') parenDepth++;
    else if (c === ')') {
      if (parenDepth === 0) break;
      parenDepth--;
    }
  }
  if (j >= text.length || text[j] !== ')') {
    return { link: null, scannedTo: text.length };
  }

  return {
    link: {
      label: unescapeLabel(text.slice(start + 1, labelEnd)),
      url: text.slice(urlStart, j),
      end: j,
    },
    scannedTo: j + 1,
  };
}

/** Resolve backslash escapes inside a label so `\]`, `\[`, `\\` render literally. */
function unescapeLabel(label: string): string {
  return label.replace(/\\([[\]\\])/g, '$1');
}

/**
 * Neutralize inline markdown links whose target scheme is not http(s): render
 * only the visible label so no active javascript:/data:/file: link is ever
 * emitted. Safe http(s) links are preserved. Applied to body and generated
 * summary prose; code fences are excluded (they render as inert code). A
 * scanner (not a regex) is used so nested bracket labels and parenthesized
 * URLs are parsed correctly.
 */
export function sanitizeMarkdownLinks(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? '';
    if (c !== '[') {
      out += c;
      i++;
      continue;
    }
    const scan = scanInlineLink(text, i);
    if (scan.link === null) {
      if (scan.scannedTo >= text.length) {
        // No complete link exists from here to end-of-text (no closing `]` or
        // `)` was found), so emit the rest verbatim and stop re-scanning.
        out += text.slice(i);
        break;
      }
      out += text.slice(i, scan.scannedTo);
      i = scan.scannedTo;
      continue;
    }
    const trimmed = scan.link.url.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      out += text.slice(i, scan.link.end + 1);
    } else {
      out += scan.link.label;
    }
    i = scan.link.end + 1;
  }
  return out;
}

/** Render every inline markdown link as its visible label (title normalization). */
function stripMarkdownLinks(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? '';
    if (c !== '[') {
      out += c;
      i++;
      continue;
    }
    const scan = scanInlineLink(text, i);
    if (scan.link === null) {
      if (scan.scannedTo >= text.length) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, scan.scannedTo);
      i = scan.scannedTo;
      continue;
    }
    out += scan.link.label;
    i = scan.link.end + 1;
  }
  return out;
}

/**
 * Deconflict citation-shaped text `[N-M]` from untrusted provider content so it
 * cannot be mistaken for (or forged as) one of the formatter's own `[N-M]`
 * citations. Escapes the opening bracket (`[2-999]` → `\[2-999]`), keeping the
 * text literal in markdown while leaving it clearly distinct from the
 * citations the formatter appends. Applied to all non-code text (title, body,
 * prose, lists, tables, summaries); code fences stay literal and inert.
 */
function escapeCitationShaped(text: string): string {
  return text.replace(/\[(\d+)-(\d+)\]/g, '\\[$1-$2]');
}

/** Truncate to a byte budget without splitting a UTF-8 code point. */
function truncateUtf8(text: string, budgetBytes: number): string {
  if (utf8Length(text) <= budgetBytes) return text;
  let out = '';
  let len = 0;
  for (const ch of text) {
    const b = utf8Length(ch);
    if (len + b > budgetBytes) break;
    out += ch;
    len += b;
  }
  return out;
}

/** Normalize arbitrary untrusted text to safe plain inline text: strip raw
 * HTML (with decoded entities kept inert), render all markdown links as their
 * visible label, drop inline emphasis markers, and collapse whitespace. No
 * active link/HTML markup survives. */
function safePlainText(text: string): string {
  if (!text) return '';
  return escapeCitationShaped(
    stripMarkdownLinks(stripRawHtml(text)).replace(/[*`]/g, '').replace(/\s+/g, ' ').trim(),
  );
}

/** Normalize untrusted metadata label text (backend names, upstream engine
 * names, source-basis / date strings) to inert plain text: strips HTML,
 * collapses existing markdown links to their visible label, then escapes any
 * remaining bracket/paren/emphasis markdown-active characters so the label
 * can never complete a link/image construct — including when the caller
 * wraps it in its own literal `[...]` delimiters. */
function escapeMarkdownMetadataLabel(text: string): string {
  if (!text) return '';
  const cleaned = stripMarkdownLinks(stripRawHtml(text));
  const escaped = cleaned.replace(/[[\]()`*_!\\]/g, (c) => `\\${c}`);
  return escaped.replace(/\s+/g, ' ').trim();
}

/** Safe plain-text title for the header (never an active link). */
function safeInlineTitle(title: string): string {
  if (!title) return '';
  return escapeCitationShaped(stripMarkdownLinks(stripRawHtml(title)).replace(/\s+/g, ' ').trim());
}

/** Return the URL only when it is a clean http(s) absolute URL safe to emit as
 * a clickable markdown link target; otherwise return '' (omit). Rejects any
 * scheme or character that could break out of the markdown link construct. */
function safeUrlForLink(url: string): string {
  const t = url.trim();
  return /^https?:\/\/[^\s()[\]<>]+$/i.test(t) ? t : '';
}

/**
 * Clean result text before block splitting: strip/convert raw HTML first, then
 * strip site navigation/footer boilerplate via the shared markdown cleaner,
 * then neutralize dangerous markdown links. Markdown structure (headings,
 * lists, tables, blockquotes, code fences) is preserved.
 */
const BOILERPLATE_SECTION_RE =
  /^\s*#{1,6}\s+(?:related posts?|related articles?|subscribe|newsletter|sign\s*up|join\s+our|comments?|tags?|author|about(?:\s+(?:the\s+)?author)?|share(?:\s+this\s+article)?|follow\s+us|popular posts?|most popular|latest|quick links?|read more|you may also like|funding|acknowledgments?|acknowledgements?|rights and permissions|rights|legal|footer|navigation|skip navigation)\s*$/i;

/**
 * Remove explicit article-chrome sections. A chrome section starts at a
 * matching heading of depth N and is dropped until a heading of depth <= N
 * (same-or-higher) ends it, so nested chrome sub-sections are not leaked and
 * the first real content heading after the chrome is preserved.
 */
function stripBoilerplateSections(markdown: string): string {
  const lines = markdown.split('\n');
  const kept: string[] = [];
  let fence: '```' | '~~~' | null = null;
  let dropDepth: number | null = null;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (fence !== null) {
      kept.push(line);
      if (trimmed.startsWith(fence)) fence = null;
      continue;
    }
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      fence = trimmed.startsWith('```') ? '```' : '~~~';
      kept.push(line);
      continue;
    }
    const depthMatch = /^\s*(#{1,6})\s+\S/.exec(line);
    const cap = depthMatch?.[1];
    const depth = cap === undefined ? null : cap.length;
    if (depth !== null) {
      // A same-or-higher heading closes an open chrome section.
      if (dropDepth !== null && depth <= dropDepth) dropDepth = null;
      // Only start dropping when not already inside a chrome section.
      if (dropDepth === null && BOILERPLATE_SECTION_RE.test(line)) dropDepth = depth;
      if (dropDepth !== null) continue; // chrome heading + its content dropped
      kept.push(line);
    } else if (dropDepth !== null) {
      continue; // inside a dropped chrome section
    } else {
      kept.push(line);
    }
  }
  return kept.join('\n');
}

/** Strip standalone plain-text (non-linked) skip/back accessibility controls. */
function stripPlainNavLines(markdown: string): string {
  return markdown
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !/^(?:skip to (?:content|navigation|main|text)|back to top)\b[.:]?$/i.test(t);
    })
    .join('\n');
}

/** Remove standalone image remnants only (never inline prose/images or code).
 * Deliberately no content-fingerprint dedup: identical prose paragraphs may
 * both be substantive scientific content and must both survive. Repeated
 * navigation/footer chrome is removed by structural rules (headings, link
 * grids), not by matching arbitrary repeated text. */
function stripImageRemnants(markdown: string): string {
  const lines = markdown.split('\n');
  const filtered: string[] = [];
  let inCodeFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) inCodeFence = !inCodeFence;
    const standaloneImage = /^!\[[^\]]*\]\([^)]*\)$/.test(trimmed);
    if (!inCodeFence && standaloneImage) continue;
    filtered.push(line);
  }
  return filtered.join('\n');
}

function sanitizeOutsideFences(markdown: string): string {
  const parts = markdown.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  return parts
    .map((part, index) => (index % 2 === 1 ? part : sanitizeMarkdownLinks(part)))
    .join('');
}

function cleanMarkdownOutsideFences(markdown: string): string {
  const standaloneLink = /^\s*(\[[^\]]+\]\([^)]+\))\s*$/;
  const protectedLink = '__SEARCH_MCP_STANDALONE_LINK__';
  const match = standaloneLink.exec(markdown);
  const withProtectedLink = match ? markdown.replace(standaloneLink, protectedLink) : markdown;
  const cleaned = stripNavigationMarkdown(stripRawHtml(stripPlainNavLines(withProtectedLink)));
  return match ? cleaned.replace(protectedLink, match[1] ?? '') : cleaned;
}

export function cleanResultMarkdown(text: string): string {
  if (!text) return '';
  // Provider content may include literal examples in either fence form. Never
  // parse or rewrite fence contents; cleanup applies to surrounding prose only.
  const segments = text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  const raw = segments
    .map((segment, index) => (index % 2 === 1 ? segment : cleanMarkdownOutsideFences(segment)))
    .filter((segment) => segment.length > 0)
    .join('\n\n');
  return sanitizeOutsideFences(stripImageRemnants(stripBoilerplateSections(raw)));
}

/**
 * Common abbreviations after which a `.` is not a sentence boundary.
 * Matches the word immediately before the period (case-insensitive).
 */
const ABBREVIATION_RE =
  /^(?:e\.g|i\.e|etc|dr|mr|mrs|ms|st|vs|fig|al|approx|dept|est|inc|ltd|co|corp|assn|univ|no|nos|pp|vol|vols|jr|sr|prof|rev|gen|col|maj|capt|sgt|lt|cmdr|adm|hon|sen|gov|pres|supt|det|ft|in|oz|lb|lbs|kg|km|mi|mph|rpm|min|max|avg|temp|chap|sec|ed|eds|trans|anon|cf|u\.s|u\.k)$/i;

function lastWhitespaceBefore(text: string, index: number): number {
  for (let k = index - 1; k >= 0; k--) {
    if (/\s/.test(text[k] ?? '')) return k;
  }
  return -1;
}

/**
 * Deterministic sentence splitter that avoids obvious false splits:
 * decimals, version numbers, common abbreviations, URLs, numbered list
 * markers. Trailing punctuation runs (`...`, `?!`) stay attached.
 */
export function splitIntoSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    const next = text[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue;

    if (ch === '.') {
      const prev = text[i - 1];
      const nextNonSpaceMatch = /^\s*(\S)/.exec(text.slice(i + 1));
      const nextNonSpace = nextNonSpaceMatch?.[1];

      if (
        prev !== undefined &&
        /\d/.test(prev) &&
        nextNonSpace !== undefined &&
        /\d/.test(nextNonSpace)
      ) {
        continue;
      }

      if (prev !== undefined && /\d/.test(prev) && /^\s*\d{1,3}\s*$/.test(text.slice(start, i))) {
        continue;
      }

      const wordStart = lastWhitespaceBefore(text, i) + 1;
      const word = text.slice(wordStart, i);
      const wordLower = word.toLowerCase();
      if (
        (wordLower === 'u.s' || wordLower === 'u.k') &&
        nextNonSpace !== undefined &&
        /^[A-Z]/.test(nextNonSpace)
      ) {
        // fall through to boundary handling
      } else if (ABBREVIATION_RE.test(word)) {
        continue;
      }
    }

    let end = i + 1;
    while (end < text.length && /[.!?]/.test(text[end] ?? '')) end++;
    const sentence = text.slice(start, end).trim();
    if (sentence.length > 0) sentences.push(sentence);
    start = end;
    i = end - 1;
  }

  const tail = text.slice(start).trim();
  if (tail.length > 0) sentences.push(tail);
  return sentences;
}

function blockTypeOf(line: string): BlockType {
  const t = line.trim();
  if (t.startsWith('```') || t.startsWith('~~~')) return 'code';
  if (/^\s*>\s?/.test(line)) return 'blockquote';
  if (/^\s*(?:[-*+]|\d+\.)\s+/.test(t)) return 'list';
  if (/^#{1,6}\s+\S/.test(t)) return 'heading';
  return 'prose';
}

/** A markdown table separator row: `|---|`, `--- | ---`, `:---:|---:`, etc. */
function isTableSeparator(line: string): boolean {
  const cells = line
    .trim()
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

/** Number of table columns in a row, whether or not it carries outer pipes
 * (`| a | b |` and `a | b` both count as 2). Used to keep an open table
 * absorbing only genuine row-shaped lines and to require a real header. */
function tableRowColumnCount(line: string): number {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').length;
}

/** Detect the start of a markdown table at line `i`: a header row (leading-`|`
 * or bare `header | header`) immediately followed by a valid separator row.
 * A lone pipe-led or pipe-containing line with no separator below it is never
 * treated as a table — it stays ordinary prose. */
function isTableStart(lines: string[], i: number): boolean {
  const line = lines[i];
  if (line === undefined) return false;
  const t = line.trim();
  if (!t.includes('|')) return false;
  const next = lines[i + 1];
  return next !== undefined && isTableSeparator(next);
}

/** Group markdown into block units. Code fences (` ``` ` or `~~~`) / tables /
 * lists / blockquotes / headings stay whole; prose is split on blank lines. */
interface FenceState {
  char: '`' | '~';
  len: number;
}

/** A closing fence line: optional leading whitespace, a run of the same
 * marker character at least as long as the opener, then only whitespace. */
function isClosingFence(line: string, fence: FenceState): boolean {
  const t = line.trim();
  const run = (fence.char === '`' ? /^`+/ : /^~+/).exec(t);
  if (run === null) return false;
  const runText = run[0];
  if (runText.length < fence.len) return false;
  return /^\s*$/.test(t.slice(runText.length));
}

export function splitIntoBlocks(markdown: string): Block[] {
  const lines = markdown.split('\n');
  const blocks: Block[] = [];
  let current: { type: BlockType; lines: string[] } | null = null;
  let fence: FenceState | null = null;

  const flush = (): void => {
    if (current?.lines.some((l) => l.trim().length > 0) === true) {
      blocks.push({ type: current.type, text: current.lines.join('\n') });
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (fence !== null) {
      current?.lines.push(line);
      if (isClosingFence(line, fence)) fence = null;
      continue;
    }
    if (line.trim().length === 0) {
      // Markdown permits a blank line inside an indented list-item continuation.
      // Keep it attached; ordinary paragraphs (non-indented next line) split.
      const next = lines[i + 1] ?? '';
      const keepsList =
        current?.type === 'list' &&
        next.length - next.trimStart().length >= 2 &&
        !/^(?:[-*+] |\d+\. )/.test(next.trimStart());
      if (keepsList) {
        current?.lines.push(line);
      } else {
        flush();
      }
      continue;
    }
    const t = line.trim();
    const openerBacktick = /^`{3,}/.exec(t);
    const openerTilde = /^~{3,}/.exec(t);
    const opener = openerBacktick ?? openerTilde;
    if (opener !== null) {
      flush();
      current = { type: 'code', lines: [line] };
      fence = { char: openerBacktick !== null ? '`' : '~', len: opener[0].length };
      continue;
    }
    // Indented, marker-less lines are Markdown list continuations. Keep them
    // attached even after a blank line; ordinary unindented prose below list
    // remains a separate block/citation.
    if (
      current !== null &&
      current.type === 'list' &&
      line.length - line.trimStart().length >= 2 &&
      !/^(?:[-*+] |\d+\. )/.test(line.trimStart())
    ) {
      current.lines.push(line);
      continue;
    }
    // Stay inside an already-open table only while lines are still row-shaped:
    // they must contain a pipe and split into the same column count as the
    // table's header. A non-pipe or differently-shaped line ends the table so
    // it becomes its own block — never absorbed into the table's citation.
    if (current !== null && current.type === 'table') {
      const headerCols = tableRowColumnCount(current.lines[0] ?? '');
      if (line.trim().includes('|') && tableRowColumnCount(line) === headerCols) {
        current.lines.push(line);
        continue;
      }
      flush();
    }
    if (isTableStart(lines, i)) {
      flush();
      current = { type: 'table', lines: [line] };
      continue;
    }
    const type = blockTypeOf(line);
    if (current !== null && current.type === type) {
      current.lines.push(line);
    } else {
      flush();
      current = { type, lines: [] };
      current.lines.push(line);
    }
  }
  // Close malformed provider fences before rendering/citing. Matching the
  // opener's marker char and run length keeps code inert and ensures the
  // citation lands outside code.
  if (fence !== null && current !== null) {
    current.lines.push(fence.char.repeat(fence.len));
    fence = null;
  }
  flush();
  return blocks;
}

/** A rendered output unit without a finalized citation number. Citations are
 * assigned only when the unit is actually emitted, so units skipped by the
 * prose cap or byte budget never leave gaps in the `[N-M]` sequence.
 *
 * `join` is the separator emitted immediately before this unit's rendered
 * text, relative to the previous emitted unit: `''` for the first unit of a
 * document (the header already ends in a blank line), `'\n'` for the next line
 * within a block (e.g. the next list item), and `'\n\n'` for a blank line
 * before a new paragraph/block. A unit is one SEMANTIC BLOCK (prose paragraph,
 * single list item, blockquote paragraph, code fence, or table) rendered as
 * coherent text that carries exactly one trailing `[N-M]` citation — never a
 * per-sentence citation. `sentences` is the number of prose sentences in the
 * block (0 for headings/code/tables) used to enforce the snippet prose cap at
 * whole-block granularity, so a block that exceeds the remaining cap is skipped
 * whole rather than partially emitted. */
interface RenderUnit {
  text: string;
  prose: boolean;
  /** How the citation is attached: 'own-line' (code/table), 'inline'
   * (prose/list/blockquote), or 'none' (heading — never cited). */
  citation: 'own-line' | 'inline' | 'none';
  /** Separator emitted before this unit (see interface comment). */
  join: string;
  /** Prose sentence count in this block (0 for non-prose units). */
  sentences: number;
}

/** Render a block into citation-free output units. Citations are assigned at
 * emission time (see `formatDocument`), so this never consumes a citation
 * number for a unit that may later be dropped. Each returned unit is one
 * SEMANTIC BLOCK (prose paragraph, list item, blockquote paragraph, code
 * fence, or table) carrying exactly one citation at emission — never a
 * per-sentence citation. */
function renderBlock(block: Block): RenderUnit[] {
  const { type, text: rawText } = block;
  // Code fences are inert/atomic — never rewrite their contents. All other
  // block types get dangerous markdown links neutralized to their visible label
  // and any citation-shaped `[N-M]` text escaped so it cannot be forged as one
  // of our own citations. Code stays literal and inert.
  const text = type === 'code' ? rawText : escapeCitationShaped(sanitizeMarkdownLinks(rawText));
  const units: RenderUnit[] = [];

  if (type === 'heading') {
    units.push({ text, prose: false, citation: 'none', join: '\n\n', sentences: 0 });
  } else if (type === 'code' || type === 'table') {
    // Indivisible block: emit it intact, then place the citation on its own
    // line so the fenced-code closer / table is never altered. Not prose.
    units.push({ text, prose: false, citation: 'own-line', join: '\n\n', sentences: 0 });
  } else if (type === 'list') {
    // One unit per list item (one marker), with its sentences joined inline and
    // exactly one citation. Marker-less continuation lines attach to the item
    // above so they never render as floating bare lines. The next item starts
    // on its own line.
    const items: { text: string; sentences: number }[] = [];
    for (const itemLine of text.split('\n')) {
      const mm = /^(\s*(?:[-*+]|\d+\.))\s+(.*)$/.exec(itemLine);
      const sentences = mm ? splitIntoSentences(mm[2] ?? '') : splitIntoSentences(itemLine.trim());
      if (sentences.length === 0) continue;
      const normalized = sentences.join(' ');
      if (mm) {
        items.push({ text: `${mm[1] ?? ''} ${normalized}`, sentences: sentences.length });
      } else if (items.length > 0) {
        // Marker-less continuation: attach inline to the previous item.
        const last = items[items.length - 1];
        if (last !== undefined) {
          last.text += ' ' + normalized;
          last.sentences += sentences.length;
        }
      } else {
        items.push({ text: normalized, sentences: sentences.length });
      }
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item === undefined) continue;
      units.push({
        text: item.text,
        prose: true,
        citation: 'inline',
        join: i === 0 ? '\n\n' : '\n',
        sentences: item.sentences,
      });
    }
  } else if (type === 'blockquote') {
    // One blockquote block is one quoted paragraph (blank lines split blocks).
    // The `>` marker prefixes the single unit; all its sentences join inline and
    // carry exactly one citation.
    const inner = text
      .split('\n')
      .map((l) => l.replace(/^\s*>\s?/, ''))
      .join(' ');
    const sentences = splitIntoSentences(inner);
    if (sentences.length > 0) {
      units.push({
        text: `> ${sentences.join(' ')}`,
        prose: true,
        citation: 'inline',
        join: '\n\n',
        sentences: sentences.length,
      });
    }
  } else {
    // prose paragraph: one unit per paragraph with its sentences joined inline
    // and exactly one citation. Blank line before the paragraph is handled by
    // the emission's first-unit join.
    const sentences = splitIntoSentences(text);
    if (sentences.length > 0) {
      units.push({
        text: sentences.join(' '),
        prose: true,
        citation: 'inline',
        join: '\n\n',
        sentences: sentences.length,
      });
    }
  }

  return units;
}

const BACKEND_DISPLAY: Record<string, string> = {
  codex: 'Codex',
  brave: 'Brave',
  exa: 'Exa',
  duckduckgo: 'DuckDuckGo',
  searxng: 'SearXNG',
  tavily: 'Tavily',
  'ollama-search': 'Ollama Search',
};

/** Deterministic canonical order for the `via:` field's MCP backends. */
const BACKEND_ORDER = ['codex', 'brave', 'exa', 'tavily', 'searxng', 'duckduckgo', 'ollama-search'];

/**
 * Build the `via:` label: all MCP backends that surfaced this URL (deduped, in
 * deterministic order), marking the content donor (`result.source`) with
 * `(content)`, and appending SearXNG upstream engine names as bracketed
 * metadata after `SearXNG` (never body prose).
 */
function viaLabel(result: SearchResult): string {
  const set = new Set<string>();
  for (const e of result.engines ?? []) set.add(e);
  set.add(result.source);
  const known = new Set(BACKEND_ORDER);
  const ordered = [...BACKEND_ORDER].filter((b) => set.has(b));
  const unknown = [...set].filter((b) => !known.has(b)).sort((a, b) => a.localeCompare(b));
  const parts = [...ordered, ...unknown].map((b) => {
    const display =
      BACKEND_DISPLAY[b] ?? escapeMarkdownMetadataLabel(b).replace(/^./, (c) => c.toUpperCase());
    const upstream =
      b === 'searxng' && result.upstreamEngines && result.upstreamEngines.length > 0
        ? ` [${[...new Set(result.upstreamEngines)]
            .sort((x, y) => x.localeCompare(y))
            .map((u) => escapeMarkdownMetadataLabel(u))
            .join(', ')}]`
        : '';
    return `${display}${upstream}${b === result.source ? ' (content)' : ''}`;
  });
  return parts.join(', ');
}

function metadataLine(result: SearchResult): string {
  const parts: string[] = [`via: ${viaLabel(result)}`];
  if (result.age) {
    // Label the age origin honestly: fetched vs published vs unclassified. An
    // absent or 'unknown' ageKind must never be rendered as a publication
    // claim — it may be a crawl/fetch timestamp with no known origin.
    const label =
      result.ageKind === 'fetched'
        ? 'fetched'
        : result.ageKind === 'published'
          ? 'published'
          : 'date';
    parts.push(`${label}: ${escapeMarkdownMetadataLabel(result.age)}`);
  }
  // Only non-default content kinds are surfaced; a bare `snippet` is omitted.
  if (result.contentKind && result.contentKind !== 'snippet') {
    parts.push(`content: ${escapeMarkdownMetadataLabel(result.contentKind)}`);
  }
  if (result.sourceQuality) {
    // Honest, explainable quality label. The tier never implies correctness;
    // the basis names the reason. Absent basis gets a terse generic label.
    const basis = result.sourceBasis
      ? ` — ${escapeMarkdownMetadataLabel(result.sourceBasis)}`
      : ' — generic domain prior';
    parts.push(`quality: ${escapeMarkdownMetadataLabel(result.sourceQuality)}${basis}`);
  }
  return parts.join(' · ');
}

/** Collapse whitespace/case for redundancy detection (not for output). */
function normalizeDedupText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function buildDocumentContent(result: SearchResult): string {
  const parts: string[] = [];
  const description = result.description.trim();
  if (description.length > 0) parts.push(result.description);
  const extra = result.extraSnippet;
  if (extra !== null && extra.trim().length > 0) {
    // Prevent description + extraSnippet duplication: drop an extraSnippet that
    // is a substantial near-duplicate of the description (e.g. a provider
    // repeating its own snippet). Only redundant substantial text is removed.
    const extraNorm = normalizeDedupText(extra);
    const descNorm = normalizeDedupText(result.description);
    if (!(extraNorm.length >= 40 && descNorm.length > 0 && descNorm.includes(extraNorm))) {
      parts.push(extra);
    }
  }
  if (parts.length === 0 && result.title.trim().length > 0) parts.push(result.title);
  return parts.join('\n\n');
}

/**
 * Conservative navigation-only classifier used at the search-result seam.
 *
 * A candidate is navigation-only only when it HAD nonempty body/snippet input
 * but normal formatter cleaning leaves no substantive body (navigation, chrome,
 * or pure link-grid/footer only). Genuine title-only / empty-body provider
 * results are never flagged — those must survive as ordinary results. It is
 * content-based only: no URL/category heuristics can discard a legitimate page.
 */
export function isNavigationOnlySearchResult(result: SearchResult): boolean {
  // Decide only on the original body/snippet input, BEFORE any title fallback.
  // A title-only / empty-body result (even a linked or hostile title) is never
  // classified as navigation-only — it must survive as an ordinary result.
  const description = result.description.trim();
  const extra = result.extraSnippet;
  const hasBody = description.length > 0 || (extra !== null && extra.trim().length > 0);
  if (!hasBody) return false;
  const content = buildDocumentContent(result);
  if (content.trim().length === 0) return false;
  const cleaned = cleanResultMarkdown(content);
  return !hasSubstantiveBody(cleaned);
}

/** True when the cleaned body contains at least one substantive line. */
function hasSubstantiveBody(markdown: string): boolean {
  const lines = markdown.split('\n');
  for (const line of lines) {
    const t = line.trim();
    // Code block content is substantive page content, not navigation.
    if (t.startsWith('```') || t.startsWith('~~~')) return true;
    if (t.length === 0) continue;
    // Standalone link, image, or link-only list item (pure navigation / link grid).
    if (/^(?:\s*(?:[-*+]|\d+\.)\s+)?!?\[[^\]]*\]\([^)]*\)\s*$/.test(t)) continue;
    return true; // any other nonempty line (prose, heading, quote, list text) is substantive
  }
  return false;
}

/** True when content looks like a timestamped transcript (many `MM:SS` lines). */
function isTranscriptLike(text: string): boolean {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 6) return false;
  const timestamped = lines.filter((l) => /^\d{1,2}:\d{2}(?::\d{2})?\s/.test(l)).length;
  return timestamped / lines.length > 0.5;
}

function isYoutubeDomain(domain: string): boolean {
  return /(^|\.)youtube\.com$/i.test(domain) || /(^|\.)youtu\.be$/i.test(domain);
}

/** Trim a transcript-like body to the first few lines plus an honest note. */
function trimTranscript(content: string, maxLines = 4): { text: string; trimmed: boolean } {
  const lines = content.split('\n');
  const first = lines.slice(0, maxLines).join('\n');
  if (lines.length <= maxLines) return { text: content, trimmed: false };
  return { text: `${first}\n${TRANSCRIPT_NOTE}`, trimmed: true };
}

interface RenderedDocument {
  text: string;
  truncated: boolean;
}

function formatDocument(
  result: SearchResult,
  docIndex: number,
  aiSummary: AiSummaryMode,
  docBudget: number,
  full: boolean,
): RenderedDocument {
  // YouTube results never emit lengthy transcript-like payloads: cap their
  // per-document budget lower than normal results, regardless of caller budget.
  // `full` (complete artifact rendering) deliberately lifts the YouTube cap so
  // the artifact is a faithful copy of the whole sanitized body.
  const effectiveBudget = full
    ? docBudget
    : isYoutubeDomain(result.domain)
      ? Math.min(docBudget, YOUTUBE_DOCUMENT_BUDGET_BYTES)
      : docBudget;
  // Each document is followed by a `\n` separator in the overall output, so the
  // document's own content is budgeted one byte under the per-document cap. This
  // keeps a truncated section (header + body) + separator within docBudget.
  const docContentBudget = Math.max(0, effectiveBudget - 1);
  const title = safeInlineTitle(result.title);
  const metadata = metadataLine(result);
  const safeUrl = safeUrlForLink(result.url);
  // The title is rendered as safe plain text — it is never made into a
  // clickable link (so an untrusted title cannot break out of a link label).
  // A safe http(s) URL is emitted as a separate atomic `url:` line and only
  // when the whole header (index + title + url + meta) fits the budget. If it
  // cannot fit even with a minimal title, the URL is omitted entirely — never
  // truncated, so no partial/malformed link is ever produced.
  const indexPrefix = `## [${String(docIndex)}] `;
  const metaSuffix = `${metadata}\n\n`;
  let head = '';
  let truncated = false;

  if (safeUrl) {
    const urlLine = `url: ${safeUrl}\n`;
    // Atomic URL: only emit when index + (possibly minimal) title + url + meta
    // all fit. Shrink the title to make room for the URL before omitting it.
    const minHead = indexPrefix + '\n' + urlLine + metaSuffix;
    if (utf8Length(minHead) <= docContentBudget) {
      const availableTitle = Math.max(0, docContentBudget - utf8Length(minHead));
      const fitTitle = truncateUtf8(title, availableTitle);
      head = indexPrefix + fitTitle + '\n' + urlLine + metaSuffix;
      if (fitTitle !== title) truncated = true;
    }
    // else: even a minimal title cannot fit alongside the URL -> omit URL.
  }

  if (head === '') {
    // No safe URL (or it could not fit): render index + title + meta, shrinking
    // the title as needed. Never a link.
    const availableTitle = Math.max(
      0,
      docContentBudget - utf8Length(indexPrefix + '\n' + metaSuffix),
    );
    const fitTitle = truncateUtf8(title, availableTitle);
    head = indexPrefix + fitTitle + '\n' + metaSuffix;
    if (fitTitle !== title) truncated = true;
  }

  // Hard fallback: never exceed the per-document budget without splitting a
  // UTF-8 code point. This can only cut plain title/meta text — never a URL,
  // which is emitted atomically above or omitted.
  if (utf8Length(head) > docContentBudget) {
    head = truncateUtf8(head, docContentBudget);
    truncated = true;
  }
  let text = head;

  const content = cleanResultMarkdown(buildDocumentContent(result));
  // The lower YouTube document budget (above) applies to every YouTube URL,
  // but the transcript trim/note is content-driven: an ordinary multiline
  // YouTube snippet (not timestamped transcript text) must not be mislabeled
  // or have its lines dropped just because the domain is YouTube.
  const transcript = isTranscriptLike(content);
  const { text: transcriptContent, trimmed: transcriptTrimmed } = transcript
    ? trimTranscript(content)
    : { text: content, trimmed: false };
  if (transcriptTrimmed) truncated = true;
  const blocks = splitIntoBlocks(transcriptContent);
  const bodyUnits: RenderUnit[] = [];
  for (const block of blocks) {
    bodyUnits.push(...renderBlock(block));
  }

  // Native generated summary (untrusted prose): cleaned like source content
  // and rendered sentence-by-sentence, continuing the per-document citation
  // sequence. Never re-emits the title/body. Only for aiSummary=yes. The
  // summary gets its own separate prose allowance so it never consumes the
  // body excerpt quota, while sharing the same per-document byte budget.
  let summaryHeading: string | null = null;
  const summaryUnits: RenderUnit[] = [];
  if (aiSummary === 'yes') {
    const summary = cleanResultMarkdown(result.generatedSummary ?? '');
    const summaryBlocks = splitIntoBlocks(summary);
    if (summaryBlocks.length > 0) {
      const providerLabel = result.generatedSummaryProvider
        ? safePlainText(result.generatedSummaryProvider)
        : '';
      const displayProvider = providerLabel
        ? providerLabel.charAt(0).toUpperCase() + providerLabel.slice(1)
        : '';
      const provider = displayProvider ? ` (${displayProvider})` : '';
      summaryHeading = `### AI summary${provider}`;
      for (const block of summaryBlocks) {
        summaryUnits.push(...renderBlock(block));
      }
    }
  }

  // Citations are assigned only on emission, so units skipped by the prose cap
  // or byte budget never leave gaps in the `[N-M]` sequence. The prospective
  // citation is built from `m + 1` without mutating `m`; `m` advances only after
  // a unit is actually emitted, so a unit rejected by the byte budget never
  // consumes a phantom citation number. Headings carry no citation and never
  // advance the counter.
  let m = 0;
  const renderCited = (unit: RenderUnit): string => {
    if (unit.citation === 'none') return unit.text;
    const next = m + 1;
    const cite = ` [${String(docIndex)}-${String(next)}]`;
    return unit.citation === 'own-line'
      ? unit.text + '\n' + (unit.text.trimStart().startsWith('|') ? cite.trimStart() : cite)
      : unit.text + cite;
  };
  const commitCitation = (unit: RenderUnit): void => {
    if (unit.citation !== 'none') m++;
  };

  // Concise-prose guard: snippet-like documents (contentKind `snippet` or
  // unset) cap the number of rendered body prose/list/quote sentences so a
  // verbose body labeled as a snippet stays concise. Headings and atomic
  // code/table blocks are not prose and are not counted. `full`/`summary` keep
  // only the byte budget; `full` (artifact) disables the cap so the artifact is
  // a complete rendering.
  const isSnippetLike = result.contentKind === undefined || result.contentKind === 'snippet';
  const maxBodyProse = full
    ? Number.POSITIVE_INFINITY
    : isSnippetLike
      ? MAX_SNIPPET_PROSE_SENTENCES
      : Number.POSITIVE_INFINITY;
  let proseCount = 0;
  let firstBody = true;
  let emittedBody = false;
  for (const unit of bodyUnits) {
    if (unit.prose) {
      // Snippet prose cap is whole-block: a block that exceeds the remaining
      // allowance is skipped whole, never partially emitted.
      if (proseCount + unit.sentences > maxBodyProse) {
        truncated = true;
        continue;
      }
      proseCount += unit.sentences;
    }
    // Blocks are emitted whole: paragraph/list-item/quote inline, blank lines
    // separate paragraphs/blocks, list items line-break.
    const sep = firstBody ? '' : unit.join;
    firstBody = false;
    const cited = renderCited(unit);
    // Reserve one byte for the terminating newline appended after the last
    // emitted line, keeping the whole document within docContentBudget.
    const candidate = text + sep + cited;
    if (utf8Length(candidate) + 1 > docContentBudget) {
      truncated = true;
      break;
    }
    text = candidate;
    commitCitation(unit);
    emittedBody = true;
  }
  // Terminate the last emitted line (reserved by the +1 above). A single
  // trailing newline keeps the document separator a clean blank line. Only
  // when a body line was actually emitted: the header alone already ends in a
  // blank line, so appending a newline there would push past the budget.
  if (emittedBody) text += '\n';

  // Render the generated summary only when the heading plus at least the first
  // summary unit fit the remaining budget — never an empty `### AI summary`
  // heading and never an unlabeled summary body. The heading is not prose and
  // does not count toward the summary sentence allowance.
  if (summaryHeading !== null && summaryUnits.length > 0) {
    // Blank line before the heading, then the heading, then a newline before
    // the first summary sentence. Summary sentences join inline like body prose.
    const prefix = '\n' + summaryHeading + '\n';
    const remaining = docContentBudget - utf8Length(text) - utf8Length(prefix);
    const maxSummaryProse = full ? Number.POSITIVE_INFINITY : MAX_SUMMARY_PROSE_SENTENCES;
    let summaryBody = '';
    let summaryProse = 0;
    let firstSummary = true;
    let emittedAny = false;
    for (const unit of summaryUnits) {
      if (unit.prose) {
        // Whole-block allowance: a summary block that exceeds the remaining
        // summary sentence allowance is skipped whole.
        if (summaryProse + unit.sentences > maxSummaryProse) {
          truncated = true;
          continue;
        }
        summaryProse += unit.sentences;
      }
      const sep = firstSummary ? '' : unit.join;
      firstSummary = false;
      const cited = renderCited(unit);
      if (utf8Length(summaryBody + sep + cited) > remaining) {
        truncated = true;
        break;
      }
      summaryBody += sep + cited;
      emittedAny = true;
      commitCitation(unit);
    }
    if (emittedAny && remaining >= 0) {
      text += prefix + summaryBody;
    } else {
      truncated = true;
    }
  }

  return { text, truncated };
}

/**
 * Render ranked search results as bare Markdown. One `## [N]` section per
 * result in rank order, with deterministic citation `[N-M]` markers and
 * enforced output budgets.
 */

export interface FormatDetailedResult {
  /** The rendered Markdown (bounded when not `full`). */
  text: string;
  /** True when any byte/prose/cap limited the output. */
  truncated: boolean;
}

/** Hard cap for a complete overflow artifact (1 MiB). */
export const ARTIFACT_MAX_BYTES = 1024 * 1024;

function formatInternal(
  results: SearchResult[],
  options: MarkdownFormatOptions,
): FormatDetailedResult {
  const aiSummary: AiSummaryMode = options.aiSummary ?? 'no';
  const full = options.full === true;
  const totalBudget = options.totalBudgetBytes ?? DEFAULT_TOTAL_BUDGET_BYTES;
  const docBudget = options.documentBudgetBytes;
  const suppressNote = options.suppressTruncationNote === true;

  const note = TRUNCATION_NOTE + '\n';
  const noteBytes = suppressNote ? 0 : utf8Length(note);

  // Output must never exceed totalBudgetBytes — even for budgets smaller than
  // the heading or the truncation note. Content is capped below the total so
  // the truncation note can always be appended without exceeding it; when even
  // that is impossible, prefer a truncated heading (or empty string at zero).
  if (totalBudget <= 0) return { text: '', truncated: false };
  const contentBudget = Math.max(0, totalBudget - noteBytes);

  let text = '# Web search results\n\n';
  let truncated = false;

  // Pre-compute all per-rank budgets for clamp-aware normalization.
  // When many results are clamped to the floor, the raw sum may exceed
  // totalBudget * ADAPTIVE_TOTAL_UTILIZATION. Scale down proportionally
  // while respecting the floor so the aggregate stays within the target.
  const rankBudgets: number[] = [];
  for (let i = 0; i < results.length; i++) {
    rankBudgets.push(docBudget ?? rankDocumentBudget(i, results.length, totalBudget));
  }
  const targetSum = Math.floor(totalBudget * ADAPTIVE_TOTAL_UTILIZATION);
  const rawSum = rankBudgets.reduce((a, b) => a + b, 0);
  if (rawSum > targetSum) {
    const scale = targetSum / rawSum;
    for (let i = 0; i < rankBudgets.length; i++) {
      const scaled = Math.floor((rankBudgets[i] ?? 0) * scale);
      rankBudgets[i] = Math.max(scaled, DEFAULT_DOCUMENT_BUDGET_BYTES);
    }
  }

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result === undefined) continue;
    // Per-rank budget so top results get more room before the spill; an explicit
    // documentBudgetBytes overrides the skew for all ranks (backward-compatible).
    const budget = rankBudgets[i] ?? DEFAULT_DOCUMENT_BUDGET_BYTES;
    const { text: doc, truncated: dt } = formatDocument(result, i + 1, aiSummary, budget, full);
    truncated = truncated || dt;
    const candidate = text + doc + '\n';
    if (utf8Length(candidate) > contentBudget) {
      truncated = true;
      break;
    }
    text = candidate;
  }

  // Fit the accumulated content into the budget left after reserving the note.
  if (utf8Length(text) > contentBudget) {
    text = truncateUtf8(text, contentBudget);
    truncated = true;
  }
  if (truncated && !suppressNote && totalBudget >= noteBytes) text += note;

  return { text, truncated };
}

/** Detailed formatting entry point exposing truncation state (additive). */
export function formatWebSearchMarkdownDetailed(
  results: SearchResult[],
  options: MarkdownFormatOptions = {},
): FormatDetailedResult {
  const full = options.full === true;
  // In full (artifact) mode default to the hard artifact cap and give each
  // document a large per-document budget so only the total caps the output.
  const totalBudget = full
    ? (options.totalBudgetBytes ?? ARTIFACT_MAX_BYTES)
    : (options.totalBudgetBytes ?? DEFAULT_TOTAL_BUDGET_BYTES);
  // In full (artifact) mode a large per-document budget lets only the total cap
  // the output. In bounded mode a per-rank skewed budget is applied per rank in
  // formatInternal when the caller did not pin an explicit per-document budget.
  const docBudget = full
    ? (options.documentBudgetBytes ?? totalBudget)
    : options.documentBudgetBytes;
  return formatInternal(results, {
    ...options,
    full,
    totalBudgetBytes: totalBudget,
    ...(docBudget !== undefined ? { documentBudgetBytes: docBudget } : {}),
  });
}

/** Backward-compatible bounded Markdown entry point. */
export function formatWebSearchMarkdown(
  results: SearchResult[],
  options: MarkdownFormatOptions = {},
): string {
  return formatWebSearchMarkdownDetailed(results, options).text;
}
