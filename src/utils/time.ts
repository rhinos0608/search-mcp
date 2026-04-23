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
