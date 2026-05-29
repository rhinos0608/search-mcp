/**
 * Utilities for formatting collated search findings as markdown.
 */

export interface FindingEntry {
  url: string;
  title?: string;
  author?: string;
  published?: string;
  content?: string;
  wordCount?: number;
  domain?: string;
  rank?: number;
}

/**
 * Escapes backtick runs to prevent breaking markdown fenced code blocks.
 * Splits each run with a zero-width space so no three consecutive backticks
 * can close the fence prematurely.
 */
function escapeBackticks(text: string): string {
  return text.replace(/`+/g, (match) => match.split('').join('\u200b'));
}

/** Nullish coalescing fallback helper. */
function orDefault<T>(value: T | undefined | null, fallback: T): T {
  return value ?? fallback;
}

/** Safe string coercion. */
function safeStr(value: string | undefined | null): string {
  return value ?? '';
}

/**
 * Formats an array of finding entries into a structured markdown string.
 */
export function formatCollatedFindings(findings: FindingEntry[]): string {
  const validFindings = findings.filter((f) => f.url.trim());
  if (validFindings.length === 0) {
    return 'No sources were extracted.';
  }

  const formatted = validFindings.map((finding) => {
    const title = orDefault(finding.title, 'Untitled');
    const author = orDefault(finding.author, 'Unknown');
    const published = orDefault(finding.published, 'Unknown');
    const domain = safeStr(finding.domain);
    const rank = finding.rank !== undefined ? `#${String(finding.rank)}` : '';

    let meta = `**Title:** ${title}\n`;
    if (author) meta += `**Author:** ${author}\n`;
    if (published) meta += `**Published Date:** ${published}\n`;
    if (domain) meta += `**Domain:** ${domain}\n`;
    if (rank) meta += `**Rank:** ${rank}\n`;
    meta += `**URL:** ${finding.url}`;

    const content = finding.content ? `\n\n${escapeBackticks(finding.content)}` : '';

    return `${meta}${content}\n\n---`;
  });

  return formatted.join('\n\n');
}

/**
 * Formats a list of failed tool call errors into a markdown string.
 */
export function formatFailedCalls(errors: { url: string; error: string }[]): string {
  if (errors.length === 0) {
    return '';
  }

  const header = '## Failed Calls\n\n';
  const items = errors
    .map((e) => `- **URL:** ${e.url}\n  - **Error:** ${e.error}`)
    .join('\n');

  return header + items;
}