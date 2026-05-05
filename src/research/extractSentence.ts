/**
 * Extract the sentence containing a character offset.
 * Walks backward to find the sentence start and forward to find the end.
 */
export function extractSentence(text: string, offset: number): string | null {
  if (offset < 0 || offset >= text.length) return null;

  // Find sentence start: walk backward to previous period/newline or start
  let start = offset;
  while (start > 0) {
    const ch = text[start - 1];
    if (ch === '.' || ch === '!' || ch === '?') {
      // Check for abbreviation (e.g., "Dr.", "etc.") — skip single-word periods
      const wordStart = start - 1;
      let wordStartScan = wordStart - 1;
      while (wordStartScan >= 0 && /\w/.test(text[wordStartScan] ?? '')) {
        wordStartScan--;
      }
      const word = text.slice(wordStartScan + 1, wordStart).toLowerCase();
      const abbreviations = new Set([
        'dr',
        'mr',
        'ms',
        'mrs',
        'vs',
        'etc',
        'inc',
        'ltd',
        'co',
        'dept',
        'est',
        'approx',
        'fig',
        'al',
        'e.g',
        'i.e',
      ]);
      if (abbreviations.has(word)) {
        start = wordStartScan + 1;
        continue;
      }
      break;
    }
    if (ch === '\n' && text[start] !== '\n') break; // single newline mid-sentence
    if (ch === '\n' && start + 1 < text.length && text[start] === '\n') break; // blank line
    start--;
  }

  // Find sentence end: walk forward to period/newline or end
  let end = offset;
  while (end < text.length) {
    const ch = text[end];
    if (ch === '.' || ch === '!' || ch === '?') {
      end++; // include punctuation
      // Skip closing quote, paren, bracket
      if (end < text.length && /[)'"}\]»]/.test(text[end] ?? '')) end++;
      break;
    }
    if (ch === '\n' && end + 1 < text.length && text[end + 1] === '\n') break; // blank line
    end++;
  }

  const sentence = text.slice(Math.max(0, start), Math.min(text.length, end)).trim();
  if (sentence.length < 10) return null;

  return sentence;
}
