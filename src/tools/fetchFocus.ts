import type { SearchConfig } from '../config.js';
import { callOpenAiChatCompletion } from '../utils/llmChat.js';
import { webCrawl } from './webCrawl.js';
import { scrubContent } from '../utils/contentScrubber.js';

export interface FetchFocusResult {
  title: string;
  url: string;
  focus: string;
  extractedText: string;
  usedFallback: boolean;
}

export async function fetchFocus(
  url: string,
  focus: string,
  cfg: SearchConfig,
): Promise<FetchFocusResult> {
  if (cfg.crawl4ai.baseUrl.length === 0) {
    throw new Error('fetch_focus requires CRAWL4AI_BASE_URL.');
  }

  if (!cfg.llm.baseUrl || !cfg.llm.model) {
    throw new Error('fetch_focus requires DEEP_RESEARCH_BASE_URL and DEEP_RESEARCH_MODEL.');
  }

  const crawled = await webCrawl(url, cfg.crawl4ai.baseUrl, cfg.crawl4ai.apiToken, {
    strategy: 'bfs',
    maxDepth: 1,
    maxPages: 1,
    includeExternalLinks: false,
  });

  const page = crawled.pages[0];
  if (!page?.markdown) {
    throw new Error(`No content extracted from ${url}`);
  }

  const rawContent = page.markdown.slice(0, 20_000);
  // Scrub raw content to mitigate prompt injection before sending to LLM
  const scrubbed =
    process.env.SCRUB_CONTENT === 'true' ? scrubContent(rawContent).content : rawContent;

  const extractResp = await callOpenAiChatCompletion({
    messages: [
      {
        role: 'system',
        content:
          'Extract verbatim spans from web pages that answer a specific question. Return only the relevant excerpts, preserving source wording where possible. Be concise.',
      },
      {
        role: 'user',
        content: `Question: ${focus}\n\n<page>\n${scrubbed}\n</page>`,
      },
    ],
    temperature: 0.3,
    maxTokens: 2000,
    model: cfg.llm.model,
    baseUrl: cfg.llm.baseUrl,
    ...(cfg.llm.apiToken ? { apiToken: cfg.llm.apiToken } : {}),
  });

  const extractedText =
    extractResp.success && extractResp.content.trim().length > 0
      ? extractResp.content
      : rawContent.slice(0, 3000);

  return {
    title: page.title ?? '',
    url,
    focus,
    extractedText,
    usedFallback: !extractResp.success || extractResp.content.trim().length === 0,
  };
}
