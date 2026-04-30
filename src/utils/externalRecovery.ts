import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseText } from '../httpGuards.js';

export interface RecoveryResult {
  content: string | null;
  source: 'wayback' | 'google-cache' | null;
  error?: string;
}

/**
 * Attempt to recover a page from the Wayback Machine CDX API.
 * Returns the most recent snapshot's extracted HTML content.
 */
async function attemptWaybackRecovery(url: string): Promise<RecoveryResult> {
  try {
    const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=1&sort=reverse`;

    const cdxResp = await fetch(cdxUrl, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!cdxResp.ok) {
      return { content: null, source: null, error: `CDX API returned ${String(cdxResp.status)}` };
    }

    const cdxData = (await cdxResp.json()) as unknown;
    if (!Array.isArray(cdxData) || cdxData.length < 2) {
      return { content: null, source: null, error: 'No snapshots in Wayback Machine' };
    }

    const header = cdxData[0] as string[];
    const snapshot = cdxData[1] as string[];
    const tsIdx = header.indexOf('timestamp');
    if (tsIdx === -1 || snapshot[tsIdx] === undefined) {
      return { content: null, source: null, error: 'Unexpected CDX response format' };
    }

    const timestamp = snapshot[tsIdx];
    const snapshotUrl = `https://web.archive.org/web/${timestamp}id_/${url}`;

    const snapshotResp = await fetch(snapshotUrl, {
      signal: AbortSignal.timeout(15_000),
    });

    if (!snapshotResp.ok) {
      return {
        content: null,
        source: null,
        error: `Snapshot fetch returned ${String(snapshotResp.status)}`,
      };
    }

    const html = await safeResponseText(snapshotResp, snapshotUrl, 5_000_000);
    if (html.length < 100) {
      return { content: null, source: null, error: 'Snapshot too short' };
    }

    return { content: html, source: 'wayback' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: null, source: null, error: msg };
  }
}

/**
 * Attempt to recover a page from Google Web Cache.
 */
async function attemptGoogleCacheRecovery(url: string): Promise<RecoveryResult> {
  try {
    const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;

    const resp = await fetch(cacheUrl, {
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      return { content: null, source: null, error: `Google Cache returned ${String(resp.status)}` };
    }

    const html = await safeResponseText(resp, cacheUrl, 5_000_000);

    if (html.length < 100) {
      return { content: null, source: null, error: 'Cache response too short' };
    }

    // Guard: ensure this is an HTML page, not JSON or binary
    const looksLikeHtml = /<\s*(?:html|body|head|div|p|span|a|!DOCTYPE)\b/i.test(
      html.slice(0, 2000),
    );
    if (!looksLikeHtml) {
      return { content: null, source: null, error: 'Google Cache returned non-HTML content' };
    }

    // Google Cache wraps content — strip the banner/header note
    const stripped = stripGoogleCacheBanner(html);
    if (stripped.length < 100) {
      return { content: null, source: null, error: 'Stripped cache content too short' };
    }

    return { content: stripped, source: 'google-cache' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: null, source: null, error: msg };
  }
}

function stripGoogleCacheBanner(html: string): string {
  // Google Cache inserts a banner like "This is Google's cache of ..."
  // wrapped in various div structures; remove the first major banner block
  // and return the rest.

  // Try removing the banner div.
  const bannerMatch = /<\/div>\s*<hr\b[^>]*>/i.exec(html);
  if (bannerMatch?.index !== undefined) {
    return html.slice(bannerMatch.index + bannerMatch[0].length);
  }

  // Alternative: look for the standard banner text.
  const cacheTextIdx = html.indexOf("This is Google's cache of");
  if (cacheTextIdx === -1) return html;

  // Find the end of the banner — typically <hr> or a major content start.
  const hrMatch = /<hr\b[^>]*>/i.exec(html.slice(cacheTextIdx));
  if (hrMatch?.index !== undefined) {
    return html.slice(cacheTextIdx + hrMatch.index + hrMatch[0].length);
  }

  return html;
}

/**
 * Attempt external recovery: try Wayback first, then Google Cache.
 * Returns the first successful result.
 */
export async function attemptExternalRecovery(url: string): Promise<RecoveryResult> {
  logger.info({ url }, 'externalRecovery: attempting recovery');

  // Validate URL before making any external calls
  try {
    assertSafeUrl(url);
  } catch {
    return { content: null, source: null, error: 'Unsafe URL for recovery' };
  }

  const wayback = await attemptWaybackRecovery(url);
  if (wayback.content !== null) {
    logger.info({ url, source: 'wayback' }, 'externalRecovery: recovered from Wayback Machine');
    return wayback;
  }

  logger.debug(
    { url, error: wayback.error },
    'externalRecovery: Wayback failed, trying Google Cache',
  );

  const cache = await attemptGoogleCacheRecovery(url);
  if (cache.content !== null) {
    logger.info({ url, source: 'google-cache' }, 'externalRecovery: recovered from Google Cache');
    return cache;
  }

  logger.warn(
    { url, waybackError: wayback.error, cacheError: cache.error },
    'externalRecovery: all recovery sources failed',
  );
  return {
    content: null,
    source: null,
    error: `${wayback.error ?? ''}; ${cache.error ?? ''}`.trim(),
  };
}
