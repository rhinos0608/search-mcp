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
  const flattenSpans = config.flattenSpans ?? true;

  try {
    const result = await page.evaluate(
      ({
        sel,
        max,
        captions,
        flatten,
      }: {
        sel: string | undefined;
        max: number;
        captions: boolean;
        flatten: boolean;
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
          orientation?: 'horizontal' | 'vertical';
        }[] = [];

        /** Strip style/script/hidden elements from cell, return clean text. */
        function getCellText(cell: Element): string {
          const clone = cell.cloneNode(true) as Element;
          clone.querySelectorAll('style, script, link, meta').forEach((el) => {
            el.remove();
          });
          clone
            .querySelectorAll('[style*="display:none"], [style*="display: none"], [hidden]')
            .forEach((el) => {
              el.remove();
            });
          return clone.textContent || '';
        }

        function cleanText(text: string): string {
          return text.replace(/\s+/g, ' ').trim();
        }

        function buildPath(el: Element): string {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls =
            el.className && typeof el.className === 'string'
              ? `.${el.className.trim().split(/\s+/).join('.')}`
              : '';
          if (id) return `${tag}${id}`;
          if (cls) return `${tag}${cls}`;
          const parent = el.parentElement;
          const siblings = parent
            ? Array.from(parent.children).filter((s) => s.tagName === el.tagName)
            : [el];
          const pos = siblings.indexOf(el) + 1;
          return `${tag}:nth-of-type(${String(pos)})`;
        }

        // -- Filtering --

        // Boilerplate CSS class substrings (navbox, sidebar, infobox, metadata etc.)
        const BOILERPLATE_CLASSES = [
          'navbox',
          'sidebar',
          'vertical-navbox',
          'mbox-small',
          'ambox',
          'metadata',
          'noprint',
          'noprintlinks',
          'sistersitebox',
          'side-box',
          'infobox-above',
        ];

        // Find tables
        const tableElements = sel
          ? Array.from(document.querySelectorAll(sel))
          : Array.from(document.querySelectorAll('table'));

        // Filter out boilerplate, navbox, and hidden tables
        const filteredTables = tableElements.filter((table) => {
          const cls = (table.className || '').toLowerCase();
          if (BOILERPLATE_CLASSES.some((c) => cls.includes(c))) return false;
          const style = window.getComputedStyle(table);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (table.closest('.navbox, .sidebar, .vertical-navbox, .metadata, .noprint'))
            return false;
          return true;
        });

        const targetTables = filteredTables.slice(0, max);

        // -- Extraction --

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
          const selector = buildPath(table);

          // Detect infobox: vertical key→value layout (2-column, labels in first col)
          const tableCls = (table.className || '').toLowerCase();
          const allRows = Array.from(table.querySelectorAll('tr'));
          const isInfobox = tableCls.includes('infobox') || tableCls.includes('vcard');

          if (isInfobox) {
            const kvPairs: { key: string; value: string }[] = [];
            let hasPairs = false;

            for (const row of allRows) {
              const cells = row.querySelectorAll('th, td');
              if (cells.length >= 2) {
                const keyCell = cells[0];
                const valCell = cells[1];
                if (!keyCell || !valCell) continue;
                const key = cleanText(getCellText(keyCell));
                const value = cleanText(getCellText(valCell));
                if (key && value) {
                  kvPairs.push({ key, value });
                  hasPairs = true;
                }
              } else if (cells.length === 1) {
                const cell = cells[0];
                if (!cell) continue;
                const text = cleanText(getCellText(cell));
                if (text && text.length < 100) {
                  kvPairs.push({ key: text, value: '' });
                }
              }
            }

            if (hasPairs) {
              const headers = ['Key', 'Value'];
              const dataRows = kvPairs.map(({ key, value }) => ({
                Key: key,
                Value: value,
              }));
              tables.push({
                index: tableIdx,
                headers,
                rows: dataRows,
                rowCount: dataRows.length,
                columnCount: 2,
                selector,
                orientation: 'vertical',
                ...(caption ? { caption } : {}),
              });
              return;
            }
          }

          // -- Standard (horizontal) table extraction --

          const trRows = Array.from(table.querySelectorAll('tr'));
          if (trRows.length === 0) return;

          let headers: string[];
          let dataGrid: string[][];

          if (flatten) {
            // Build 2D grid resolving colspan/rowspan
            const occupied = new Set<string>();
            const grid: string[][] = [];

            for (let r = 0; r < trRows.length; r++) {
              const row = trRows[r];
              if (!row) continue;
              const cells = Array.from(row.querySelectorAll('td, th'));
              if (!grid[r]) grid[r] = [];
              let col = 0;
              for (const cell of cells) {
                // Skip occupied slots from rowspan/colspan above
                while (occupied.has(`${String(r)},${String(col)}`)) col++;
                const cs = Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10) || 1);
                const rs = Math.max(1, parseInt(cell.getAttribute('rowspan') || '1', 10) || 1);
                const text = cleanText(getCellText(cell));
                // Fill all spanned positions
                for (let sr = 0; sr < rs; sr++) {
                  for (let sc = 0; sc < cs; sc++) {
                    const gr = r + sr;
                    const gc = col + sc;
                    if (!grid[gr]) grid[gr] = [];
                    grid[gr][gc] = text;
                    occupied.add(`${String(gr)},${String(gc)}`);
                  }
                }
                col += cs;
              }
            }

            // Detect whether first row has real header cells
            const firstRowEl = trRows[0];
            const hasHeaderCells =
              firstRowEl !== undefined && Array.from(firstRowEl.querySelectorAll('th')).length > 0;
            if (hasHeaderCells) {
              headers = (grid[0] ?? []).map((h) => h || '');
              if (headers.length === 0 || headers.every((h) => !h)) return;
              dataGrid = grid.slice(1);
            } else {
              headers = [];
              dataGrid = (grid[0] ?? []).length > 0 ? grid : [];
            }
          } else {
            // No flatten — simple positional extraction (original behavior)
            const firstRow = trRows[0];
            headers = [];
            if (firstRow) {
              const cells = firstRow.querySelectorAll('th, td');
              cells.forEach((cell) => {
                headers.push(cleanText(getCellText(cell)));
              });
            }
            if (headers.length === 0) return;

            const firstRowThCount = firstRow ? firstRow.querySelectorAll('th').length : 0;
            const startRow = firstRowThCount > 0 ? 1 : 0;
            dataGrid = [];
            for (let i = startRow; i < trRows.length; i++) {
              const row = trRows[i];
              if (!row) continue;
              const cells = row.querySelectorAll('td, th');
              dataGrid.push(Array.from(cells).map((c) => cleanText(getCellText(c))));
            }
          }

          // Build data rows from grid
          const dataRows: Record<string, string>[] = [];
          for (const cellTexts of dataGrid) {
            if (cellTexts.length === 0) continue;
            if (cellTexts.every((t) => !t)) continue;
            const rowData: Record<string, string> = {};
            for (let j = 0; j < Math.max(headers.length, cellTexts.length); j++) {
              const header = headers[j] || `Column ${String(j + 1)}`;
              rowData[header] = cellTexts[j] || '';
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
              orientation: 'horizontal',
              ...(caption ? { caption } : {}),
            });
          }
        });

        return {
          tables,
          totalTables: filteredTables.length,
        };
      },
      { sel: config.selector, max: maxTables, captions: includeCaptions, flatten: flattenSpans },
    );

    return result;
  } catch (err) {
    throw new BrowserError(
      `Table extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      'ACTION_FAILED',
    );
  }
}
