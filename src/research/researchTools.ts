/**
 * ResearchTools factory — wraps real search tool implementations into a
 * simplified interface for worker agents.
 *
 * Each method catches errors and returns empty results on failure so that
 * worker agents handle graceful degradation without try/catch.
 */

import { webSearch } from '../tools/webSearch.js';
import { webCrawl } from '../tools/webCrawl.js';
import { webRead } from '../tools/webRead.js';
import { academicSearch } from '../tools/academicSearch.js';
import { getGitHubRepoSearch } from '../tools/githubRepoSearch.js';
import { redditSearch } from '../tools/redditSearch.js';
import { hackernewsSearch } from '../tools/hackernewsSearch.js';
import { loadConfig } from '../config.js';
import type { ResearchTools } from './types.js';

export interface ResearchToolsOptions {
  /** Called before each tool invocation — used for budget tracking / logging. */
  onToolCall?: (tool: string, query: string) => void;
}

/**
 * Create a ResearchTools instance that wraps the real search tool functions.
 *
 * Every method is guarded: errors are caught and return empty arrays (or a
 * blank result for webRead) so callers never need to handle tool-level
 * exceptions.
 */
export function createResearchTools(options?: ResearchToolsOptions): ResearchTools {
  const { onToolCall } = options ?? {};

  return {
    async webSearch(query: string, limit?: number) {
      onToolCall?.('web_search', query);
      try {
        const results = await webSearch(query, limit ?? 10);
        return results.map((r) => ({
          title: r.title,
          url: r.url,
          description: r.description,
          ...(r.age ? { age: r.age } : {}),
        }));
      } catch {
        return [];
      }
    },

    async webCrawl(url: string, maxPages?: number) {
      onToolCall?.('web_crawl', url);
      try {
        const cfg = loadConfig();
        const result = await webCrawl(
          url,
          cfg.crawl4ai.baseUrl,
          cfg.crawl4ai.apiToken ?? '',
          {
            strategy: 'bfs',
            maxDepth: 1,
            maxPages: maxPages ?? 1,
            includeExternalLinks: false,
          },
        );
        return result.pages.map((p) => ({
          title: p.title ?? '',
          url: p.url,
          markdown: p.markdown,
        }));
      } catch {
        return [];
      }
    },

    async webRead(url: string) {
      onToolCall?.('web_read', url);
      try {
        const result = await webRead(url);
        return {
          title: result.title ?? '',
          url: result.url,
          markdown: result.textContent,
        };
      } catch {
        return { title: '', url, markdown: '' };
      }
    },

    async academicSearch(query: string, limit?: number) {
      onToolCall?.('academic_search', query);
      try {
        const result = await academicSearch(query, 'all', limit ?? 20);
        return result.papers.map((p) => ({
          title: p.title,
          url: p.url,
          ...(p.abstract ? { abstract: p.abstract } : {}),
          ...(p.year ? { year: p.year } : {}),
        }));
      } catch {
        return [];
      }
    },

    async githubSearch(query: string, limit?: number) {
      onToolCall?.('github_search', query);
      try {
        const result = await getGitHubRepoSearch(
          query,
          undefined,
          undefined,
          undefined,
          undefined,
          limit ?? 30,
        );
        return result.results.map((r) => ({
          fullName: r.repo,
          htmlUrl: r.htmlUrl,
          description: '',
        }));
      } catch {
        return [];
      }
    },

    async redditSearch(query: string, limit?: number) {
      onToolCall?.('reddit_search', query);
      try {
        const results = await redditSearch(query, '', 'relevance', 'year', limit ?? 25);
        return results.map((r) => ({
          title: r.title,
          url: r.url,
          selftext: r.selftext,
          created_utc: r.createdUtc,
          permalink: r.permalink,
        }));
      } catch {
        return [];
      }
    },

    async hackernewsSearch(query: string, limit?: number) {
      onToolCall?.('hackernews_search', query);
      try {
        const results = await hackernewsSearch(query, 'story', 'relevance', null, limit ?? 20);
        return results.map((r) => ({
          title: r.title,
          url: r.url ?? '',
          ...(r.storyText ? { text: r.storyText } : {}),
        }));
      } catch {
        return [];
      }
    },
  };
}
