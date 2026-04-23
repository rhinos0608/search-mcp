import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseText, TRUNCATED_MARKER } from '../httpGuards.js';
import { parseError } from '../errors.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import type { ArticleResult } from '../types.js';
import { extractElementsFromHtml } from '../utils/htmlElements.js';

const cache = new ToolCache<ArticleResult>({
  maxSize: 100,
  ttlMs: 24 * 60 * 60 * 1000,
});

interface Metadata {
  title: string | null;
  description: string | null;
  image: string | null;
  publishedDate: string | null;
  author: string | null;
  siteName: string | null;
}

function extractMetadata(document: Document): Metadata {
  const getMeta = (property: string): string | null => {
    const el =
      document.querySelector(`meta[property="${property}"]`) ??
      document.querySelector(`meta[name="${property}"]`);
    return el?.getAttribute('content')?.trim() ?? null;
  };

  const title = getMeta('og:title') ?? (document.title.trim() || null);
  const description = getMeta('og:description') ?? getMeta('description');

  const rawImage = getMeta('og:image');
  const image =
    rawImage !== null && (rawImage.startsWith('http://') || rawImage.startsWith('https://'))
      ? rawImage
      : null;

  const publishedDate =
    getMeta('article:published_time') ??
    getMeta('datePublished') ??
    document.querySelector('time[datetime]')?.getAttribute('datetime')?.trim() ??
    null;

  const author = getMeta('author');
  const siteName = getMeta('og:site_name');

  return { title, description, image, publishedDate, author, siteName };
}

function fallbackExtract(document: Document): { content: string; textContent: string } {
  const clone = document.cloneNode(true) as Document;
  for (const tag of ['script', 'style', 'noscript', 'svg', 'nav']) {
    for (const el of clone.querySelectorAll(tag)) {
      el.remove();
    }
  }

  const text = clone.body.textContent.replace(/\s+/g, ' ').trim();
  return { content: '<p>' + text + '</p>', textContent: text };
}

/**
 * Note: extractionConfig is not supported in the Readability fallback path.
 * When crawl4ai is configured, server.ts forwards extractionConfig to webCrawl.
 */
export async function webRead(url: string): Promise<ArticleResult> {
  assertSafeUrl(url);

  const key = cacheKey('web-read', url);
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ url }, 'Web read cache hit');
    return cached;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 30_000);

  let html: string;
  try {
    const response = await retryWithBackoff(
      () =>
        fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          signal: controller.signal,
          redirect: 'follow',
        }),
      { label: 'web-read', maxAttempts: 2 },
    );

    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)} ${response.statusText} fetching "${url}"`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
      throw new Error(`URL "${url}" returned non-HTML content type: ${contentType}`);
    }

    html = await safeResponseText(response, url);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (error.name === 'AbortError') {
      throw new Error(`Request to "${url}" timed out after 30 seconds`, { cause: err });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const MAX_CONTENT_LENGTH = 50_000;

  const metaDom = new JSDOM(html, { url });
  let metadata: Metadata;
  try {
    metadata = extractMetadata(metaDom.window.document);
  } finally {
    metaDom.window.close();
  }

  const readabilityDom = new JSDOM(html, { url });
  let result: ArticleResult;
  try {
    const reader = new Readability(readabilityDom.window.document);
    const article = reader.parse();

    if (article !== null) {
      let content = article.content ?? '';
      let textContent = article.textContent ?? '';

      if (content.length > MAX_CONTENT_LENGTH) {
        content = content.slice(0, MAX_CONTENT_LENGTH) + TRUNCATED_MARKER;
      }
      if (textContent.length > MAX_CONTENT_LENGTH) {
        textContent = textContent.slice(0, MAX_CONTENT_LENGTH) + TRUNCATED_MARKER;
      }

      let elements: import('../types.js').ContentElement[] | undefined;
      try {
        const articleDom = new JSDOM(content, { url });
        try {
          elements = extractElementsFromHtml(articleDom.window.document);
        } finally {
          articleDom.window.close();
        }
      } catch {
        elements = undefined;
      }

      result = {
        title: article.title ?? metadata.title,
        content,
        textContent,
        byline: article.byline ?? metadata.author,
        siteName: article.siteName ?? metadata.siteName,
        url,
        extractionMethod: 'readability',
        description: metadata.description,
        publishedDate: metadata.publishedDate,
        image: metadata.image,
        ...(elements !== undefined && elements.length > 0 && { elements }),
      };
    } else {
      readabilityDom.window.close();

      const fallbackDom = new JSDOM(html, { url });
      try {
        const fb = fallbackExtract(fallbackDom.window.document);

        if (fb.textContent.length === 0) {
          throw parseError(
            `Could not extract any content from "${url}". The page may be a SPA, login-gated, or otherwise unreadable.`,
          );
        }

        let content = fb.content;
        let textContent = fb.textContent;

        if (content.length > MAX_CONTENT_LENGTH) {
          content = content.slice(0, MAX_CONTENT_LENGTH) + TRUNCATED_MARKER;
        }
        if (textContent.length > MAX_CONTENT_LENGTH) {
          textContent = textContent.slice(0, MAX_CONTENT_LENGTH) + TRUNCATED_MARKER;
        }

        let elements: import('../types.js').ContentElement[] | undefined;
        try {
          elements = extractElementsFromHtml(fallbackDom.window.document);
        } catch {
          elements = undefined;
        }

        result = {
          title: metadata.title,
          content,
          textContent,
          byline: metadata.author,
          siteName: metadata.siteName,
          url,
          extractionMethod: 'fallback',
          description: metadata.description,
          publishedDate: metadata.publishedDate,
          image: metadata.image,
          ...(elements !== undefined && elements.length > 0 && { elements }),
        };
      } finally {
        fallbackDom.window.close();
      }

      logger.debug(
        { url, title: result.title, textContentLength: result.textContent.length },
        'Web read complete (fallback)',
      );

      cache.set(key, result);
      return result;
    }
  } finally {
    // The readability DOM may already be closed in the fallback branch;
    // closing an already-closed window is a no-op in jsdom.
    try {
      readabilityDom.window.close();
    } catch {
      // ignore
    }
  }

  logger.debug(
    { url, title: result.title, textContentLength: result.textContent.length },
    'Web read complete',
  );

  cache.set(key, result);
  return result;
}
