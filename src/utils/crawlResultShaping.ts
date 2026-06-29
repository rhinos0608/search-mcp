/**
 * Crawl result shaping utilities.
 *
 * Provides shared functions for normalizing crawl results and building
 * extraction warnings.
 */

import type { ArticleResult, WebCrawlResult } from '../types.js';

/**
 * Normalize a Readability article into the WebCrawlResult shape.
 * Used when falling back to Readability or when document extraction produces markdown.
 */
export function readabilityFallbackResult(
  url: string,
  article: ArticleResult,
  strategy: 'bfs' | 'dfs',
  maxDepth: number,
  maxPages: number,
): WebCrawlResult {
  return {
    seedUrl: url,
    strategy,
    maxDepth,
    maxPages,
    totalPages: 1,
    successfulPages: 1,
    pages: [
      {
        url,
        success: true,
        markdown: article.textContent,
        title: article.title ?? '',
        description: article.description ?? '',
        links: [],
        statusCode: null,
        errorMessage: null,
        ...(article.elements !== undefined &&
          article.elements.length > 0 && { elements: article.elements }),
        ...(article.truncatedElements !== undefined && {
          truncatedElements: article.truncatedElements,
        }),
        ...(article.originalElementCount !== undefined && {
          originalElementCount: article.originalElementCount,
        }),
        ...(article.omittedElementCount !== undefined && {
          omittedElementCount: article.omittedElementCount,
        }),
      },
    ],
  };
}

/**
 * Build extraction warnings: pages that succeeded but returned no extractedData.
 */
export function extractionWarnings(data: {
  pages: { url: string; success: boolean; extractedData?: unknown }[];
}): string[] {
  const warnings: string[] = [];
  for (const page of data.pages) {
    if (page.success && !page.extractedData) {
      warnings.push(`Extraction produced no data for ${page.url}`);
    }
  }
  return warnings;
}
