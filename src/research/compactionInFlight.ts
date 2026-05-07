/**
 * V5.3.0 — In-Flight Context Compaction Engine.
 *
 * Monitors research state size and applies progressively aggressive compaction
 * to prevent unbounded state growth during the research loop.
 *
 * Inspired by OpenDev's ACC (arXiv 2603.05344v1) Algorithm 1:
 *   Stage 1 (p > 70%): Log warning, no action
 *   Stage 2 (p > 85%): Evict orphan sources with no findings
 *   Stage 3 (p > 95%): Compress findings — drop evidenceExcerpt
 *   Stage 4 (p > 99%): Claim-check — write full state to temp file,
 *                       compress remaining findings
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../logger.js';
import type { ResearchStateEngine, BudgetTracker } from './state.js';
import type { Finding, ResearchState } from './types.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CompactionStage {
   level: number;
   name: string;
   applied: boolean;
   entriesEvicted: number;
}

export interface CompactionReport {
   stages: CompactionStage[];
   totalEvicted: number;
   stateSizeBefore: number;
   stateSizeAfter: number;
}

// ── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_SOFT_LIMIT_PERCENT = 0.7;
const TOOL_OUTPUT_OFFLOAD_THRESHOLD = 8000; // chars
const TOOL_OUTPUT_TRUNCATE_THRESHOLD = 2000; // chars
const TOOL_OUTPUT_PREVIEW_CHARS = 500;

// ── InFlightCompactor ──────────────────────────────────────────────────────

export class InFlightCompactor {
   private state: ResearchStateEngine;
   private budget: BudgetTracker;
   private softLimitPercent: number;

   constructor(
      state: ResearchStateEngine,
      budget: BudgetTracker,
      options?: { softLimitPercent?: number },
   ) {
      this.state = state;
      this.budget = budget;
      this.softLimitPercent = options?.softLimitPercent ?? DEFAULT_SOFT_LIMIT_PERCENT;
   }

   // ── Public API ─────────────────────────────────────────────────────────

   /**
    * Compute state pressure and apply the appropriate compaction stage.
    *
    * Pressure = (sources.length + findings.length + gaps.length) / maxStateEntries
    *
    * Stages are applied cascadingly — if pressure surpasses a threshold the
    * corresponding action is taken, and subsequent stages use the post-stage state.
    *
    * Returns a CompactionReport detailing what was done.
    */
   compact(): CompactionReport {
      const maxEntries = this.budget.profile.maxStateEntries;
      if (maxEntries <= 0) {
         return {
            stages: [],
            totalEvicted: 0,
            stateSizeBefore: 0,
            stateSizeAfter: 0,
         };
      }

      const snapshot = this.state.getState();
      const stateSizeBefore = snapshot.sources.length + snapshot.findings.length + snapshot.gaps.length;
      const pressure = stateSizeBefore / maxEntries;

      const stages: CompactionStage[] = [];
      let totalEvicted = 0;

      // ── Stage 1: Soft limit warning ────────────────────────────────────────
      if (pressure > this.softLimitPercent) {
         logger.warn(
            {
               pressure: Math.round(pressure * 100),
               stateSize: stateSizeBefore,
               maxEntries,
               sources: snapshot.sources.length,
               findings: snapshot.findings.length,
               gaps: snapshot.gaps.length,
            },
            'InFlight compaction stage 1: state exceeds soft limit',
         );
         stages.push({
            level: 1,
            name: 'warning',
            applied: true,
            entriesEvicted: 0,
         });
      } else {
         stages.push({
            level: 1,
            name: 'warning',
            applied: false,
            entriesEvicted: 0,
         });
      }

      // ── Stage 2: Evict orphan sources ──────────────────────────────────────
      if (pressure > 0.85) {
         const evicted = this.evictOrphanSources();
         totalEvicted += evicted;
         stages.push({
            level: 2,
            name: 'source_eviction',
            applied: true,
            entriesEvicted: evicted,
         });
      } else {
         stages.push({
            level: 2,
            name: 'source_eviction',
            applied: false,
            entriesEvicted: 0,
         });
      }

      // Recompute pressure after source eviction
      const snapshotAfter2 = this.state.getState();
      const sizeAfter2 = snapshotAfter2.sources.length + snapshotAfter2.findings.length + snapshotAfter2.gaps.length;
      const pressureAfter2 = sizeAfter2 / maxEntries;

      // ── Stage 3: Compress findings ─────────────────────────────────────────
      let compressedInStage3 = 0;
      if (pressureAfter2 > 0.95) {
         compressedInStage3 = this.compressFindings();
         totalEvicted += compressedInStage3;
         stages.push({
            level: 3,
            name: 'finding_compression',
            applied: true,
            entriesEvicted: compressedInStage3,
         });
      } else {
         stages.push({
            level: 3,
            name: 'finding_compression',
            applied: false,
            entriesEvicted: 0,
         });
      }

      // Recompute pressure after finding compression
      const snapshotAfter3 = this.state.getState();
      const sizeAfter3 = snapshotAfter3.sources.length + snapshotAfter3.findings.length + snapshotAfter3.gaps.length;
      const pressureAfter3 = sizeAfter3 / maxEntries;

      // ── Stage 4: Claim-check ───────────────────────────────────────────────
      if (pressureAfter3 > 0.99) {
         const result = this.claimCheckState();
         totalEvicted += result.evicted;
         stages.push({
            level: 4,
            name: 'claim_check',
            applied: true,
            entriesEvicted: result.evicted,
         });
      } else {
         stages.push({
            level: 4,
            name: 'claim_check',
            applied: false,
            entriesEvicted: 0,
         });
      }

      const finalSnapshot = this.state.getState();
      const stateSizeAfter =
         finalSnapshot.sources.length + finalSnapshot.findings.length + finalSnapshot.gaps.length;

      const report: CompactionReport = {
         stages,
         totalEvicted,
         stateSizeBefore,
         stateSizeAfter,
      };

      if (totalEvicted > 0) {
         logger.info(
            { totalEvicted, stateSizeBefore, stateSizeAfter },
            'InFlight compaction complete',
         );
      }

      return report;
   }

   /**
    * Summarize or offload large tool output strings.
    *
    * - >8000 chars: write full output to temp file, return 500-char preview
    * - 2001-8000 chars: truncate to 2000 chars with "[truncated]" suffix
    * - <=2000 chars: return as-is
    */
   summarizeToolOutput(
      result: string,
      maxChars?: number,
   ): { summary: string; offloaded: boolean; offloadPath?: string } {
      const offloadThreshold = maxChars ?? TOOL_OUTPUT_OFFLOAD_THRESHOLD;
      const truncateThreshold = TOOL_OUTPUT_TRUNCATE_THRESHOLD;
      const previewChars = TOOL_OUTPUT_PREVIEW_CHARS;

      if (result.length > offloadThreshold) {
         try {
            const dir = path.join(os.tmpdir(), 'search-mcp', 'tool-output');
            fs.mkdirSync(dir, { recursive: true });
            const id = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
            const filePath = path.join(dir, `tool-output-${id}.txt`);
            fs.writeFileSync(filePath, result, 'utf-8');
            return {
               summary: result.slice(0, previewChars),
               offloaded: true,
               offloadPath: filePath,
            };
         } catch (err) {
            logger.warn({ err }, 'InFlight compaction: failed to offload tool output');
            return {
               summary: result.slice(0, previewChars),
               offloaded: false,
            };
         }
      }

      if (result.length > truncateThreshold) {
         return {
            summary: result.slice(0, truncateThreshold) + '... [truncated]',
            offloaded: false,
         };
      }

      return {
         summary: result,
         offloaded: false,
      };
   }

   // ── Private helpers ────────────────────────────────────────────────────

   /**
    * Stage 2: Evict sources with no findings referencing them that have
    * survived more than 1 gap loop.
    *
    * Uses the state's loopCount as a proxy for gap-loop age: if at least one
    * gap loop has completed, pending sources with no findings are considered
    * stale enough to evict.
    *
    * @returns Number of sources evicted.
    */
   private evictOrphanSources(): number {
      const snapshot = this.state.getState();
      const loopCount = snapshot.flags.loopCount;

      // Only evict when we've been through at least 1 gap loop
      if (loopCount < 1) return 0;

      // Build set of source IDs referenced by any finding
      const findingSourceIds = new Set<string>();
      for (const f of snapshot.findings) {
         for (const sid of f.sourceIds) {
            findingSourceIds.add(sid);
         }
      }

      const sources = snapshot.sources;
      const toRemove: string[] = [];

      for (const s of sources) {
         if (s.extractionStatus === 'pending' && !findingSourceIds.has(s.id)) {
            toRemove.push(s.id);
         }
      }

      if (toRemove.length === 0) return 0;

      const prunedSources = sources.filter((s) => !toRemove.includes(s.id));
      const newState: ResearchState = { ...snapshot, sources: prunedSources };
      this.state.fromJSON(newState);

      logger.info(
         { evicted: toRemove.length, reason: 'orphan_sources_no_findings' },
         'InFlight compaction stage 2: evicted sources with no findings',
      );

      return toRemove.length;
   }

   /**
    * Stage 3: Compress findings by dropping evidenceExcerpt while keeping
    * evidenceSummary and claim intact.
    *
    * @returns Number of findings modified.
    */
   private compressFindings(): number {
      const snapshot = this.state.getState();
      let modified = 0;

      const compressedFindings: Finding[] = snapshot.findings.map((f) => {
         if (f.evidenceExcerpt !== undefined && f.evidenceExcerpt !== '') {
            modified++;
            return { ...f, evidenceExcerpt: '' };
         }
         return { ...f };
      });

      if (modified === 0) return 0;

      const newState: ResearchState = { ...snapshot, findings: compressedFindings };
      this.state.fromJSON(newState);

      logger.info(
         { modified },
         'InFlight compaction stage 3: compressed finding excerpts',
      );

      return modified;
   }

   /**
    * Stage 4: Claim-check — write full state to a temp file and compress
    * all remaining findings to summary-only (drop evidenceExcerpt).
    *
    * Returns the number of findings compressed and the (optional) file path.
    */
   private claimCheckState(): { evicted: number; path: string | null } {
      const snapshot = this.state.getState();
      let filePath: string | null = null;

      try {
         const dir = path.join(os.tmpdir(), 'search-mcp', 'claim-check');
         fs.mkdirSync(dir, { recursive: true });

         // Clean up old claim-check files (keep at most 5)
         try {
            const existing = fs.readdirSync(dir).filter((f) => f.startsWith('state-') && f.endsWith('.json'));
            if (existing.length >= 5) {
               existing.sort();
               for (const old of existing.slice(0, existing.length - 4)) {
                  fs.unlinkSync(path.join(dir, old));
               }
            }
         } catch { /* cleanup is best-effort */ }

         const id = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
         filePath = path.join(dir, `state-${id}.json`);
         fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
         logger.info({ filePath, stateSize: snapshot.sources.length + snapshot.findings.length + snapshot.gaps.length }, 'InFlight compaction stage 4: wrote full state to claim-check file');
      } catch (err) {
         logger.warn({ err }, 'InFlight compaction stage 4: failed to write claim-check file');
      }

      // Compress all findings — remove evidenceExcerpt
      const compressedFindings: Finding[] = snapshot.findings.map((f) => ({
         ...f,
         evidenceExcerpt: '',
      }));

      const evicted = snapshot.findings.length;
      const newState: ResearchState = { ...snapshot, findings: compressedFindings };
      this.state.fromJSON(newState);

      return { evicted, path: filePath };
   }
}
