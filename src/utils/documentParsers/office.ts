/** Maximum number of ZIP entries before rejecting as a potential bomb. */
const MAX_ZIP_ENTRIES = 10_000;
/** Maximum cumulative uncompressed size (bytes) across all ZIP entries. */
const MAX_ZIP_UNCOMPRESSED = 100 * 1024 * 1024;
/** Maximum per-entry compression ratio (uncompressed / compressed). */
const MAX_ZIP_COMPRESSION_RATIO = 100;

/**
 * Inspect a ZIP archive's central directory and reject it when the entry
 * count, cumulative uncompressed size, or per-entry compression ratio exceeds
 * configured limits. Returns `null` when the archive passes validation, or a
 * warning string when it is rejected.
 *
 * Office documents (docx, xlsx, pptx, odt, etc.) are ZIP archives. This
 * check runs before handing bytes to the parser so a maliciously crafted
 * "office document" cannot exhaust memory or CPU via decompression bombs.
 */
function validateZipArchive(input: Uint8Array | ArrayBuffer): string | null {
  const buf = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (buf.length < 22) return 'File too small to be a valid ZIP archive.';

  // Find the End of Central Directory Record (EOCD) signature 0x06054b50.
  let eocdOffset = -1;
  const maxComment = Math.min(65_535, buf.length - 22);
  for (let i = buf.length - 22; i >= buf.length - 22 - maxComment && i >= 0; i -= 1) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return 'Not a valid ZIP archive (EOCD signature not found).';

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  if (totalEntries > MAX_ZIP_ENTRIES) {
    return `ZIP entry count ${String(totalEntries)} exceeds limit ${String(MAX_ZIP_ENTRIES)}.`;
  }

  // Walk the central directory entries.
  let offset = cdOffset;
  let cumulativeUncompressed = 0;
  for (let i = 0; i < totalEntries; i += 1) {
    if (offset + 46 > buf.length) {
      return 'ZIP central directory truncated.';
    }
    // Check central directory entry signature 0x02014b50.
    if (
      buf[offset] !== 0x50 ||
      buf[offset + 1] !== 0x4b ||
      buf[offset + 2] !== 0x01 ||
      buf[offset + 3] !== 0x02
    ) {
      return `Invalid central directory entry at offset ${String(offset)}.`;
    }

    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const filenameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);

    cumulativeUncompressed += uncompressedSize;
    if (cumulativeUncompressed > MAX_ZIP_UNCOMPRESSED) {
      return `Cumulative uncompressed size exceeds limit ${String(MAX_ZIP_UNCOMPRESSED)}.`;
    }

    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_ZIP_COMPRESSION_RATIO) {
      return `Per-entry compression ratio ${(uncompressedSize / compressedSize).toFixed(1)} exceeds limit ${String(MAX_ZIP_COMPRESSION_RATIO)}.`;
    }

    offset += 46 + filenameLength + extraLength + commentLength;
  }

  return null; // Passed validation.
}

/**
 * In-process office document (docx/pptx/xlsx/odt/odp/ods/rtf/csv/html/epub) →
 * markdown parser built on `officeparser`.
 *
 * Feeds the raw file bytes to `officeparser`, renders the resulting AST as
 * markdown, and surfaces the document title from its metadata. Never throws:
 * on any failure it returns an empty `ParsedDocument` with a structured
 * warning. `images` and `tables` are not populated in v1.
 *
 * NOTE: This module must remain loadable without `@napi-rs/canvas` — no
 * rasterization happens here. Multimodal visual extraction lives in the VLM
 * tier (Task 7).
 */
import type { ParsedDocument } from './types.js';
import { logger } from '../../logger.js';
import type { OfficeParserConfig } from 'officeparser';

// `officeparser` is loaded lazily so the always-loaded office path never crashes
// at module load if the dep is missing or unbuildable. `loadOfficeParser` caches
// a single promise; on failure it resolves to `null` and `parseOffice` degrades
// with a structured warning.
interface OfficeParserModule {
  parseOffice: typeof import('officeparser').parseOffice;
}

let officeParserModulePromise: Promise<OfficeParserModule | null> | undefined;

async function loadOfficeParser(): Promise<OfficeParserModule | null> {
  officeParserModulePromise ??= (async () => {
    try {
      const mod = await import('officeparser');
      return { parseOffice: mod.parseOffice };
    } catch (err) {
      logger.warn({ err }, 'officeparser unavailable: office parsing disabled');
      return null;
    }
  })();
  return officeParserModulePromise;
}

/**
 * Report whether the office parser dependency can be loaded. Never throws:
 * a failed/cached load reports `false` (the same signal `parseOffice` uses to
 * degrade with a structured warning).
 */
export async function isOfficeParserAvailable(): Promise<boolean> {
  return (await loadOfficeParser()) !== null;
}

/**
 * Parse office document bytes into a `ParsedDocument`.
 *
 * @param input   Office file bytes (ArrayBuffer or Uint8Array).
 * @param ext     File extension, e.g. '.docx'. Passed to `officeparser` as the
 *                `fileType` hint so text-based formats parse reliably.
 * @param deps    Optional dependency override (tests).
 * @param options Optional cancellation controls: an `AbortSignal` and/or a
 *                `timeoutMs` (converted to a signal) forwarded to the parser.
 * @returns       Extracted markdown, title, empty images/tables, and warnings.
 */
export async function parseOffice(
  input: Uint8Array | ArrayBuffer,
  ext: string,
  deps?: { loadModule?: () => Promise<OfficeParserModule | null> },
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<ParsedDocument> {
  const warnings: string[] = [];
  let mod: OfficeParserModule | null = null;
  if (deps?.loadModule !== undefined) {
    try {
      mod = await deps.loadModule();
    } catch (err) {
      logger.warn({ err }, 'officeparser unavailable: office parsing skipped');
    }
  } else {
    mod = await loadOfficeParser();
  }
  if (mod === null) {
    warnings.push('officeparser unavailable: office parsing skipped');
    return { markdown: '', title: '', images: [], tables: [], warnings };
  }
  const parseOfficeFn = mod.parseOffice;
  try {
    const config: OfficeParserConfig = {};
    // Pass the extension as the parser's fileType hint when it maps to a
    // supported format (legacy/unmapped extensions are omitted so the parser
    // falls back to magic-byte detection).
    const fileType = ext.startsWith('.') ? ext.slice(1) : ext;
    const supported: OfficeParserConfig['fileType'][] = [
      'docx',
      'pptx',
      'xlsx',
      'odt',
      'odp',
      'ods',
      'pdf',
      'rtf',
      'md',
      'html',
      'csv',
      'epub',
    ];
    if ((supported as string[]).includes(fileType)) {
      config.fileType = fileType as NonNullable<OfficeParserConfig['fileType']>;
    }
    // Forward caller cancellation (AbortSignal or timeout) to the parser.
    const signal =
      options?.signal ??
      (options?.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined);
    if (signal !== undefined) config.abortSignal = signal;

    // Inspect the ZIP archive before parsing to reject decompression bombs.
    // Only ZIP-based formats (DOCX, PPTX, XLSX, ODT, ODP, ODS, EPUB) are
    // validated; RTF, HTML, CSV, and Markdown pass through unchanged.
    const zipFormats = new Set(['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'epub']);
    if (zipFormats.has(fileType)) {
      const zipError = validateZipArchive(input);
      if (zipError !== null) {
        warnings.push(zipError);
        return { markdown: '', title: '', images: [], tables: [], warnings };
      }
    }

    const ast = await parseOfficeFn(input, config);
    const markdown = (await ast.to('md')).value.trim();
    const rawTitle = ast.metadata.title;
    const title = typeof rawTitle === 'string' && rawTitle.trim() !== '' ? rawTitle.trim() : '';

    if (markdown === '') {
      warnings.push('No text could be extracted from the office document.');
    }

    return { markdown, title, images: [], tables: [], warnings };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown office parse error';
    warnings.push(`Office parsing failed: ${message}`);
    return { markdown: '', title: '', images: [], tables: [], warnings };
  }
}
