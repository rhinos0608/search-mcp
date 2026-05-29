/**
 * Detects bot-challenge / blocker content in extracted page text.
 */

export interface ContentChallengeResult {
  isChallenge: boolean;
  reason?: string;
}

const SHORT_CONTENT_THRESHOLD = 500;

const CHALLENGE_PATTERNS = [
  'just a moment',
  'attention required',
  'verify you are human',
  'checking your browser',
  'access denied',
  'cloudflare',
  'cf-ray',
  'captcha',
  'enable javascript',
  'please enable cookies',
] as const;

/**
 * Analyze extracted text content for bot-challenge indicators.
 *
 * Checks for common challenge/blocker phrases in the combined title+content.
 * Token-length conditions apply to a subset of patterns.
 */
export function detectContentChallenge(
  title: string,
  content: string,
): ContentChallengeResult {
  const haystack = `${title}\n${content}`.toLowerCase();
  const contentOnlyShort = content.length < SHORT_CONTENT_THRESHOLD;

  for (const token of CHALLENGE_PATTERNS) {
    // Apply length condition to the subset of patterns that require it.
    if (
      (token === 'enable javascript' || token === 'please enable cookies') &&
      !contentOnlyShort
    ) {
      continue;
    }

    if (haystack.includes(token)) {
      return { isChallenge: true, reason: token };
    }
  }

  return { isChallenge: false };
}
