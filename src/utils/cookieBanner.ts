const EXACT_PATTERNS = [
  /OneTrust/i,
  /Cookiebot/i,
  /cookie consent/i,
  /Your Privacy Choices/i,
  /Manage Cookies/i,
  /Accept All Cookies/i,
  /We use cookies to/i,
  /By continuing to use this site/i,
];

export function isCookieBannerPage(markdown: string): boolean {
  const lines = markdown.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;

  const bannerLines: string[] = [];
  const exactIndices = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (EXACT_PATTERNS.some((p) => p.test(line))) {
      bannerLines.push(line);
      exactIndices.add(i);
    }
  }

  let consecutive = 0;
  let hasButton = false;
  let structuralLines = 0;
  for (let i = 0; i < lines.length; i++) {
    if (exactIndices.has(i)) {
      if (consecutive >= 3 && hasButton) {
        structuralLines += consecutive;
      }
      consecutive = 0;
      hasButton = false;
      continue;
    }
    const line = lines[i]!;
    const lower = line.toLowerCase();
    const hasKeyword = /\b(cookie|cookies|consent|privacy|tracking|gdpr|ccpa)\b/i.test(lower);
    if (hasKeyword) {
      consecutive++;
      if (/\b(accept|reject|manage)\b/i.test(lower)) {
        hasButton = true;
      }
    } else {
      if (consecutive >= 3 && hasButton) {
        structuralLines += consecutive;
      }
      consecutive = 0;
      hasButton = false;
    }
  }
  if (consecutive >= 3 && hasButton) {
    structuralLines += consecutive;
  }

  const totalBannerLines = bannerLines.length + structuralLines;
  return totalBannerLines / lines.length > 0.4;
}
