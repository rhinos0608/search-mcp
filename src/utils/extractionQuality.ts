/**
 * Extraction Quality Detector
 *
 * Determines whether Crawl4AI extraction succeeded or should use document extraction.
 * Provides configurable quality thresholds and detailed diagnostics.
 */

import type { CrawlPageResult } from '../types.js';
import { logger } from '../logger.js';

// ============================================================================
// Types
// ============================================================================

export interface QualityCheck {
  /** Whether quality check passed */
  passed: boolean;
  /** Quality score (0-100) */
  score: number;
  /** Issues found during quality check */
  issues: string[];
  /** Specific escalation triggers identified */
  escalations: string[];
}

export interface QualityConfig {
  /** Minimum text length to consider valid */
  minTextLength: number;
  /** Minimum ratio of text to HTML */
  minTextToHtmlRatio: number;
  /** Maximum ratio of boilerplate content */
  maxBoilerplateRatio: number;
  /** Whether to require a title */
  requireTitle: boolean;
  /** Whether to require body content */
  requireBodyContent: boolean;
  /** Maximum navigation score */
  maxNavigationScore: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: QualityConfig = {
  minTextLength: 500,
  minTextToHtmlRatio: 0.1,
  maxBoilerplateRatio: 0.7,
  requireTitle: true,
  requireBodyContent: true,
  maxNavigationScore: 0.5,
};

// ============================================================================
// Quality Check Implementation
// ============================================================================

/**
 * Calculate quality score for Crawl4AI extraction
 *
 * @param result - Crawl4AI extraction result
 * @param config - Quality check configuration (optional)
 * @returns Quality check result with score and issues
 */
export function checkExtractionQuality(
  result: CrawlPageResult,
  config: Partial<QualityConfig> = {},
): QualityCheck {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const issues: string[] = [];
  const escalations: string[] = [];
  let score = 100;

  // 1. Check for extraction failure
  if (!result.success || result.errorMessage) {
    issues.push(`Extraction failed: ${result.errorMessage ?? 'Unknown error'}`);
    escalations.push('primary_extraction_failed');
    score = 0;
    return { passed: false, score, issues, escalations };
  }

  // 2. Check text length (use markdown content since CrawlPageResult doesn't have textContent)
  const textLength = result.markdown.length;
  if (textLength < cfg.minTextLength) {
    issues.push(`Text too short: ${String(textLength)} chars (min: ${String(cfg.minTextLength)})`);
    escalations.push('text_too_short');
    score -= 20;
  }

  // 3. Check for meaningful title
  if (cfg.requireTitle && (!result.title || result.title.trim().length < 3)) {
    issues.push('Missing or invalid title');
    escalations.push('missing_title');
    score -= 15;
  }

  // 4. Check for body content
  const hasBody = result.elements?.some((e) => e.type === 'text' || e.type === 'heading');
  if (cfg.requireBodyContent && !hasBody) {
    issues.push('No body content found');
    escalations.push('missing_body');
    score -= 25;
  }

  // 5. Check for table-heavy content
  const tableCount = result.elements?.filter((e) => e.type === 'table').length ?? 0;
  if (tableCount > 3) {
    issues.push(`Many tables detected (${String(tableCount)}), may need structured extraction`);
    escalations.push('table_heavy');
    score -= 10;
  }

  // 6. Check for image-heavy content
  const imageCount = result.elements?.filter((e) => e.type === 'image').length ?? 0;
  if (imageCount > 10) {
    issues.push(`Many images detected (${String(imageCount)}), may need specialized processing`);
    escalations.push('image_heavy');
    score -= 5;
  }

  // Determine pass/fail
  const passed = score >= 60 && escalations.length === 0;

  return { passed, score: Math.max(0, score), issues, escalations };
}

/**
 * Determine if document extraction escalation is needed based on quality check
 *
 * @param quality - Quality check result
 * @param contentType - Content type from HTTP headers or URL
 * @returns Whether to escalate to document extraction
 */
export function shouldEscalateExtraction(quality: QualityCheck, contentType?: string): boolean {
  // Always escalate for document types
  const documentTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument',
    'application/vnd.ms-powerpoint',
    'application/vnd.ms-excel',
    'application/postscript',
  ];

  if (contentType) {
    const normalizedType = contentType.toLowerCase();
    if (documentTypes.some((dt) => normalizedType.includes(dt))) {
      logger.debug({ contentType }, 'Escalating to document extraction: document type');
      return true;
    }

    // Escalate for images that might need OCR
    if (normalizedType.startsWith('image/')) {
      logger.debug({ contentType }, 'Escalating to document extraction: image type');
      return true;
    }
  }

  // Escalate if quality check indicates specific issues
  const escalationTriggers = [
    'primary_extraction_failed',
    'table_heavy',
    'image_heavy',
    'missing_body',
    'text_too_short',
  ];

  const hasEscalationTrigger = quality.escalations.some((e) => escalationTriggers.includes(e));

  if (hasEscalationTrigger) {
    logger.debug(
      { escalations: quality.escalations },
      'Escalating to document extraction: quality triggers',
    );
    return true;
  }

  return false;
}

/**
 * Determine content type from URL and headers
 *
 * @param url - Request URL
 * @param headers - HTTP response headers
 * @returns Detected content type
 */
export function determineContentType(url: string, headers?: Headers): string | undefined {
  // Check Content-Type header first
  if (headers) {
    const contentType: string | null = headers.get('content-type');
    if (contentType !== null) {
      const parts = contentType.split(';');
      return parts[0]?.trim() ?? '';
    }
  }

  // Infer from URL extension
  let pathnameLower: string;
  try {
    const parsed = new URL(url);
    pathnameLower = parsed.pathname.toLowerCase();
  } catch {
    pathnameLower = url.toLowerCase();
  }
  if (pathnameLower.endsWith('.pdf')) return 'application/pdf';
  if (pathnameLower.endsWith('.doc')) return 'application/msword';
  if (pathnameLower.endsWith('.docx'))
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (pathnameLower.endsWith('.ppt')) return 'application/vnd.ms-powerpoint';
  if (pathnameLower.endsWith('.pptx'))
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (pathnameLower.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (pathnameLower.endsWith('.xlsx'))
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (pathnameLower.endsWith('.png')) return 'image/png';
  if (pathnameLower.endsWith('.jpg') || pathnameLower.endsWith('.jpeg')) return 'image/jpeg';
  if (pathnameLower.endsWith('.gif')) return 'image/gif';
  if (pathnameLower.endsWith('.webp')) return 'image/webp';

  return undefined;
}
