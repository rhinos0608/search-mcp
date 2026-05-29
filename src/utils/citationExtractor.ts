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

// Matches URLs up to whitespace or common structural delimiters.
// Allows parentheses and brackets which are valid in URLs.
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;

/** Locates the SOURCES block and returns its trimmed content, or null. */
function parseSourcesBlock(text: string): string | null {
  const startIndex = text.indexOf(SOURCES_START);
  const endIndex = text.lastIndexOf(SOURCES_END);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return null;
  }

  const blockStart = startIndex + SOURCES_START.length;
  return text.slice(blockStart, endIndex).trim();
}

export function extractSourceBlock(text: string): string[] {
  const blockContent = parseSourcesBlock(text);

  if (blockContent === null) {
    const fallbackUrls = text.match(URL_REGEX) ?? [];
    return deduplicate(
      fallbackUrls
        .filter((url) => !isDiscoveryDomain(url))
        .filter((url) => !url.includes('source=g')),
    );
  }

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
  const blockContent = parseSourcesBlock(answer);
  return blockContent !== null && blockContent.toUpperCase() === 'NONE';
}

export function normalizeUrlForCitation(url: string): string {
  try {
    const parsed = new URL(url);

    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');

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