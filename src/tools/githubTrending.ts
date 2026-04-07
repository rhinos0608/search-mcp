import * as cheerio from 'cheerio';
import { logger } from '../logger.js';
import { safeResponseText } from '../httpGuards.js';
import { unavailableError, parseError, timeoutError } from '../errors.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import type { TrendingRepo, TrendingResult } from '../types.js';

// ── Cache ────────────────────────────────────────────────────────────────────

const cache = new ToolCache<TrendingResult>({
  ttlMs: 5 * 60 * 1000, // 5 minutes
  maxSize: 20,
});

// ── Multi-selector strategy ──────────────────────────────────────────────────

interface SelectorSet {
  articleRow: string[];
  repoLink: string[];
  description: string[];
  language: string[];
  stars: string[];
  forks: string[];
  todayStars: string[];
}

const SELECTORS: SelectorSet = {
  articleRow: ['article.Box-row', 'article[class*="Box-row"]', 'article.border'],
  repoLink: ['h2 a', 'h1 a', 'h2 a[href]'],
  description: ['p', 'p.col-9'],
  language: ['[itemprop="programmingLanguage"]', 'span[itemprop="programmingLanguage"]'],
  stars: ['a[href$="stargazers"]', 'a[href$="/stargazers"]'],
  forks: ['a[href$="forks"]', 'a[href$="/forks"]', 'a[href$="/network/members"]'],
  todayStars: [
    'span.d-inline-block.float-sm-right',
    'span.float-sm-right',
    'span[class*="float-sm-right"]',
  ],
};

/** Cheerio selection type (avoids importing domhandler directly). */
type CheerioSelection = ReturnType<cheerio.CheerioAPI>;

/**
 * Try primary selector first, then fallbacks. Returns the cheerio selection
 * and logs + records a warning if a fallback was used.
 */
function resolveSelector(
  $parent: CheerioSelection,
  selectorName: keyof SelectorSet,
  warnings: string[],
): CheerioSelection {
  const candidates = SELECTORS[selectorName];
  const primary = candidates[0] ?? '';
  for (let i = 0; i < candidates.length; i++) {
    const sel = candidates[i];
    if (sel === undefined) continue;
    const result = $parent.find(sel);
    if (result.length > 0) {
      if (i > 0) {
        const msg = `Selector "${selectorName}": primary "${primary}" failed, using fallback "${sel}"`;
        logger.debug({ selectorName, fallback: sel }, msg);
        warnings.push(msg);
      }
      return result;
    }
  }
  // None matched — return empty selection from first candidate
  return $parent.find(primary);
}

// ── Numeric parsing ──────────────────────────────────────────────────────────

/**
 * Parse a human-readable numeric string (e.g. "1,234", "12 stars today")
 * into a number. Returns 0 if unparseable.
 */
function parseNumericField(raw: string): number {
  // Strip commas and whitespace, then extract the first sequence of digits
  const cleaned = raw.replace(/,/g, '').trim();
  const match = /\d+/.exec(cleaned);
  if (!match) return 0;
  const parsed = parseInt(match[0], 10);
  return isNaN(parsed) ? 0 : parsed;
}

// ── Validation ───────────────────────────────────────────────────────────────

/** GitHub username/org regex: alphanumeric + hyphens, no leading/trailing hyphen. */
const GITHUB_NAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

function isValidGitHubName(name: string): boolean {
  return name.length > 0 && GITHUB_NAME_RE.test(name);
}

// ── Main function ────────────────────────────────────────────────────────────

export async function getGitHubTrending(
  language = '',
  since: 'daily' | 'weekly' | 'monthly' = 'daily',
  limit = 25,
): Promise<TrendingResult> {
  // Check cache first
  const key = cacheKey('github-trending', language || '_all', since, String(limit));
  const cached = cache.get(key);
  if (cached) {
    logger.info({ language, since, limit, cached: true }, 'Returning cached GitHub trending');
    return cached;
  }

  const url = `https://github.com/trending${language ? '/' + encodeURIComponent(language) : ''}?since=${since}`;

  logger.info({ language, since, limit }, 'Fetching GitHub trending');

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 30_000);

  let html: string;
  try {
    html = await retryWithBackoff(
      async () => {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'search-mcp/1.0' },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw unavailableError(
            `GitHub trending page returned HTTP ${String(response.status)}: ${response.statusText}`,
            { statusCode: response.status, backend: 'github-trending' },
          );
        }

        return safeResponseText(response, url);
      },
      { label: 'github-trending', maxAttempts: 2 },
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (error.name === 'AbortError') {
      throw timeoutError('GitHub trending page request timed out after 30 seconds', {
        backend: 'github-trending',
        cause: err,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const $ = cheerio.load(html);
  const warnings: string[] = [];

  // Resolve article row selector (top-level, so search from root)
  const articleRowCandidates = SELECTORS.articleRow;
  const articleRowPrimary = articleRowCandidates[0] ?? '';
  let articles: CheerioSelection | null = null;
  for (let i = 0; i < articleRowCandidates.length; i++) {
    const sel = articleRowCandidates[i];
    if (sel === undefined) continue;
    const found = $(sel);
    if (found.length > 0) {
      if (i > 0) {
        const msg = `Selector "articleRow": primary "${articleRowPrimary}" failed, using fallback "${sel}"`;
        logger.debug({ selectorName: 'articleRow', fallback: sel }, msg);
        warnings.push(msg);
      }
      articles = found;
      break;
    }
  }

  if (!articles || articles.length === 0) {
    throw parseError(
      'No trending repo articles found on GitHub trending page — DOM structure may have changed',
      { backend: 'github-trending' },
    );
  }

  const results: TrendingRepo[] = [];
  let rank = 0;
  let skippedCount = 0;

  articles.each((_index, element) => {
    rank++;
    try {
      const article = $(element);

      // Repo link
      const linkEl = resolveSelector(article, 'repoLink', warnings);
      const href = linkEl.attr('href') ?? '';
      const stripped = href.replace(/^\//, '');
      const parts = stripped.split('/');

      if (parts.length < 2 || !parts[0] || !parts[1]) {
        warnings.push(
          `Rank ${String(rank)}: could not parse owner/repo from href "${href}", skipping`,
        );
        skippedCount++;
        return; // continue .each()
      }

      const owner = parts[0].trim();
      const repo = parts[1].trim();

      // Validate owner and repo names
      if (!isValidGitHubName(owner) || !isValidGitHubName(repo)) {
        warnings.push(`Rank ${String(rank)}: invalid owner "${owner}" or repo "${repo}", skipping`);
        skippedCount++;
        return;
      }

      const repoUrl = `https://github.com/${owner}/${repo}`;

      // Validate URL format
      if (!repoUrl.startsWith('https://github.com/')) {
        warnings.push(
          `Rank ${String(rank)}: URL "${repoUrl}" does not start with https://github.com/, skipping`,
        );
        skippedCount++;
        return;
      }

      // Description
      const descEl = resolveSelector(article, 'description', warnings);
      const description = descEl.text().trim();

      // Language
      const langEl = resolveSelector(article, 'language', warnings);
      const languageExtracted = langEl.text().trim();

      // Stars
      const starsEl = resolveSelector(article, 'stars', warnings);
      const starsRaw = starsEl.text().trim();
      const starsNum = parseNumericField(starsRaw);
      if (starsRaw.length > 0 && starsNum === 0) {
        warnings.push(`Rank ${String(rank)}: unparseable stars value "${starsRaw}"`);
      }

      // Forks
      const forksEl = resolveSelector(article, 'forks', warnings);
      const forksRaw = forksEl.text().trim();
      const forksNum = parseNumericField(forksRaw);
      if (forksRaw.length > 0 && forksNum === 0) {
        warnings.push(`Rank ${String(rank)}: unparseable forks value "${forksRaw}"`);
      }

      // Today stars
      const todayStarsEl = resolveSelector(article, 'todayStars', warnings);
      const todayStarsRaw = todayStarsEl.last().text().trim();
      const todayStarsNum = parseNumericField(todayStarsRaw);
      if (todayStarsRaw.length > 0 && todayStarsNum === 0) {
        warnings.push(`Rank ${String(rank)}: unparseable todayStars value "${todayStarsRaw}"`);
      }

      results.push({
        rank: results.length + 1,
        owner,
        repo,
        fullName: `${owner}/${repo}`,
        description,
        language: languageExtracted,
        stars: starsNum,
        todayStars: todayStarsNum,
        forks: forksNum,
        url: repoUrl,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      warnings.push(`Rank ${String(rank)}: extraction error — ${errMsg}, skipping`);
      skippedCount++;
      logger.warn({ err: errMsg, rank }, 'Skipping trending repo item due to extraction error');
    }
  });

  // Prepend summary warning if any items were skipped
  if (skippedCount > 0) {
    warnings.unshift(
      `${String(skippedCount)} of ${String(rank)} trending items were skipped due to parse/validation errors`,
    );
  }

  const trimmed = results.slice(0, limit);
  const result: TrendingResult = { repos: trimmed, warnings };

  // Cache the result
  cache.set(key, result);

  return result;
}
