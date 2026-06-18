/**
 * Consolidated agentic browse tool family.
 *
 * Provides a browse+present pattern for fetching and extracting web content
 * with document storage between calls.
 *
 * Actions:
 *   browse           — Fetch a web page and store its content for later retrieval
 *   present          — Extract-readable content from a previously browsed page
 *   browse_and_present — Convenience: fetch, store, and present in one call
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../../config.js';
import type { KnowledgeGraphHook } from '../../knowledge/hook.js';
import { assertSafeUrl, safeResponseText } from '../../httpGuards.js';
import { registerFamily, type FamilyDefinition } from '../registry.js';

// ── In-memory document store ────────────────────────────────────────────────

const MAX_DOCUMENTS = 100;
const DOCUMENT_TTL_MS = 30 * 60 * 1000;

const documentStore = new Map<string, { url: string; content: string; timestamp: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of documentStore) {
    if (now - entry.timestamp > DOCUMENT_TTL_MS) {
      documentStore.delete(id);
    }
  }
  while (documentStore.size > MAX_DOCUMENTS) {
    const oldestKey = documentStore.keys().next().value;
    if (!oldestKey) break;
    documentStore.delete(oldestKey);
  }
}, 60_000).unref();

// ── Content extraction helpers ──────────────────────────────────────────────

/** Fetches a URL with SSRF guard, timeout, and safe text extraction. */
async function fetchPage(url: string): Promise<{ content: string; status: number }> {
  assertSafeUrl(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 30000);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; search-mcp/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)} ${response.statusText} for URL "${url}"`);
  }

  const content = await safeResponseText(response, url);
  return { content, status: response.status };
}

/**
 * Parse the page title from HTML content.
 */
function extractTitle(html: string): string {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return match ? (match[1] ?? '').trim() : '';
}

/**
 * Strip HTML tags from content.
 */
function stripHtml(html: string): string {
  return (
    html
      // Remove script and style elements with their contents
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      // Remove HTML comments
      .replace(/<!--[\s\S]*?-->/g, '')
      // Remove all HTML tags
      .replace(/<[^>]+>/g, ' ')
      // Decode common HTML entities
      .replace(/&nbsp;/g, ' ')
      .replace(/</g, '<')
      .replace(/>/g, '>')
      .replace(/"/g, '"')
      .replace(/&#39;/g, "'")
      // &amp; last so entities like &amp;lt; are not double-decoded
      .replace(/&amp;/g, '&')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// ── Action schemas (discriminated on "action") ──────────────────────────────

const browseSchema = z.object({
  action: z.literal('browse').describe('Fetch a web page and store its content'),
  url: z.string().describe('The URL to fetch'),
});

const presentSchema = z.object({
  action: z.literal('present').describe('Extract readable content from a previously browsed page'),
  documentId: z.string().describe('The document ID returned from browse'),
  maxChars: z
    .number()
    .int()
    .min(1)
    .max(50000)
    .optional()
    .default(12000)
    .describe('Maximum characters to return (1–50000, default 12000)'),
});

const browseAndPresentSchema = z.object({
  action: z.literal('browse_and_present').describe('Fetch and extract content in one call'),
  url: z.string().describe('The URL to fetch'),
  maxChars: z
    .number()
    .int()
    .min(1)
    .max(50000)
    .optional()
    .default(12000)
    .describe('Maximum characters to return (1–50000, default 12000)'),
});

// ── Family definition ──────────────────────────────────────────────────────

const agenticBrowseFamily: FamilyDefinition = {
  name: 'agentic_browse',
  description:
    'Browse web pages and extract their readable content. ' +
    'Use `browse` to fetch and store a page, `present` to retrieve readable content from a stored document, ' +
    'or `browse_and_present` for a combined convenience call.',
  actions: [
    {
      name: 'browse',
      description: 'Fetch a web page and store its content for later extraction',
      schema: browseSchema,
      handler: async (args) => {
        const { url } = args as { url: string };
        const { content, status } = await fetchPage(url);

        const documentId = randomUUID();
        documentStore.set(documentId, { url, content, timestamp: Date.now() });

        return {
          documentId,
          url,
          status,
          bytes: new TextEncoder().encode(content).length,
        };
      },
    },
    {
      name: 'present',
      description: 'Extract readable content from a previously browsed page',
      schema: presentSchema,
      handler: async (args) => {
        const { documentId, maxChars } = args as { documentId: string; maxChars: number };

        const stored = documentStore.get(documentId);
        if (!stored) {
          throw new Error(
            `Document not found: "${documentId}". Call browse first to fetch the page.`,
          );
        }

        const { url, content } = stored;
        const title = extractTitle(content);
        const plainContent = stripHtml(content);
        const truncated = plainContent.length > maxChars;
        const truncatedContent = truncated ? plainContent.slice(0, maxChars) : plainContent;
        const wordCount = truncatedContent.split(/\s+/).filter(Boolean).length;

        return {
          documentId,
          url,
          title,
          content: truncatedContent,
          wordCount,
          truncated,
        };
      },
    },
    {
      name: 'browse_and_present',
      description: 'Fetch a web page and extract its readable content in one call',
      schema: browseAndPresentSchema,
      handler: async (args) => {
        const { url, maxChars } = args as { url: string; maxChars: number };
        const { content } = await fetchPage(url);

        const title = extractTitle(content);
        const plainContent = stripHtml(content);
        const truncated = plainContent.length > maxChars;
        const truncatedContent = truncated ? plainContent.slice(0, maxChars) : plainContent;
        const wordCount = truncatedContent.split(/\s+/).filter(Boolean).length;

        const documentId = randomUUID();
        documentStore.set(documentId, { url, content, timestamp: Date.now() });

        return {
          documentId,
          url,
          title,
          content: truncatedContent,
          wordCount,
          truncated,
        };
      },
    },
  ],
};

// ── Registration ───────────────────────────────────────────────────────────

export function registerAgenticBrowseTool(
  server: McpServer,
  cfg: SearchConfig,
  kgHook?: KnowledgeGraphHook,
): void {
  registerFamily(server, agenticBrowseFamily, cfg, kgHook);
}

/**
 * Action-level capability report for health checks.
 */
export function agenticBrowseCapabilities(cfg: SearchConfig) {
  return agenticBrowseFamily.actions.map((a) => ({
    name: `agentic_browse.${a.name}`,
    available: a.configIssue ? a.configIssue(cfg) === null : true,
    issue: a.configIssue ? a.configIssue(cfg) : null,
  }));
}
