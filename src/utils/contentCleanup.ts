/**
 * Content cleanup utilities for web_read and web_crawl output.
 *
 * Removes common noise artifacts from extracted text/markdown:
 * - Literal `\n` sequences (from JSON/JS string escaping in page content)
 * - Navigation/copyright boilerplate in plain text
 * - Excessive whitespace
 */

/**
 * Clean a text string produced by Readability or fallback extraction.
 * Removes literal \n sequences, normalizes whitespace, and strips common
 * navigation boilerplate patterns.
 */
export function cleanTextContent(text: string): string {
  if (!text) return '';

  let cleaned = text;

  // 1. Replace literal backslash-n sequences (not actual newlines) with space.
  //    These are often found when JS string content or JSON payloads leak
  //    into the extracted text.
  cleaned = cleaned.replace(/\\n/g, ' ');

  // 2. Replace literal \t, \r, \b with space
  cleaned = cleaned.replace(/\\[trb]/g, ' ');

  // 3. Collapse runs of whitespace within lines
  cleaned = cleaned.replace(/[^\S\n]{2,}/g, ' ');

  // 4. Remove lines that are pure navigation/footer boilerplate
  const lines = cleaned.split('\n');
  const filtered: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      filtered.push(line);
      continue;
    }

    // Single-word all-caps nav labels ("HOME", "ABOUT", "CONTACT", "SERVICES")
    // Must be at least 3 chars to avoid stripping single-letter or two-letter content.
    if (
      /^[A-Z][A-Z\s]+$/.test(trimmed) &&
      trimmed.length >= 3 &&
      trimmed.length <= 30
    ) {
      continue;
    }

    // Footer boilerplate
    if (
      /^\s*(?:©|copyright|all rights reserved|privacy policy|terms of service|terms of use|cookie policy|sitemap)\b/i.test(
        trimmed,
      )
    ) {
      continue;
    }

    // "Skip to content", "Skip to navigation" accessibility links
    if (/^skip to (?:content|navigation|main|text)/i.test(trimmed)) continue;

    // "Back to top"
    if (/^back to top/i.test(trimmed)) continue;

    // "Share:", "Follow us:", "Share this:"
    if (/^\s*(?:share|follow\s+us|share\s+this|connect|social|more\s+from)\s*:/i.test(trimmed))
      continue;

    // Breadcrumb: "Home > Category > Page"
    if (/^[a-z][a-z\s]*\s*>\s*[a-z]/i.test(trimmed) && trimmed.length < 100) continue;

    // "Posted on" / "Published on" / "Updated" dates
    if (
      /^\s*(?:posted|published|updated|modified|written|authored)\s+(?:on|by|at)\b/i.test(
        trimmed,
      ) &&
      trimmed.length < 120
    )
      continue;

    // "Last updated:"
    if (/^\s*last\s+(?:updated|modified|edited)\s*:/i.test(trimmed)) continue;

    // Powered by / built with
    if (/^\s*(?:powered by|built with)\b/i.test(trimmed)) continue;

    filtered.push(line);
  }

  cleaned = filtered.join('\n');

  // 5. Collapse multiple consecutive blank lines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // 6. Remove leading/trailing whitespace
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Strip navigation boilerplate and clean noise from markdown text.
 * More aggressive than cleanTextContent — also strips markdown link nav rows.
 */
export function cleanMarkdownContent(markdown: string): string {
  if (!markdown) return '';

  let cleaned = markdown;

  // 1. Literal escape sequences
  cleaned = cleaned.replace(/\\n/g, ' ');
  cleaned = cleaned.replace(/\\[trb]/g, ' ');

  // 2. Strip lines that are markdown nav bars: [Link](url) [Link](url) [Link](url)
  const lines = cleaned.split('\n');
  const filtered: string[] = [];
  let inCodeFence = false;

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      inCodeFence = !inCodeFence;
      filtered.push(line);
      continue;
    }

    if (inCodeFence) {
      filtered.push(line);
      continue;
    }

    const trimmed = line.trim();

    // Empty lines pass through
    if (trimmed.length === 0) {
      filtered.push(line);
      continue;
    }

    // Markdown link nav row: 3+ inline links
    const linkMatches = trimmed.match(/\[[^\]]+\]\([^)]+\)/g);
    if (linkMatches && linkMatches.length >= 3) {
      const linkChars = linkMatches.reduce((sum, m) => sum + m.length, 0);
      if (linkChars / trimmed.length > 0.5) {
        continue;
      }
    }

    // Pure link row: [Link] | [Link] • [Link] * [Link]
    if (/^(?:\[[^\]]+\]\([^)]+\)\s*[|•·*/]\s*)*\[[^\]]+\]\([^)]+\)/.test(trimmed)) {
      continue;
    }

    // Apply text content cleaning to non-markdown-structural lines
    if (
      !line.trimStart().startsWith('|') &&
      !line.trimStart().startsWith('>') &&
      !line.trimStart().startsWith('#') &&
      !line.trimStart().startsWith('-') &&
      !line.trimStart().startsWith('*') &&
      !/^\d+\.\s/.test(line.trimStart())
    ) {
      // Apply inline text cleanup
      const cleanLine = cleanTextContent(trimmed);
      if (cleanLine.length === 0) continue;
      // Replace line with its original indentation + cleaned text
      // (keep original line for non-empty results)
    }

    filtered.push(line);
  }

  cleaned = filtered.join('\n');

  // 3. Collapse blank lines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}
