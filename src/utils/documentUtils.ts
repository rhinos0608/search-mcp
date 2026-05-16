/**
 * Document URL detection utilities.
 *
 * Shared across the crawl pipeline to detect document file extensions
 * (PDF, Office, images, etc.) that should use RAG-Anything extraction
 * instead of Crawl4AI headless browser rendering.
 */

/** Document file extensions that should use RAG-Anything extraction. */
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

/** Convert arXiv PDF URLs to the equivalent abstract page URL. */
export function arxivPdfToAbstract(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'arxiv.org' && !parsed.hostname.endsWith('.arxiv.org')) {
      return null;
    }
    const match = /^\/pdf\/(\d{4}\.\d{4,6})(?:v\d+)?(?:\.pdf)?$/iu.exec(parsed.pathname);
    if (match?.[1] === undefined) return null;
    return `https://arxiv.org/abs/${match[1]}`;
  } catch {
    return null;
  }
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
  const fallbacks = [arxivPdfToAbstract(url), documentUrlToHtmlFallback(url)].filter(
    (candidate): candidate is string => candidate !== null && candidate !== url,
  );
  return [...new Set(fallbacks)];
}
