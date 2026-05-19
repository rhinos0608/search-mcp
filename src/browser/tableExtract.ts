import type { Page } from 'playwright-core';
import type { TableExtractConfig, TableExtractResult } from './types.js';
import { BrowserError } from './types.js';

/**
 * Extract structured data from HTML tables on the current page.
 * Uses page.evaluate() to parse tables directly in the browser context.
 */
export async function extractTables(
  page: Page,
  config: TableExtractConfig = {},
): Promise<TableExtractResult> {
  const maxTables = config.maxTables ?? 10;
  const includeCaptions = config.includeCaptions ?? true;
  const _flattenSpans = config.flattenSpans; void _flattenSpans; // reserved for future flatten implementation

  try {
    const result = await page.evaluate(
      ({ sel, max, captions }: {
        sel: string | undefined;
        max: number;
        captions: boolean;
      }) => {
        /* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
        const tables: {
          index: number;
          caption?: string;
          headers: string[];
          rows: Record<string, string>[];
          rowCount: number;
          columnCount: number;
          selector: string;
        }[] = [];

        // Find tables
        const tableElements = sel
          ? Array.from(document.querySelectorAll(sel))
          : Array.from(document.querySelectorAll('table'));

        const targetTables = tableElements.slice(0, max);

        targetTables.forEach((table, tableIdx) => {
          // Get caption
          let caption: string | undefined;
          if (captions) {
            const captionEl = table.querySelector('caption');
            if (captionEl) {
              caption = (captionEl.textContent || '').trim();
            }
          }

          // Build a selector for this table
          const selector = buildPath(table, tableIdx);

          // Get headers from <th> elements
          const headers: string[] = [];
          const thElements = table.querySelectorAll('th');
          if (thElements.length > 0) {
            thElements.forEach((th) => {
              headers.push(cleanText(th.textContent || ''));
            });
          } else {
            // Try first row as headers
            const firstRow = table.querySelector('tr');
            if (firstRow) {
              const cells = firstRow.querySelectorAll('td, th');
              cells.forEach((cell) => {
                headers.push(cleanText(cell.textContent || ''));
              });
            }
          }

          if (headers.length === 0) return; // Skip empty tables

          // Get data rows (skip header row if it used <th>)
          const rows = Array.from(table.querySelectorAll('tr'));
          const dataRows: Record<string, string>[] = [];

          const startRow = headers.length > 0 ? 1 : 0;
          for (let i = startRow; i < rows.length; i++) {
            const row = rows[i];
            if (!row) continue;

            const cells = row.querySelectorAll('td, th');
            const cellTexts = Array.from(cells).map((cell) => cleanText(cell.textContent || ''));

            if (cellTexts.length === 0) continue;

            // Skip rows that are all-empty
            if (cellTexts.every((t) => !t)) continue;

            const rowData: Record<string, string> = {};

            // Map cells to headers
            for (let j = 0; j < Math.max(headers.length, cellTexts.length); j++) {
              const header = headers[j] || `Column ${String(j + 1)}`;
              const value = cellTexts[j] || '';
              rowData[header] = value;
            }

            dataRows.push(rowData);
          }

          if (dataRows.length > 0 || headers.length > 0) {
            tables.push({
              index: tableIdx,
              headers,
              rows: dataRows,
              rowCount: dataRows.length,
              columnCount: headers.length,
              selector,
              ...(caption ? { caption } : {}),
            });
          }
        });

        return {
          tables,
          totalTables: tableElements.length,
        };

        function cleanText(text: string): string {
          return text.replace(/\s+/g, ' ').trim();
        }

        function buildPath(el: Element, idx: number): string {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className && typeof el.className === 'string'
            ? `.${el.className.trim().split(/\s+/).join('.')}`
            : '';
          if (id) return `${tag}${id}`;
          if (cls) return `${tag}${cls}`;
          return `${tag}:nth-of-type(${String(idx + 1)})`;
        }
      },
      { sel: config.selector, max: maxTables, captions: includeCaptions },
    );

    return result;
  } catch (err) {
    throw new BrowserError(
      `Table extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      'ACTION_FAILED',
    );
  }
}
