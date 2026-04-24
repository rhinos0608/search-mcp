import type { ContentElement } from '../types.js';
import {
  MAX_ELEMENTS,
  MAX_RAW_ELEMENTS,
  MAX_TEXT_LENGTH,
  TRUNCATED_MARKER,
  truncateElementText,
} from './elementTruncation.js';

export { MAX_ELEMENTS, MAX_RAW_ELEMENTS, MAX_TEXT_LENGTH, TRUNCATED_MARKER };

function truncateText(text: string): string {
  return truncateElementText(text).value;
}

function cellText(cell: Element): string {
  return cell.textContent.trim();
}

function tableToMarkdown(table: HTMLTableElement): {
  markdown: string;
  rows: number;
  cols: number;
} {
  const rows = table.querySelectorAll('tr');

  // First pass: compute max columns across all rows
  let maxCols = 0;
  rows.forEach((row) => {
    const cells = row.querySelectorAll('th, td');
    maxCols = Math.max(maxCols, cells.length);
  });

  const lines: string[] = [];
  rows.forEach((row, rowIdx) => {
    const cells = row.querySelectorAll('th, td');
    const texts = Array.from(cells).map(cellText);
    lines.push(`| ${texts.join(' | ')} |`);
    if (rowIdx === 0) {
      lines.push(`|${' --- |'.repeat(maxCols)}`);
    }
  });

  return { markdown: lines.join('\n'), rows: rows.length, cols: maxCols };
}

function languageFromClass(cls: string | undefined): string | null {
  if (!cls) return null;
  const m = /(?:language|lang)-(\w+)/.exec(cls);
  return m?.[1] ?? null;
}

function headingId(el: HTMLHeadingElement): string | null {
  return el.getAttribute('id') ?? el.querySelector('a[id]')?.getAttribute('id') ?? null;
}

/** Tags we care about, in document order. */
const TARGET_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'img',
  'pre',
  'ul',
  'ol',
  'p',
  'div',
]);

/** Block-level tags that, if present as children, mean we skip this element as a leaf. */
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'ul',
  'ol',
  'pre',
  'blockquote',
]);

/** Tags to ignore entirely. */
const IGNORED_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'nav', 'header', 'footer']);

const TARGET_SELECTOR = Array.from(TARGET_TAGS).join(',');

function safeImageSrc(raw: string | null): string | null {
  if (raw === null) return null;
  const lower = raw.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('vbscript:')
  ) {
    return null;
  }
  return raw;
}

export function extractElementsFromHtml(document: Document): ContentElement[] {
  const elements: ContentElement[] = [];

  const candidates = Array.from(document.body.querySelectorAll(TARGET_SELECTOR));

  for (const el of candidates) {
    if (elements.length >= MAX_RAW_ELEMENTS) break;

    // Skip if inside an ignored ancestor
    if (el.closest(Array.from(IGNORED_TAGS).join(','))) continue;

    // Skip if this element is itself ignored
    if (IGNORED_TAGS.has(el.tagName.toLowerCase())) continue;

    const tag = el.tagName.toLowerCase();

    // Skip paragraphs/divs that are children of already-processed containers
    // (list items, table cells, or nested lists/tables)
    const parent = el.parentElement;
    if (parent && (tag === 'p' || tag === 'div')) {
      const insideContainer =
        parent.tagName.toLowerCase() === 'li' ||
        parent.closest('table') !== null ||
        parent.closest('ul, ol') !== null;
      if (insideContainer) continue;
    }

    switch (tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const level = parseInt(tag.slice(1), 10);
        const text = el.textContent.trim();
        if (text) {
          elements.push({
            type: 'heading',
            level,
            text: truncateText(text),
            id: headingId(el as HTMLHeadingElement),
          });
        }
        break;
      }

      case 'table': {
        const captionEl = el.querySelector('caption');
        const { markdown, rows, cols } = tableToMarkdown(el as HTMLTableElement);
        const truncatedMarkdown = truncateElementText(markdown);
        elements.push({
          type: 'table',
          markdown: truncatedMarkdown.value,
          caption: captionEl ? truncateText(captionEl.textContent.trim()) : null,
          rows,
          cols,
          ...(truncatedMarkdown.truncated && {
            truncated: truncatedMarkdown.truncated,
            originalLength: truncatedMarkdown.originalLength,
          }),
        });
        break;
      }

      case 'img': {
        const img = el as HTMLImageElement;
        const rawSrc = img.getAttribute('src');
        const src = document.baseURI && document.baseURI !== 'about:blank' ? img.src : rawSrc;
        elements.push({
          type: 'image',
          src: safeImageSrc(src),
          alt: truncateText(img.alt),
          title: truncateText(img.getAttribute('title') ?? ''),
        });
        break;
      }

      case 'pre': {
        const code = el.querySelector('code');
        const content = code?.textContent ?? el.textContent;
        const cls = code?.getAttribute('class') ?? undefined;
        const truncatedContent = truncateElementText(content.trim());
        elements.push({
          type: 'code',
          language: languageFromClass(cls),
          content: truncatedContent.value,
          ...(truncatedContent.truncated && {
            truncated: truncatedContent.truncated,
            originalLength: truncatedContent.originalLength,
          }),
        });
        break;
      }

      case 'ul':
      case 'ol': {
        const items = Array.from(el.querySelectorAll(':scope > li')).map((li) =>
          truncateText(li.textContent.trim()),
        );
        if (items.length > 0) {
          elements.push({ type: 'list', ordered: tag === 'ol', items });
        }
        break;
      }

      case 'p':
      case 'div': {
        // Only create a text element if this is a leaf block (no block children)
        const hasBlockChild = Array.from(el.children).some((child) =>
          BLOCK_TAGS.has(child.tagName.toLowerCase()),
        );
        if (!hasBlockChild) {
          const text = el.textContent.trim();
          if (text.length > 0) {
            const truncatedText = truncateElementText(text);
            elements.push({
              type: 'text',
              text: truncatedText.value,
              ...(truncatedText.truncated && {
                truncated: truncatedText.truncated,
                originalLength: truncatedText.originalLength,
              }),
            });
          }
        }
        break;
      }
    }
  }

  return elements;
}
