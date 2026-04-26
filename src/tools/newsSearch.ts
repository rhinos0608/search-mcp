/**
 * @file newsSearch.ts
 * DEPRECATED — This tool is no longer available.
 *
 * The GDELT-backed news_search tool had quality issues (incomplete coverage,
 * stale data, unreliable results). Clients should never receive a working
 * response from this tool. Upstream callers are redirected to web_search
 * for general news queries, or to source-specific tools like
 * reddit_search / hackernews_search for topic-specific news.
 *
 * To re-enable, restore the original implementation and re-register the tool
 * in src/server.ts once quality issues are resolved.
 */

import { logger } from '../logger.js';
import { unavailableError } from '../errors.js';

/**
 * Stub for the deprecated news_search tool.
 * Always rejects — never returns data.
 */
export function newsSearch(): Promise<never> {
  logger.warn({ tool: 'news_search' }, 'Deprecated news_search invoked — returning error');
  return Promise.reject(
    unavailableError(
      'news_search is deprecated and no longer available. Use web_search for general news queries, or reddit_search / hackernews_search for topic-specific results.',
      { retryable: false },
    ),
  );
}
