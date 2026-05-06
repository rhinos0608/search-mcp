/**
 * V4.2.0 — Result compaction engine for deep_research tool.
 *
 * Applies multi-layer compaction to ResearchResult for MCP transport:
 *   1. Trim timeline to milestone-only events
 *   2. Trim findings: cap at max findings, drop excess, truncate verbosity
 *   3. Write full result to temp file (claim-check pattern)
 *   4. Build CompactResearchResult with summary + file pointer
 *   5. Hard size guard — never exceeds COMPACT_HARD_LIMIT bytes
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../logger.js';
import type {
   CompactResearchResult,
   CompactFinding,
   CompactContradiction,
   CompactStatistics,
   CompactionOptions,
   Finding,
   Contradiction,
   ResearchResult,
   ResearchProgress,
} from './types.js';

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_MAX_FINDINGS_PER_THEME = 20;
const DEFAULT_MAX_EXCERPT_CHARS = 200;
const COMPACT_SOFT_LIMIT = 256 * 1024; // 256 KB
const COMPACT_HARD_LIMIT = 512 * 1024; // 512 KB
const DEFAULT_MAX_SUMMARY_CHARS = 2_000;

function getDefaultOptions(): Required<CompactionOptions> {
   const dbPath = process.env.DATABASE_PATH;
   const baseDir = dbPath
      ? path.join(dbPath, 'deep-research')
      : path.join(os.tmpdir(), 'search-mcp', 'deep-research');

   return {
      maxFindingsPerTheme: DEFAULT_MAX_FINDINGS_PER_THEME,
      maxExcerptChars: DEFAULT_MAX_EXCERPT_CHARS,
      softSizeLimit: COMPACT_SOFT_LIMIT,
      hardSizeLimit: COMPACT_HARD_LIMIT,
      maxSummaryChars: DEFAULT_MAX_SUMMARY_CHARS,
      fileBaseDir: baseDir,
   };
}

// ── Layer 1: Compact timeline ─────────────────────────────────────────────────

/** Milestone-only timeline events (no inline finding/contradiction data). */
export type CompactTimelineEvent =
   | { phase: 'decomposition'; subQuestionCount: number }
   | { phase: 'taxonomy_revision'; revised: boolean }
   | { phase: 'discovery'; sourceCount: number }
   | { phase: 'extraction'; completed: number; total: number }
   | { phase: 'gap_analysis'; gapsFound: number }
   | { phase: 'audit'; issues: number }
   | { phase: 'synthesis' }
   | { phase: 'limitations'; limitationCount: number }
   | { phase: 'complete' };

/**
 * Strip inline data arrays from timeline, keeping milestone events only.
 */
export function compactTimeline(timeline: ResearchProgress[]): CompactTimelineEvent[] {
   const events: CompactTimelineEvent[] = [];

   for (const entry of timeline) {
      switch (entry.phase) {
         case 'decomposition': {
            events.push({
               phase: 'decomposition',
               subQuestionCount: entry.plan.subQuestions.length,
            });
            break;
         }
         case 'taxonomy_revision': {
            events.push({
               phase: 'taxonomy_revision',
               revised: true,
            });
            break;
         }
         case 'discovery': {
            const totalSources = entry.sources.reduce((sum, s) => sum + s.count, 0);
            events.push({ phase: 'discovery', sourceCount: totalSources });
            break;
         }
         case 'extraction': {
            events.push({
               phase: 'extraction',
               completed: entry.completed,
               total: entry.total,
            });
            break;
         }
         case 'findings':
         case 'contradictions': {
            // Skip — inline arrays are the bulk. The report has summary stats.
            break;
         }
         case 'gap_analysis': {
            events.push({ phase: 'gap_analysis', gapsFound: entry.gaps.length });
            break;
         }
         case 'synthesis': {
            events.push({ phase: 'synthesis' });
            break;
         }
         case 'limitations': {
            events.push({ phase: 'limitations', limitationCount: entry.limitations.length });
            break;
         }
         case 'complete': {
            events.push({ phase: 'complete' });
            break;
         }
      }
   }

   return events;
}

// ── Layer 2: Trim findings ────────────────────────────────────────────────────

/**
 * Convert a single Finding to CompactFinding, truncating verbose fields.
 */
function compactSingleFinding(f: Finding, maxExcerptChars: number): CompactFinding {
   const excerpt =
      f.evidenceExcerpt !== undefined
         ? f.evidenceExcerpt.length > maxExcerptChars
            ? f.evidenceExcerpt.slice(0, maxExcerptChars) + '…'
            : f.evidenceExcerpt
         : undefined;
   return {
      id: f.id,
      claim: f.claim,
      evidenceSummary: f.evidenceSummary,
      ...(excerpt !== undefined ? { evidenceExcerpt: excerpt } : {}),
      evidenceDirectness: f.evidenceDirectness,
      sourceCount: f.sourceIds.length,
      claimType: f.claimType,
      subQuestionIds: [...f.subQuestionIds],
   };
}

/**
 * Cap findings at maxFindings, preserving input order.
 *
 * Rules:
 *   - Keep at most maxFindings entries
 *   - Preserves original ordering
 */
export function trimFindings(
   allFindings: Finding[],
   maxFindings: number,
   options: Required<CompactionOptions>,
): { compact: CompactFinding[]; droppedCap: number } {
   const { maxExcerptChars } = options;

   // Cap at maxFindings, but at least keep top 5
   const cap = Math.max(5, maxFindings);
   const capped = allFindings.slice(0, cap);
   const droppedCap = allFindings.length - capped.length;

   const compact = capped.map((f) => compactSingleFinding(f, maxExcerptChars));

   return { compact, droppedCap };
}

// ── Contradiction compaction ──────────────────────────────────────────────────

function compactContradiction(c: Contradiction): CompactContradiction {
   return {
      id: c.id,
      claimA: c.claimA,
      claimB: c.claimB,
      contradictionType: c.contradictionType,
      resolutionStatus: c.resolutionStatus,
   };
}

// ── Layer 3: Write to file ────────────────────────────────────────────────────

let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule periodic cleanup of old result files (>1 hour).
 */
function scheduleCleanup(dir: string): void {
   if (cleanupTimer) return;
   cleanupTimer = setTimeout(() => {
      cleanupTimer = null;
      try {
         const cutoff = Date.now() - 3_600_000; // 1 hour
         for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith('.json')) {
               const p = path.join(dir, entry.name);
               const stat = fs.statSync(p);
               if (stat.mtimeMs < cutoff) {
                  fs.unlinkSync(p);
               }
            }
         }
      } catch {
         // Non-fatal — best-effort cleanup
      }
   }, 300_000); // Check every 5 minutes
}

/**
 * Write the full ResearchResult to a JSON file.
 * Returns the file path, or null if write failed.
 */
export function writeFullResultToFile(result: ResearchResult, baseDir?: string): string | null {
   const dir = baseDir ?? getDefaultOptions().fileBaseDir;

   try {
      fs.mkdirSync(dir, { recursive: true });
      const id = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
      const filePath = path.join(dir, `deep-research-${id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
      scheduleCleanup(dir);
      return filePath;
   } catch (err) {
      logger.warn({ err }, 'Failed to write full research result to file');
      return null;
   }
}

// ── Layer 5: Size guard ───────────────────────────────────────────────────────

/**
 * Aggressively truncate the compact result to stay under the hard limit.
 * Truncates executive summary first, then drops findings from the end.
 */
function applySizeGuard(
   compact: CompactResearchResult,
   softLimit: number,
   hardLimit: number,
   maxSummaryChars: number,
): CompactResearchResult {
   const serialized = JSON.stringify(compact);
   const bytes = Buffer.byteLength(serialized, 'utf-8');

   if (bytes <= softLimit) {
      compact.statistics.totalBytes = bytes;
      return compact;
   }

   // Over soft limit — truncate executive summary first
   if (compact.executiveSummary.length > maxSummaryChars) {
      compact.executiveSummary = compact.executiveSummary.slice(0, maxSummaryChars) + '…';
   }
   compact.statistics.furtherTruncated = true;

   const afterSummary = Buffer.byteLength(JSON.stringify(compact), 'utf-8');
   if (afterSummary <= hardLimit) {
      compact.statistics.totalBytes = afterSummary;
      return compact;
   }

   // Still over hard limit — drop findings from the end
   const findings = [...compact.findings];
   let dropped = 0;
   while (findings.length > 5) {
      findings.pop();
      dropped++;
      const sz = Buffer.byteLength(JSON.stringify({ ...compact, findings }), 'utf-8');
      if (sz <= hardLimit) break;
   }

   compact.findings = findings;
   compact.statistics.droppedByCapCount += dropped;
   compact.statistics.totalBytes = Buffer.byteLength(JSON.stringify(compact), 'utf-8');

   return compact;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Compact a full ResearchResult for MCP-friendly transport.
 *
 * Returns a CompactResearchResult with:
 *   - Milestone-only timeline
 *   - Top findings (trimmed, capped)
 *   - Summary statistics
 *   - File path to full result on disk
 *   - Hard size guard to never exceed COMPACT_HARD_LIMIT
 */
export function compactResearchResult(
   result: ResearchResult,
   options?: CompactionOptions,
): CompactResearchResult {
   const opts: Required<CompactionOptions> = {
      ...getDefaultOptions(),
      ...options,
   };

   const { report, timeline } = result;

   // Layer 1: Compact timeline
   const compactTimelineEvents = compactTimeline(timeline);

   // Layer 2: Trim findings
   const maxFindings = opts.maxFindingsPerTheme * Math.max(report.themes.length, 1);
   const allFindings = extractAllFindings(timeline);
   const { compact: compactF, droppedCap: dc } = trimFindings(allFindings, maxFindings, opts);

   // Layer 3: Write full result to file
   const filePath = writeFullResultToFile(result, opts.fileBaseDir);

   // Contradictions — compact all
   const contradictions = report.contradictions.map(compactContradiction);

   // Layer 4: Build compact result with the compacted findings from themes
   const statistics: CompactStatistics = {
      sourceCount: report.sourceCount,
      sourceTypeCount: report.sourceTypeCount,
      sourceDiversity: report.sourceDiversity,
      totalFindingCount: report.findingCount,
      includedFindingCount: compactF.length,
      droppedByCapCount: dc,
      contradictionCount: contradictions.length,
      timelinePhaseCount: compactTimelineEvents.length,
   };

   // Build compact findings deduplicated globally
   const compact: CompactResearchResult = {
      query: report.query,
      classification: report.classification,
      depth: report.depth,
      executiveSummary: report.executiveSummary,
      findings: compactF,
      contradictions,
      uncertainties: [...report.uncertainties],
      openQuestions: [...report.openQuestions],
      limitations: [...report.limitations],
      ...(report.recommendations ? { recommendations: report.recommendations } : {}),
      statistics,
      fullResultFile: filePath,
   };

   if (!filePath && opts.fileBaseDir) {
      compact.warning =
         'Full result could not be written to disk. Only compact summary is available.';
   }

   // Layer 5: Hard size guard
   return applySizeGuard(compact, opts.softSizeLimit, opts.hardSizeLimit, opts.maxSummaryChars);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Extract all Finding objects from the timeline's findings events.
 */
function extractAllFindings(timeline: ResearchProgress[]): Finding[] {
   const all: Finding[] = [];
   const seen = new Set<string>();

   for (const entry of timeline) {
      if (entry.phase === 'findings') {
         for (const f of entry.findings) {
            if (!seen.has(f.id)) {
               seen.add(f.id);
               all.push(f);
            }
         }
      }
   }

   return all;
}
