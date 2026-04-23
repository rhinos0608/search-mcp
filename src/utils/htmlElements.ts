import type { ContentElement } from '../types.js';

function cellText(cell: Element): string {
  return cell.textContent.trim();
}

function tableToMarkdown(table: HTMLTableElement): { markdown: string; rows: number; cols: number } {
  const rows = table.querySelectorAll('tr');
  const lines: string[] = [];
  let maxCols = 0;

  rows.forEach((row, rowIdx) => {
    const cells = row.querySelectorAll('th, td');
    const texts = Array.from(cells).map(cellText);
    maxCols = Math.max(maxCols, texts.length);
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
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'img', 'pre', 'ul', 'ol', 'p', 'div',
]);

/** Block-level tags that, if present as children, mean we skip this element as a leaf. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'ul', 'ol', 'pre', 'blockquote',
]);

/** Tags to ignore entirely. */
const IGNORED_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'nav', 'header', 'footer']);

export function extractElementsFromHtml(document: Document): ContentElement[] {
  const elements: ContentElement[] = [];

  const candidates = Array.from(
    document.body.querySelectorAll(Array.from(TARGET_TAGS).join(',')),
  );

  for (const el of candidates) {
    // Skip if inside an ignored ancestor
    if (el.closest(Array.from(IGNORED_TAGS).join(','))) continue;

    // Skip if this element is itself ignored
    if (IGNORED_TAGS.has(el.tagName.toLowerCase())) continue;

    const tag = el.tagName.toLowerCase();

    // Skip nested tables/lists that are children of already-processed parents
    const parent = el.parentElement;
    if (parent && (parent.tagName.toLowerCase() === 'li' || parent.closest('table') || parent.closest('ul, ol'))) {
      // We still want to process the top-level container, so skip individual li/td children
      if (tag === 'p' || tag === 'div') continue;
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
          elements.push({ type: 'heading', level, text, id: headingId(el as HTMLHeadingElement) });
        }
        break;
      }

      case 'table': {
        const captionEl = el.querySelector('caption');
        const { markdown, rows, cols } = tableToMarkdown(el as HTMLTableElement);
        elements.push({
          type: 'table',
          markdown,
          caption: captionEl ? captionEl.textContent.trim() : null,
          rows,
          cols,
        });
        break;
      }

      case 'img': {
        const img = el as HTMLImageElement;
        elements.push({
          type: 'image',
          src: img.getAttribute('src'),
          alt: img.alt,
          title: img.getAttribute('title'),
        });
        break;
      }

      case 'pre': {
        const code = el.querySelector('code');
        const content = code?.textContent ?? el.textContent;
        const cls = code?.getAttribute('class') ?? undefined;
        elements.push({
          type: 'code',
          language: languageFromClass(cls),
          content: content.trim(),
        });
        break;
      }

      case 'ul':
      case 'ol': {
        const items = Array.from(el.querySelectorAll(':scope > li')).map(
          (li) => li.textContent.trim(),
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
            elements.push({ type: 'text', text });
          }
        }
        break;
      }
    }
  }

  return elements;
}
