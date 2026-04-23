const EXACT_PATTERNS = [
  /OneTrust/i,
  /Cookiebot/i,
  /cookie consent/i,
  /Your Privacy Choices/i,
  /Manage Cookies/i,
  /Accept All Cookies/i,
  /We use cookies to/i,
  /By continuing to use this site/i,
  // German
  /Cookie-Einstellungen/i,
  /Alle Cookies akzeptieren/i,
  // French
  /Accepter les cookies/i,
  /Paramètres de cookies/i,
  // Spanish
  /Aceptar cookies/i,
  /Configuraci[oó]n de cookies/i,
];

export function isCookieBannerPage(markdown: string): boolean {
  const lines = markdown.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;

  const bannerLines: string[] = [];
  const exactIndices = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (EXACT_PATTERNS.some((p) => p.test(line))) {
      bannerLines.push(line);
      exactIndices.add(i);
    }
  }

  let consecutive = 0;
  let hasButton = false;
  let exactInStreak = 0;
  let structuralLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const lower = line.toLowerCase();
    const isExact = exactIndices.has(i);
    const hasKeyword =
      isExact ||
      /\b(cookie|cookies|consent|privacy|tracking|gdpr|ccpa)\b/i.test(lower) ||
      /datenschutz|confidentialit[eé]|privacidad/i.test(lower);
    if (hasKeyword) {
      consecutive++;
      if (isExact) exactInStreak++;
      if (
        /\b(accept|reject|manage)\b/i.test(lower) ||
        /akzeptieren|accepter|aceptar|param[eè]tres|configuraci[oó]n|einstellungen/i.test(lower)
      ) {
        hasButton = true;
      }
    } else {
      if (consecutive >= 3 && hasButton) {
        structuralLines += consecutive - exactInStreak;
      }
      consecutive = 0;
      hasButton = false;
      exactInStreak = 0;
    }
  }
  if (consecutive >= 3 && hasButton) {
    structuralLines += consecutive - exactInStreak;
  }

  const totalBannerLines = bannerLines.length + structuralLines;
  return totalBannerLines / lines.length > 0.4;
}
