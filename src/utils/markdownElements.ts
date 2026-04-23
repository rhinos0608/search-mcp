import type { ContentElement } from '../types.js';

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const TABLE_ROW_RE = /^\|(.+)\|$/;
const FENCED_CODE_RE = /^(```+)(\w*)/;
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
    const line = lines[i];
    if (line === undefined) {
      i += 1;
      continue;
    }
    const trimmed = line.trim();

    // Heading
    const headingMatch = HEADING_RE.exec(trimmed);
    if (headingMatch) {
      const levelMatch = headingMatch[1];
      const textMatch = headingMatch[2];
      if (levelMatch !== undefined && textMatch !== undefined) {
        elements.push({
          type: 'heading',
          level: levelMatch.length,
          text: textMatch.trim(),
          id: null,
        });
      }
      i += 1;
      continue;
    }

    // Fenced code block
    const fenceMatch = FENCED_CODE_RE.exec(trimmed);
    if (fenceMatch) {
      const openTicks = fenceMatch[1];
      const lang = fenceMatch[2] ?? null;
      if (openTicks !== undefined) {
        const contentLines: string[] = [];
        i += 1;
        while (i < lines.length) {
          const innerLine = lines[i];
          if (innerLine === undefined) break;
          const innerTrimmed = innerLine.trim();
          if (
            innerTrimmed.startsWith(openTicks) &&
            !/[^`]/.test(innerTrimmed.slice(openTicks.length))
          ) {
            break;
          }
          contentLines.push(innerLine);
          i += 1;
        }
        elements.push({
          type: 'code',
          language: lang,
          content: contentLines.join('\n').trimEnd(),
        });
        i += 1; // skip closing fence
        continue;
      }
    }

    // Table
    if (TABLE_ROW_RE.test(trimmed)) {
      const tableLines: string[] = [];
      while (i < lines.length) {
        const tableLine = lines[i];
        if (tableLine === undefined) break;
        if (!TABLE_ROW_RE.test(tableLine.trim())) break;
        tableLines.push(tableLine.trim());
        i += 1;
      }
      // Skip separator line if present
      const sepLine = tableLines[1];
      if (tableLines.length > 1 && sepLine !== undefined && /^\|[\s\-:|]+\|$/.test(sepLine)) {
        tableLines.splice(1, 1);
      }
      const rows = tableLines.length;
      const firstLine = tableLines[0];
      const cols = rows > 0 && firstLine !== undefined ? countCols(firstLine) : 0;
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
    const listMatch = LIST_ITEM_RE.exec(trimmed);
    if (listMatch) {
      const listTypeMatch = listMatch[2];
      const ordered = listTypeMatch !== undefined && /^\d+\./.test(listTypeMatch);
      const items: string[] = [];
      const indentMatch = listMatch[1];
      const baseIndent = indentMatch !== undefined ? indentMatch.length : 0;
      while (i < lines.length) {
        const l = lines[i];
        if (l === undefined) break;
        const trimmedLine = l.trim();
        if (trimmedLine.length === 0) {
          i += 1;
          break; // blank line ends the list
        }
        const m = LIST_ITEM_RE.exec(trimmedLine);
        if (m) {
          const itemMatch = m[3];
          if (itemMatch !== undefined) {
            items.push(stripInlineCode(itemMatch));
          }
          i += 1;
          continue;
        }
        // Check if indented continuation line for the current item
        const indentMatch = /^\s*/.exec(l);
        const lineIndent = indentMatch !== null ? indentMatch[0].length : 0;
        if (lineIndent > baseIndent && items.length > 0) {
          // Append to the last item
          const last = items[items.length - 1];
          if (last !== undefined) {
            items[items.length - 1] = last + ' ' + stripInlineCode(trimmedLine);
          }
          i += 1;
          continue;
        }
        break;
      }
      if (items.length > 0) {
        elements.push({ type: 'list', ordered, items });
      }
      continue;
    }

    // Image on its own line
    IMAGE_RE.lastIndex = 0;
    if (IMAGE_RE.test(trimmed)) {
      let m: RegExpExecArray | null;
      IMAGE_RE.lastIndex = 0;
      while ((m = IMAGE_RE.exec(trimmed)) !== null) {
        const src = m[2];
        const alt = m[1];
        if (src !== undefined && alt !== undefined) {
          elements.push({
            type: 'image',
            src,
            alt,
            title: m[3] ?? null,
          });
        }
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
