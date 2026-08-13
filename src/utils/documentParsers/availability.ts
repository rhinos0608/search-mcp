/**
 * Runtime capability discovery for in-process document parsers.
 *
 * `pdf-parse` and `officeparser` are installed by default, but may be missing
 * or unbuildable (e.g. a failed optional native dep install). Because the
 * always-on document-parsing path now loads them lazily, we need a way to
 * report which parsers are actually usable without crashing. We defer to the
 * cached loaders in pdf.ts / office.ts (via their availability accessors) so
 * discovery and parsing agree on a single lazy-load signal. Never throws: any
 * failure reports that parser as unavailable.
 *
 * NOTE: PDF availability only confirms the pdf-parse dependency loads — it
 * does NOT guarantee native rasterizer operations such as `getScreenshot`
 * succeed (see `isPdfParseAvailable` in pdf.ts).
 */
import { isPdfParseAvailable } from './pdf.js';
import { isOfficeParserAvailable } from './office.js';

export interface ParserAvailability {
  pdf: boolean;
  office: boolean;
}

export async function detectDocumentParsers(): Promise<ParserAvailability> {
  const [pdf, office] = await Promise.all([isPdfParseAvailable(), isOfficeParserAvailable()]);
  return { pdf, office };
}
