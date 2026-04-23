import type { ContentElement } from '../types.js';

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const TABLE_ROW_RE = /^\|(.+)\|$/;
const FENCED_CODE_RE = /^```(\w*)/;
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g;
const LIST_ITEM_RE = /^(\s*)([-*]|\d+\.)\s+(.+)$/;
const INLINE_CODE_RE = /`([^`]+)`/g;

function countCols(row: string): number {
  return row.split('|').filter((s) => s.trim().length > 0).length;
}

function stripInlineCode(text: string): string {
  return text.replace(INLINE_CODE_RE, '$1');
}

export function extractElementsFromMarkdown(markdown: string): ContentElement[] {
  const elements: ContentElement[] = [];
  const lines = markdown.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Heading
    const headingMatch = trimmed.match(HEADING_RE);
    if (headingMatch) {
      elements.push({
        type: 'heading',
        level: headingMatch[1]!.length,
        text: headingMatch[2]!.trim(),
        id: null,
      });
      i += 1;
      continue;
    }

    // Fenced code block
    const fenceMatch = trimmed.match(FENCED_CODE_RE);
    if (fenceMatch) {
      const lang = fenceMatch[1] || null;
      const contentLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        contentLines.push(lines[i]!);
        i += 1;
      }
      elements.push({
        type: 'code',
        language: lang,
        content: contentLines.join('\n').trimEnd(),
      });
      i += 1; // skip closing ```
      continue;
    }

    // Table
    if (TABLE_ROW_RE.test(trimmed)) {
      const tableLines: string[] = [];
      while (i < lines.length && TABLE_ROW_RE.test(lines[i]!.trim())) {
        tableLines.push(lines[i]!.trim());
        i += 1;
      }
      // Skip separator line if present
      if (tableLines.length > 1 && /^\|[\s\-:|]+\|$/.test(tableLines[1]!)) {
        tableLines.splice(1, 1);
      }
      const rows = tableLines.length;
      const cols = rows > 0 ? countCols(tableLines[0]!) : 0;
      elements.push({
        type: 'table',
        markdown: tableLines.join('\n'),
        caption: null,
        rows,
        cols,
      });
      continue;
    }

    // List
    const listMatch = trimmed.match(LIST_ITEM_RE);
    if (listMatch) {
      const ordered = /^\d+\./.test(listMatch[2]!);
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!.trim();
        const m = l.match(LIST_ITEM_RE);
        if (!m) break;
        items.push(stripInlineCode(m[3]!));
        i += 1;
      }
      if (items.length > 0) {
        elements.push({ type: 'list', ordered, items });
      }
      continue;
    }

    // Image on its own line
    if (IMAGE_RE.test(trimmed)) {
      let m: RegExpExecArray | null;
      IMAGE_RE.lastIndex = 0;
      while ((m = IMAGE_RE.exec(trimmed)) !== null) {
        elements.push({
          type: 'image',
          src: m[2]!,
          alt: m[1]!,
          title: m[3] ?? null,
        });
      }
      i += 1;
      continue;
    }

    // Paragraph / text
    if (trimmed.length > 0) {
      const text = stripInlineCode(trimmed);
      if (text.length > 0) {
        elements.push({ type: 'text', text });
      }
    }

    i += 1;
  }

  return elements;
}
