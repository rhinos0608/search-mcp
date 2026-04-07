import { logger } from '../logger.js';
import { safeResponseJson, assertSafeUrl, TRUNCATED_MARKER } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { unavailableError, timeoutError, parseError } from '../errors.js';
import type { PatentResult } from '../types.js';

const USER_AGENT = 'search-mcp/1.0';

const cache = new ToolCache<PatentResult[]>({ maxSize: 100, ttlMs: 60 * 60 * 1000 }); // 1 hour

export async function patentSearch(
  query: string,
  apiKey: string,
  assignee = '',
  limit = 25,
): Promise<PatentResult[]> {
  if (!apiKey) {
    throw unavailableError(
      'Patent search requires a PatentsView API key. Register at https://patentsview.org/apis/purpose and set PATENTSVIEW_API_KEY env var.',
      { backend: 'patentsview' },
    );
  }

  const key = cacheKey('patent', query, assignee, String(limit));
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'Patent search cache hit');
    return cached;
  }

  // Build the query object for PatentsView v1 API
  const textQuery: Record<string, unknown> = {
    _text_any: { patent_abstract: query },
  };

  const qParam = assignee
    ? JSON.stringify({
        _and: [textQuery, { _text_phrase: { 'assignees.assignee_organization': assignee } }],
      })
    : JSON.stringify(textQuery);

  const fields = JSON.stringify([
    'patent_number',
    'patent_title',
    'patent_abstract',
    'patent_date',
    'application_date',
    'assignees.assignee_organization',
    'inventors.inventor_first_name',
    'inventors.inventor_last_name',
  ]);

  const sort = JSON.stringify([{ patent_date: 'desc' }]);
  const options = JSON.stringify({ size: limit });

  const url =
    `https://search.patentsview.org/api/v1/patent/` +
    `?q=${encodeURIComponent(qParam)}` +
    `&f=${encodeURIComponent(fields)}` +
    `&s=${encodeURIComponent(sort)}` +
    `&o=${encodeURIComponent(options)}`;

  assertSafeUrl(url);

  logger.info({ tool: 'patent_search', query, assignee, limit }, 'Searching patents');

  const response = await retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, 30_000);

      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': USER_AGENT,
            'X-Api-Key': apiKey,
          },
          signal: controller.signal,
        });

        if (!res.ok) {
          throw unavailableError(`PatentsView API error ${String(res.status)}: ${res.statusText}`, {
            statusCode: res.status,
            backend: 'patentsview',
          });
        }

        return res;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          throw timeoutError('PatentsView API request timed out after 30 seconds', {
            backend: 'patentsview',
            cause: err,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    { label: 'patent-search', maxAttempts: 2 },
  );

  const json: unknown = await safeResponseJson(response, url);

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw parseError('Unexpected PatentsView API response shape', {
      backend: 'patentsview',
    });
  }

  const body = json as Record<string, unknown>;
  const patents = body.patents;

  if (!Array.isArray(patents)) {
    // An empty result set may return no "patents" key — treat as zero results
    if (patents === undefined || patents === null) {
      cache.set(key, []);
      return [];
    }
    throw parseError('Unexpected PatentsView API response: "patents" is not an array', {
      backend: 'patentsview',
    });
  }

  const results: PatentResult[] = [];

  for (const entry of patents as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const p = entry as Record<string, unknown>;

    const patentNumber = typeof p.patent_number === 'string' ? p.patent_number : '';
    if (!patentNumber) continue;

    const title = typeof p.patent_title === 'string' ? p.patent_title : '';

    const rawAbstract = typeof p.patent_abstract === 'string' ? p.patent_abstract : '';
    const abstract =
      rawAbstract.length > 2000 ? rawAbstract.slice(0, 2000) + TRUNCATED_MARKER : rawAbstract;

    // Extract inventors — combine first and last name
    const inventors: string[] = [];
    if (Array.isArray(p.inventors)) {
      for (const inv of p.inventors as unknown[]) {
        if (typeof inv !== 'object' || inv === null) continue;
        const invObj = inv as Record<string, unknown>;
        const first =
          typeof invObj.inventor_first_name === 'string' ? invObj.inventor_first_name.trim() : '';
        const last =
          typeof invObj.inventor_last_name === 'string' ? invObj.inventor_last_name.trim() : '';
        const name = [first, last].filter(Boolean).join(' ');
        if (name) inventors.push(name);
      }
    }

    // Extract assignees
    const assignees: string[] = [];
    if (Array.isArray(p.assignees)) {
      for (const asg of p.assignees as unknown[]) {
        if (typeof asg !== 'object' || asg === null) continue;
        const asgObj = asg as Record<string, unknown>;
        const org =
          typeof asgObj.assignee_organization === 'string'
            ? asgObj.assignee_organization.trim()
            : '';
        if (org) assignees.push(org);
      }
    }

    const filingDate = typeof p.application_date === 'string' ? p.application_date : null;
    const grantDate = typeof p.patent_date === 'string' ? p.patent_date : null;

    results.push({
      patentNumber,
      title,
      abstract,
      inventors,
      assignees,
      filingDate,
      grantDate,
      url: `https://patents.google.com/patent/US${patentNumber}`,
      citations: null,
    });
  }

  cache.set(key, results);
  logger.debug({ resultCount: results.length }, 'Patent search complete');

  return results;
}
