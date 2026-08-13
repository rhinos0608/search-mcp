/**
 * Document URL detection utilities.
 *
 * Shared across the crawl pipeline to detect document file extensions
 * (PDF, Office, images, text files, etc.) that need document extraction
 * instead of Crawl4AI headless browser rendering.
 */

/** Document file extensions that need document extraction handling. */
export const DOCUMENT_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.odt',
  '.ods',
  '.odp',
  '.rtf',
  '.tex',
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tiff',
  '.tif',
  '.webp',
  '.djvu',
]);

/** Check if a URL likely points to a document file. */
export function isDocumentUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return DOCUMENT_EXTENSIONS.has(pathname.slice(pathname.lastIndexOf('.')));
  } catch {
    return false;
  }
}

const ARXIV_HOST_RE = /(^|\.)arxiv\.org$/iu;
// Modern IDs look like `0701.00123`; legacy IDs carry an archive prefix and a
// bare 7-digit number (`math/0309136`, `cs/0701001`). Both may carry a version
// suffix and an optional `.pdf` extension.
const ARXIV_ID_PATH_RE =
  /^\/(?:pdf|abs)\/((?:\d{4}\.\d{4,6})|(?:[a-z-]+\/\d{7}))(?:v\d+)?(?:\.pdf)?$/iu;

/** Extract the arXiv paper id from a `/pdf/<id>` or `/abs/<id>` URL on arxiv.org. */
export function arxivIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!ARXIV_HOST_RE.test(parsed.hostname)) return null;
    const match = ARXIV_ID_PATH_RE.exec(parsed.pathname);
    if (match?.[1] === undefined) return null;
    return match[1];
  } catch {
    return null;
  }
}

/** Convert arXiv PDF URLs to the equivalent abstract page URL. */
export function arxivPdfToAbstract(url: string): string | null {
  const id = arxivIdFromUrl(url);
  if (id === null) return null;
  return `https://arxiv.org/abs/${id}`;
}

/** Return arXiv HTML-rendering candidate URLs for a URL with a parseable arxiv id. */
export function arxivHtmlUrls(url: string): string[] {
  const id = arxivIdFromUrl(url);
  if (id === null) return [];
  return [`https://arxiv.org/html/${id}`, `https://ar5iv.labs.arxiv.org/html/${id}`];
}

/** Strip a known document extension, which often reveals an HTML landing page. */
export function documentUrlToHtmlFallback(url: string): string | null {
  try {
    const parsed = new URL(url);
    const lastDot = parsed.pathname.lastIndexOf('.');
    if (lastDot < 0) return null;
    const ext = parsed.pathname.slice(lastDot).toLowerCase();
    if (!DOCUMENT_EXTENSIONS.has(ext)) return null;
    parsed.pathname = parsed.pathname.slice(0, lastDot);
    return parsed.toString();
  } catch {
    return null;
  }
}

export function documentFallbackUrls(url: string): string[] {
  const fallbacks = [
    ...arxivHtmlUrls(url),
    arxivPdfToAbstract(url),
    documentUrlToHtmlFallback(url),
  ].filter((candidate): candidate is string => candidate !== null && candidate !== url);
  return [...new Set(fallbacks)];
}
