export function daysSince(date: Date): number {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  return diffMs / (1000 * 60 * 60 * 24);
}

export function parseAgeToDays(ageStr: string | null | undefined): number | null {
  if (ageStr == null || ageStr === '') {
    return null;
  }

  const trimmed = ageStr.trim();

  // "X days ago", "X weeks ago", "X hours ago"
  const relativeRe = /^(\d+(?:\.\d+)?)\s+(day|days|week|weeks|hour|hours)\s+ago$/i;
  const relativeMatch = relativeRe.exec(trimmed);
  if (relativeMatch) {
    const rawValue = relativeMatch[1];
    const rawUnit = relativeMatch[2];
    if (rawValue == null || rawUnit == null) {
      return null;
    }
    const value = parseFloat(rawValue);
    const unit = rawUnit.toLowerCase();
    if (unit.startsWith('day')) {
      return value;
    }
    if (unit.startsWith('week')) {
      return value * 7;
    }
    if (unit.startsWith('hour')) {
      return value / 24;
    }
  }

  // ISO date or Date.parse fallback
  const parsedDate = new Date(trimmed);
  if (!isNaN(parsedDate.getTime())) {
    return daysSince(parsedDate);
  }

  return null;
}

/** Options for `formatRelativeAge`. */
export interface RelativeAgeOptions {
  /** Epoch ms "now" for resolving absolute dates deterministically (default `Date.now()`). */
  now?: number;
}

const RELATIVE_AGE_RE = /^(\d+(?:\.\d+)?)\s+(second|minute|min|hour|day|week|month|year)s?\s+ago$/i;

/** Render a non-negative age (in hours) with exact natural singular/plural labels. */
function formatAgeHours(totalHours: number): string {
  // Floor (not round) elapsed units so a boundary like 23.5h is "23 hours",
  // 1.5 days is "1 day", and 13 days is "1 week" — never rounded up.
  if (totalHours >= 24 * 365) {
    const v = Math.floor(totalHours / (24 * 365));
    return v === 1 ? '1 year ago' : `${String(v)} years ago`;
  }
  if (totalHours >= 24 * 30) {
    const v = Math.floor(totalHours / (24 * 30));
    return v === 1 ? '1 month ago' : `${String(v)} months ago`;
  }
  if (totalHours >= 24 * 7) {
    const v = Math.floor(totalHours / (24 * 7));
    return v === 1 ? '1 week ago' : `${String(v)} weeks ago`;
  }
  if (totalHours >= 24) {
    const v = Math.floor(totalHours / 24);
    return v === 1 ? '1 day ago' : `${String(v)} days ago`;
  }
  const h = Math.floor(totalHours);
  if (h <= 0) return 'less than an hour ago';
  return h === 1 ? '1 hour ago' : `${String(h)} hours ago`;
}

/**
 * Deterministic relative publication age for a raw age value, or null when the
 * value is absent, unparseable, or in the future. Existing relative provider
 * strings ("4 days ago") normalize directly with no clock involved, so there is
 * no ambient clock drift; absolute dates resolve against an optional injected
 * `now` (epoch ms) for deterministic tests.
 */
export function formatRelativeAge(
  ageStr: string | null | undefined,
  options: RelativeAgeOptions = {},
): string | null {
  const trimmed = (ageStr ?? '').trim();
  if (trimmed.length === 0) return null;
  const nowMs = options.now ?? Date.now();
  const rel = RELATIVE_AGE_RE.exec(trimmed);
  let totalHours: number | null = null;
  if (rel !== null) {
    const raw = rel[1];
    const unit = (rel[2] ?? '').toLowerCase();
    if (raw !== undefined && unit !== '') {
      const v = Number.parseFloat(raw);
      if (Number.isFinite(v)) {
        if (unit.startsWith('year')) totalHours = v * 24 * 365;
        else if (unit.startsWith('month')) totalHours = v * 24 * 30;
        else if (unit.startsWith('week')) totalHours = v * 24 * 7;
        else if (unit.startsWith('day')) totalHours = v * 24;
        else if (unit.startsWith('hour')) totalHours = v;
        else if (unit.startsWith('min')) totalHours = v / 60;
        else if (unit.startsWith('sec')) totalHours = v / 3600;
      }
    }
  } else {
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      totalHours = (nowMs - parsed.getTime()) / 3_600_000;
    }
  }
  if (totalHours === null || !Number.isFinite(totalHours)) return null;
  if (totalHours < 0) return null; // future
  return formatAgeHours(totalHours);
}

/**
 * Parse a modern arXiv YYMM ID (e.g. `2310.09386` → year 2023, October) from a
 * URL and return the publication year, or null when the URL is not an arXiv ID.
 * Two-digit year-of-century is mapped: `00`–`50` → 20YY, `51`–`99` → 19YY, so a
 * modern `2310` ID is never mistaken for 2026 or later.
 */
export function parseArxivYear(url: string): number | null {
  const match = /arxiv\.org\/(?:abs|pdf)\/(\d{4})\.\d{4,5}/i.exec(url);
  const id = match?.[1];
  if (id === undefined) return null;
  const yy = Math.floor(Number(id) / 100);
  if (!Number.isFinite(yy)) return null;
  return yy <= 50 ? 2000 + yy : 1900 + yy;
}
