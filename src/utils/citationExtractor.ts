/**
 * Parses structured SOURCES blocks from LLM/agent output text.
 */

const SOURCES_START = 'SOURCES';
const SOURCES_END = 'SOURCES';

const DISCOVERY_DOMAINS = new Set([
  'duckduckgo.com',
  'bing.com',
  'google.com',
  'search.brave.com',
]);

const TRACKING_PARAMS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref', 'source']);

const URL_REGEX = /https?:\/\/[^\s)\]]+/g;

export function extractSourceBlock(text: string): string[] {
  const startIndex = text.indexOf(SOURCES_START);
  const endIndex = text.lastIndexOf(SOURCES_END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const blockStart = startIndex + SOURCES_START.length;
    const blockContent = text.slice(blockStart, endIndex).trim();

    if (blockContent.toUpperCase() === 'NONE') {
      return [];
    }

    const urls = blockContent
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => !isDiscoveryDomain(line));

    return deduplicate(urls);
  }

  const fallbackUrls = text.match(URL_REGEX) ?? [];
  return fallbackUrls
    .filter((url) => !isDiscoveryDomain(url))
    .filter((url) => !url.includes('source=g'));
}

function deduplicate(urls: string[]): string[] {
  const seen = new Set<string>();
  return urls.filter((url) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function isDiscoveryDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return DISCOVERY_DOMAINS.has(hostname);
  } catch {
    return false;
  }
}

export function isExplicitNone(answer: string): boolean {
  const startIndex = answer.indexOf(SOURCES_START);
  const endIndex = answer.lastIndexOf(SOURCES_END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const blockStart = startIndex + SOURCES_START.length;
    const blockContent = answer.slice(blockStart, endIndex).trim();
    return blockContent.toUpperCase() === 'NONE';
  }

  return false;
}

export function normalizeUrlForCitation(url: string): string {
  try {
    const parsed = new URL(url);

    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();

    parsed.searchParams.forEach((_, key) => {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    });

    parsed.hash = '';

    return parsed.toString();
  } catch {
    return url.toLowerCase();
  }
}