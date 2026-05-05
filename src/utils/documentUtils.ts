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
