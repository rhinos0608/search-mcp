export function canonicalizeRedditPermalink(permalink: string): string {
  if (permalink.startsWith('http://') || permalink.startsWith('https://')) {
    const parsed = new URL(permalink);
    return `https://www.reddit.com${parsed.pathname}${parsed.search}`;
  }

  return `https://www.reddit.com${permalink}`;
}
