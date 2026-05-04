/**
 * Sophisticated content filtering utilities for web crawling.
 * Provides multi-layer filtering for cookie banners, navigation, ads, and boilerplate.
 */

import { logger } from '../logger.js';

// Common boilerplate patterns (navigation, ads, etc.)
const BOILERPLATE_PATTERNS = [
  // Navigation patterns
  /^\s*home\s*[/|>]\s*/i,
  /^\s*main\s*menu\s*/i,
  /^\s*skip\s*(to\s*)?content\s*/i,
  /^\s*back\s*to\s*top\s*/i,
  /^\s*←\s*previous\s*/i,
  /^\s*next\s*→\s*/i,

  // Footer patterns
  /^\s*all\s*rights\s*reserved\s*/i,
  /^\s*copyright\s*[©®]\s*/i,
  /^\s*terms\s*(of\s*service|&\s*conditions)?\s*/i,
  /^\s*privacy\s*policy\s*/i,
  /^\s*contact\s*us\s*/i,
  /^\s*about\s*us\s*/i,
  /^\s*sitemap\s*/i,

  // Advertisement patterns
  /^\s*advertisement\s*/i,
  /^\s*sponsored\s*(content|links)?\s*/i,
  /^\s*promoted\s*/i,
  /^\s*ad\s*choices\s*/i,

  // Job board navigation patterns
  /^\s*community\s*/i,
  /^\s*for\s+employers?\s*/i,
  /^\s*search\s+(?:jobs?|companies?|salaries)\s*/i,
  /^\s*notifications?\s*/i,
  /^\s*messages?\s*/i,
  /^\s*profile\s*/i,
  /^\s*dashboard\s*/i,
  /^\s*settings\s*/i,
  /^\s*sign\s+out\s*/i,
  /^\s*log\s+out\s*/i,
  /^\s*upload\s+(?:your\s+)?(?:cv|resume)\s*/i,
  /^\s*create\s+job\s+alert\s*/i,
  /^\s*save\s+this\s+job\s*/i,
  /^\s*discover\s+more\s*/i,
  /^\s*related\s+(?:jobs?|searches?|companies?|salaries?)\s*/i,
  /^\s*similar\s+(?:jobs?|roles?|positions?)\s*/i,
  /^\s*people\s+also\s+(?:viewed|searched|applied)\s*/i,
  /^\s*loading\s*/i,
  /^\s*skip\s+to\s+content\s*/i,
  /^\s*cookie\s+(?:policy|settings|preferences)\s*/i,
  /^\s*accessibility\s*/i,
];

// Social media and sharing patterns
const SOCIAL_PATTERNS = [
  /^\s*share\s*(this|on)?\s*/i,
  /^\s*follow\s*us\s*/i,
  /^\s*like\s*us\s*on\s*/i,
  /^\s*connect\s*with\s*us\s*/i,
];

// Newsletter and subscription patterns
const SUBSCRIPTION_PATTERNS = [
  /^\s*subscribe\s*(to\s*our\s*newsletter)?\s*/i,
  /^\s*sign\s*up\s*(for\s*our\s*newsletter)?\s*/i,
  /^\s*join\s*our\s*mailing\s*list\s*/i,
  /^\s*get\s*updates\s*delivered\s*to\s*your\s*inbox\s*/i,
];

// Common cookie-related patterns (beyond the cookie banner detection)
const COOKIE_CONTENT_PATTERNS = [
  /^\s*manage\s*your\s*cookies\s*/i,
  /^\s*cookie\s*preferences\s*/i,
  /^\s*update\s*cookie\s*settings\s*/i,
];

interface FilterStats {
  totalLines: number;
  removedLines: number;
  categories: Record<string, number>;
}

/**
 * Classifies a line of text into content categories.
 */
function classifyLine(line: string): string[] {
  const categories: string[] = [];
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return ['empty'];
  }

  // Check boilerplate patterns
  for (const pattern of BOILERPLATE_PATTERNS) {
    if (pattern.test(trimmed)) {
      categories.push('boilerplate');
      break;
    }
  }

  // Check social patterns
  for (const pattern of SOCIAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      categories.push('social');
      break;
    }
  }

  // Check subscription patterns
  for (const pattern of SUBSCRIPTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      categories.push('subscription');
      break;
    }
  }

  // Check cookie patterns
  for (const pattern of COOKIE_CONTENT_PATTERNS) {
    if (pattern.test(trimmed)) {
      categories.push('cookie');
      break;
    }
  }

  // If no category matched, it's likely content
  if (categories.length === 0) {
    categories.push('content');
  }

  return categories;
}

/**
 * Calculates content density metrics for a text.
 */
function calculateContentDensity(text: string): {
  density: number;
  linkDensity: number;
  textLength: number;
} {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { density: 0, linkDensity: 0, textLength: 0 };
  }

  let totalChars = 0;
  let linkChars = 0;
  let contentLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    totalChars += trimmed.length;

    // Count markdown link characters
    const linkMatches = trimmed.match(/\[([^\]]+)\]\(([^)]+)\)/g);
    if (linkMatches) {
      linkChars += linkMatches.reduce((sum, m) => sum + m.length, 0);
    }

    // Check if this line is likely content
    const categories = classifyLine(trimmed);
    if (categories.includes('content')) {
      contentLines++;
    }
  }

  const density = contentLines / lines.length;
  const linkDensity = totalChars > 0 ? linkChars / totalChars : 0;

  return { density, linkDensity, textLength: totalChars };
}

/**
 * Filters content using multiple sophisticated strategies.
 */
export function filterContent(
  markdown: string,
  options: {
    removeBoilerplate?: boolean;
    removeSocial?: boolean;
    removeSubscriptions?: boolean;
    removeCookieContent?: boolean;
    minContentDensity?: number;
  } = {},
): { filtered: string; stats: FilterStats } {
  const {
    removeBoilerplate = true,
    removeSocial = true,
    removeSubscriptions = true,
    removeCookieContent = true,
    minContentDensity = 0.3,
  } = options;

  const lines = markdown.split('\n');
  const stats: FilterStats = {
    totalLines: lines.length,
    removedLines: 0,
    categories: {},
  };

  const filteredLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Always preserve empty lines for structure
    if (trimmed.length === 0) {
      filteredLines.push(line);
      continue;
    }

    const categories = classifyLine(trimmed);

    // Track statistics
    for (const cat of categories) {
      stats.categories[cat] = (stats.categories[cat] ?? 0) + 1;
    }

    // Determine if we should remove this line
    let shouldRemove = false;

    if (removeBoilerplate && categories.includes('boilerplate')) {
      shouldRemove = true;
    }

    if (removeSocial && categories.includes('social')) {
      shouldRemove = true;
    }

    if (removeSubscriptions && categories.includes('subscription')) {
      shouldRemove = true;
    }

    if (removeCookieContent && categories.includes('cookie')) {
      shouldRemove = true;
    }

    if (shouldRemove) {
      stats.removedLines++;
    } else {
      filteredLines.push(line);
    }
  }

  // Post-filtering: check content density of result
  const result = filteredLines.join('\n');
  const density = calculateContentDensity(result);

  // If density is too low, we may have filtered too aggressively
  if (density.density < minContentDensity && density.textLength > 100) {
    logger.warn(
      {
        density: density.density,
        linkDensity: density.linkDensity,
        textLength: density.textLength,
      },
      'Content filter produced low-density output; consider adjusting filters',
    );
  }

  return { filtered: result, stats };
}

/**
 * Extracts main content using heuristics when structured extraction fails.
 */
export function extractMainContent(markdown: string): string {
  const lines = markdown.split('\n');
  const contentBlocks: string[] = [];
  let currentBlock: string[] = [];
  let inContent = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines at the start
    if (trimmed.length === 0 && !inContent) {
      continue;
    }

    // Detect headers (potential content start)
    if (/^#{1,3}\s+/.test(trimmed)) {
      inContent = true;
      if (currentBlock.length > 0) {
        contentBlocks.push(currentBlock.join('\n'));
        currentBlock = [];
      }
    }

    // Skip navigation-like patterns
    const isNav = /^\s*[←→<>]|\|\s*\w+\s*\|/.test(trimmed);
    if (isNav && !inContent) {
      continue;
    }

    currentBlock.push(line);
  }

  if (currentBlock.length > 0) {
    contentBlocks.push(currentBlock.join('\n'));
  }

  // Return the largest content block
  if (contentBlocks.length === 0) {
    return markdown;
  }

  return contentBlocks.reduce((a, b) => (a.length > b.length ? a : b));
}

/**
 * Sanitizes markdown to remove potentially harmful content.
 */
export function sanitizeMarkdown(markdown: string): string {
  // Remove HTML script tags and event handlers
  const sanitized = markdown
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+\son\w+=["'][^"']*["']/gi, (match) =>
      match.replace(/\s+on\w+=["'][^"']*["']/gi, ''),
    )
    .replace(/javascript:/gi, 'blocked:');

  return sanitized;
}
