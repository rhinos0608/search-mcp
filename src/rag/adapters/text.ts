import { chunkMarkdown } from '../../chunking.js';
import { isCookieBannerPage } from '../../utils/cookieBanner.js';
import type { RagChunk, RawDocument } from '../types.js';

export interface TextPage {
  url: string;
  markdown: string;
  title?: string | null | undefined;
  success?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export function documentsFromTextPages(pages: TextPage[]): RawDocument[] {
  return pages
    .filter(
      (page) =>
        page.success !== false && page.markdown.length > 0 && !isCookieBannerPage(page.markdown),
    )
    .map((page, index) => ({
      id: page.url || `text:${String(index)}`,
      adapter: 'text',
      text: page.markdown,
      url: page.url,
      title: page.title,
      metadata: page.metadata,
    }));
}

export function chunksFromTextPages(pages: TextPage[]): RagChunk[] {
  const chunks: RagChunk[] = [];
  for (const page of pages) {
    if (page.success === false || page.markdown.length === 0 || isCookieBannerPage(page.markdown)) {
      continue;
    }
    const markdownChunks = chunkMarkdown(page.markdown, page.url);
    chunks.push(
      ...markdownChunks.map((chunk) => ({
        text: chunk.content,
        url: chunk.url,
        section: chunk.section,
        charOffset: chunk.charOffset,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunk.totalChunks,
        metadata: {
          ...page.metadata,
          adapter: 'text',
          pageTitle: chunk.pageTitle,
          tokenEstimate: chunk.tokenEstimate,
        },
      })),
    );
  }
  return chunks;
}
