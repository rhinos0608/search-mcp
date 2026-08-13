/**
 * In-process PDF → markdown parser built on `pdf-parse` v2.
 *
 * Extracts paragraph-aware text as markdown, best-effort embedded images,
 * and best-effort tables. Never throws: on any failure it returns an empty
 * `ParsedDocument` with a structured warning.
 *
 * NOTE: This module must remain loadable without `@napi-rs/canvas` — no page
 * rasterization happens here. Screenshot-based multimodal extraction lives in
 * the VLM tier (Task 7).
 */
import type { PDFParse, ParseParameters } from 'pdf-parse';
import type { ParsedDocument } from './types.js';
import { logger } from '../../logger.js';

/** Maximum number of embedded images collected from a PDF. */
const MAX_IMAGES = 50;
/** Cumulative byte budget for collected embedded images. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// `pdf-parse` (and its native `@napi-rs/canvas` rasterizer) is loaded lazily so
// an always-loaded text/table path never crashes at module load if the dep is
// missing or unbuildable. `loadPdfParse` caches a single promise; on failure it
// resolves to `null` and callers degrade with a structured warning.
let pdfParseModulePromise: Promise<typeof import('pdf-parse') | null> | undefined;

async function loadPdfParse(): Promise<typeof import('pdf-parse') | null> {
  pdfParseModulePromise ??= (async () => {
    try {
      return await import('pdf-parse');
    } catch (err) {
      logger.warn({ err }, 'pdf-parse unavailable: PDF parsing disabled');
      return null;
    }
  })();
  return pdfParseModulePromise;
}

/**
 * Report whether the pdf-parse dependency can be loaded. Never throws: a
 * failed/cached load reports `false` (the same signal `parsePdf` uses to
 * degrade). NOTE: this only confirms the parser dependency loads — it does NOT
 * guarantee that native rasterizer operations such as `getScreenshot` will
 * succeed (those also need the bundled `@napi-rs/canvas` to work).
 */
export async function isPdfParseAvailable(): Promise<boolean> {
  return (await loadPdfParse()) !== null;
}

/** Guess the MIME type of embedded image bytes from their magic number. */
function sniffMime(data: Uint8Array): string {
  const len = data.length;
  if (len >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return 'image/png';
  }
  if (len >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (len >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return 'image/gif';
  }
  if (len >= 4 && data[0] === 0x42 && data[1] === 0x4d) {
    return 'image/bmp';
  }
  if (len >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

/** Render a `string[][]` table as a GitHub-flavored markdown pipe table. */
function tableToMarkdown(table: string[][]): string {
  const rows = table.filter((row) => row.some((cell) => cell.trim() !== ''));
  if (rows.length === 0) {
    return '';
  }
  const cols = Math.max(...rows.map((row) => row.length));
  const esc = (cell: string): string => cell.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

  const header = rows[0] ?? [];
  const headerLine = Array.from({ length: cols }, (_, i) => esc(header[i] ?? '')).join(' | ');
  const sep = Array.from({ length: cols }, () => '---').join(' | ');
  const body = rows
    .slice(1)
    .map((row) => Array.from({ length: cols }, (_, i) => esc(row[i] ?? '')).join(' | '));
  return ['| ' + headerLine + ' |', '| ' + sep + ' |', ...body.map((r) => '| ' + r + ' |')].join(
    '\n',
  );
}

/**
 * A single rasterized page image (PNG bytes).
 */
export interface RasterizedPage {
  page: number;
  png: Uint8Array;
}

/**
 * Rasterize PDF pages to PNG images for the opt-in multimodal (VLM) tier.
 *
 * Uses pdf-parse's `getScreenshot`, which renders pages via the bundled
 * `@napi-rs/canvas` (a hard dependency of pdf-parse). No new top-level canvas
 * import is added here, so this module stays loadable without canvas for the
 * always-loaded text/table path. Never throws: on any failure (canvas missing,
 * render error, empty input) it returns `[]` so the caller degrades gracefully.
 *
 * @param input  PDF file bytes (ArrayBuffer or Uint8Array).
 * @param opts   Optional limits; `maxPages` caps the number of pages rasterized
 *               and `scale` controls the render zoom (default 1).
 */
export async function rasterizePages(
  input: ArrayBuffer | Uint8Array,
  opts?: { maxPages?: number; scale?: number },
): Promise<RasterizedPage[]> {
  const mod = await loadPdfParse();
  if (mod === null) {
    return [];
  }
  const PDFParseCtor = mod.PDFParse;
  let pdf: PDFParse | undefined;
  try {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    pdf = new PDFParseCtor({ data });
    const params: ParseParameters = { imageBuffer: true, imageDataUrl: false };
    if (opts?.maxPages !== undefined && opts.maxPages > 0) {
      params.first = opts.maxPages;
    }
    if (opts?.scale !== undefined && opts.scale > 0) {
      params.scale = opts.scale;
    }
    const result = await pdf.getScreenshot(params);
    return result.pages.map((p) => ({ page: p.pageNumber, png: p.data }));
  } catch {
    return [];
  } finally {
    try {
      await pdf?.destroy();
    } catch {
      // Best-effort cleanup; ignore.
    }
  }
}

/**
 * Parse PDF bytes into a `ParsedDocument`.
 *
 * @param input  PDF file bytes (ArrayBuffer or Uint8Array).
 * @param opts   Optional limits; `maxPages` caps the number of pages parsed.
 * @returns      Extracted markdown, title, images, tables, and warnings.
 */
export async function parsePdf(
  input: ArrayBuffer | Uint8Array,
  opts?: { maxPages?: number },
  deps?: { loadModule?: () => Promise<typeof import('pdf-parse') | null> },
): Promise<ParsedDocument> {
  const warnings: string[] = [];
  let mod: typeof import('pdf-parse') | null = null;
  if (deps?.loadModule !== undefined) {
    try {
      mod = await deps.loadModule();
    } catch (err) {
      logger.warn({ err }, 'pdf-parse unavailable: PDF parsing skipped');
    }
  } else {
    mod = await loadPdfParse();
  }
  if (mod === null) {
    warnings.push('pdf-parse unavailable: PDF parsing skipped');
    return { markdown: '', title: '', images: [], tables: [], warnings };
  }
  const PDFParseCtor = mod.PDFParse;
  let pdf: PDFParse | undefined;
  try {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);

    pdf = new PDFParseCtor({ data });

    const parseParams: { first?: number; pageJoiner?: string } = {
      pageJoiner: '',
    };
    if (opts?.maxPages !== undefined && opts.maxPages > 0) {
      parseParams.first = opts.maxPages;
    }

    // Run these sequentially: they share the pdfjs worker, and concurrent
    // calls cause a structured-clone "Cannot transfer object" error.
    const textResult = await pdf.getText(parseParams);
    const infoResult = await pdf.getInfo();
    const tableResult = await pdf.getTable(parseParams);

    const markdown = textResult.text.trim();
    // `InfoResult.info` is untyped (any); narrow it to read the title safely.
    const meta = infoResult.info as { Title?: unknown } | undefined;
    const rawTitle = meta?.Title;
    const title = typeof rawTitle === 'string' && rawTitle.trim() !== '' ? rawTitle.trim() : '';

    const images: { data: Uint8Array; mime: string; page: number }[] = [];
    try {
      // Pass only the page selector (plus the buffer flags needed to receive
      // binary data) — do not spread the text-oriented parseParams (pageJoiner,
      // etc.) into image extraction.
      const imageParams: ParseParameters = { imageBuffer: true, imageDataUrl: false };
      if (parseParams.first !== undefined) imageParams.first = parseParams.first;
      const imageResult = await pdf.getImage(imageParams);
      let totalImageBytes = 0;
      let truncated = false;
      outer: for (const page of imageResult.pages) {
        for (const img of page.images) {
          if (img.data.length === 0) continue;
          if (images.length >= MAX_IMAGES || totalImageBytes + img.data.length > MAX_IMAGE_BYTES) {
            truncated = true;
            break outer;
          }
          images.push({ data: img.data, mime: sniffMime(img.data), page: page.pageNumber });
          totalImageBytes += img.data.length;
        }
      }
      if (truncated) {
        warnings.push(
          'Image extraction truncated (limit reached); proceeding with collected images.',
        );
      }
    } catch {
      warnings.push('Image extraction failed; proceeding without embedded images.');
    }

    const tables: string[] = [];
    try {
      for (const table of tableResult.mergedTables) {
        const rendered = tableToMarkdown(table);
        if (rendered !== '') {
          tables.push(rendered);
        }
      }
    } catch {
      warnings.push('Table extraction failed; proceeding without tables.');
    }

    if (markdown === '') {
      warnings.push('No text could be extracted from the PDF.');
    }

    return { markdown, title, images, tables, warnings };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown PDF parse error';
    warnings.push(`PDF parsing failed: ${message}`);
    return { markdown: '', title: '', images: [], tables: [], warnings };
  } finally {
    try {
      await pdf?.destroy();
    } catch {
      // Best-effort cleanup; ignore.
    }
  }
}
