/**
 * Firecrawl v2 synchronous scrape client.
 *
 * POST https://api.firecrawl.dev/v2/scrape
 * Single URL, markdown only, no page following.
 */

import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { ToolError, timeoutError, unavailableError, validationError } from '../errors.js';
import { logger } from '../logger.js';
import type { CrawlPageResult } from '../types.js';
import { strField, strOrNull } from './providerFields.js';

const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v2/scrape';
const SCRAPE_TIMEOUT_MS = 30_000;
const SCRAPE_SERVER_TIMEOUT_MS = 25_000;
const SCRAPE_MAX_BYTES = 10 * 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function failedPage(url: string, errorMessage: string | null): CrawlPageResult {
  return {
    url,
    success: false,
    markdown: '',
    title: null,
    description: null,
    links: [],
    statusCode: null,
    errorMessage,
  };
}

export async function firecrawlScrape(url: string, apiKey: string): Promise<CrawlPageResult> {
  if (apiKey.length === 0) {
    throw unavailableError('Firecrawl scrape is not configured.', { backend: 'firecrawl' });
  }

  try {
    assertSafeUrl(url);
  } catch (err) {
    throw validationError(err instanceof Error ? err.message : 'Invalid URL', {
      backend: 'firecrawl',
    });
  }

  assertSafeUrl(FIRECRAWL_SCRAPE_URL);
  logger.info({ timeoutMs: SCRAPE_TIMEOUT_MS }, 'Running Firecrawl scrape');

  let response: Response;
  try {
    response = await fetch(FIRECRAWL_SCRAPE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true,
        skipTlsVerification: false,
        storeInCache: false,
        maxAge: 0,
        timeout: SCRAPE_SERVER_TIMEOUT_MS,
      }),
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw timeoutError(
        `Firecrawl scrape request timed out after ${String(SCRAPE_TIMEOUT_MS)}ms`,
        { backend: 'firecrawl', cause: err },
      );
    }
    throw err;
  }

  if (response.status === 429) {
    throw new ToolError('Firecrawl Scrape API rate limit exceeded (429)', {
      code: 'RATE_LIMIT',
      retryable: false,
      statusCode: 429,
      backend: 'firecrawl',
    });
  }

  if (response.status === 401) {
    throw new ToolError('Firecrawl Scrape API authentication failed (401)', {
      code: 'UNAVAILABLE',
      retryable: false,
      statusCode: 401,
      backend: 'firecrawl',
    });
  }

  if (!response.ok) {
    throw unavailableError(`Firecrawl Scrape API returned ${String(response.status)}`, {
      statusCode: response.status,
      backend: 'firecrawl',
      retryable: false,
    });
  }

  const payload = await safeResponseJson(response, FIRECRAWL_SCRAPE_URL, SCRAPE_MAX_BYTES);
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  if (data === null) {
    return failedPage(url, 'Invalid Firecrawl scrape response');
  }

  const markdown = strField(data.markdown);
  const metadata = asRecord(data.metadata);
  const title = strOrNull(metadata?.title);
  const description = strOrNull(metadata?.description);
  const errorMessage = strOrNull(metadata?.error);

  const page: CrawlPageResult = {
    url,
    success: markdown.trim().length > 0,
    markdown,
    title,
    description,
    links: [],
    statusCode: numOrNull(metadata?.statusCode),
    errorMessage,
  };
  logger.debug({ success: page.success }, 'Firecrawl scrape complete');
  return page;
}
