/**
 * Content quality — bot challenge and login wall detection for interactive browsing.
 *
 * These functions analyze rendered page text (not raw HTML headers or status codes)
 * to determine whether the page is blocked by a bot challenge or login wall.
 *
 * For HTTP-level challenge detection (status codes, headers), see src/utils/botChallenge.ts.
 */

// ── Bot challenge patterns ────────────────────────────────────────────────────
// Common phrases found on Cloudflare, DataDome, PerimeterX, and generic CDN
// challenge pages.
const BOT_CHALLENGE_PATTERNS = [
  /just a moment/i,
  /check(?:ing)? your browser/i,
  /verify(?:ing)? (you are|you're) human/i,
  /enable javascript/i,
  /cloudflare/i,
  /ddos protection/i,
  /attention required/i,
  /cf-challenge/i,
  /challenge-platform/i,
  /browser integrity check/i,
  /security check/i,
  /we are checking your connection/i,
  /please stand by/i,
  /one more step/i,
  /confirm you are not a robot/i,
  /datadome/i,
  /perimeterx/i,
  /human verific(?:ation|ator)/i,
  /blocked due to security/i,
  /access denied/i,
  /you have been blocked/i,
  /suspicious activity detected/i,
];

// ── Login wall patterns ───────────────────────────────────────────────────────

const LOGIN_WALL_PATTERNS = [
  /sign\s*in/i,
  /log\s*in/i,
  /please (?:sign|log)\s*in/i,
  /sign\s*in to continue/i,
  /log\s*in to view/i,
  /sign\s*in to read/i,
  /subscribe to read/i,
  /this content is (?:for|behind)/i,
  /member[-\s]?only content/i,
  /premium content/i,
  /paywall/i,
  /subscribe to continue/i,
  /create an account to continue/i,
  /create a free account/i,
  /enter your (?:email|password)/i,
  /welcome back/i,
  /don't have an account/i,
  /forgot (?:your )?password/i,
];

/**
 * Determine whether the given page text indicates a bot challenge screen.
 * Checks for CDN/WAF challenge phrases.
 */
export function isBotChallenge(text: string): boolean {
  if (!text || text.length === 0) return false;
  // Bot challenge pages are typically short (< 2000 chars) and dense with
  // challenge phrases. Score ≥ 2 indicates a challenge.
  let score = 0;
  for (const pattern of BOT_CHALLENGE_PATTERNS) {
    if (pattern.test(text)) {
      score++;
      if (score >= 2) return true;
    }
  }
  // If text is short (< 500 chars) and contains at least one pattern,
  // it's very likely a challenge page.
  return score >= 1 && text.length < 500;
}

/**
 * Determine whether the given page text indicates a login wall.
 * Uses a scoring heuristic: login pages are typically short and contain
 * multiple authentication-related phrases.
 */
export function isLoginWall(text: string): boolean {
  if (!text || text.length === 0) return false;
  // Login walls usually have < 800 chars of visible text.
  // If the page is very long (> 5000 chars), it's unlikely to be a pure login gate.
  if (text.length > 5000) return false;
  let score = 0;
  for (const pattern of LOGIN_WALL_PATTERNS) {
    if (pattern.test(text)) {
      score++;
      if (score >= 2) return true;
    }
  }
  return score >= 2;
}
