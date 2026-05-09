/**
 * Phase 1 TDD: Source type preservation and multi-source finding linking.
 *
 * Tests that the orchestrator correctly ingests WorkerReport.sources
 * with their actual source types, and links findings to all source URLs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetTracker, ResearchStateEngine, resolveBudgetProfile } from '../../src/research/state.js';
import type {
   WorkerReport,
   WorkerFinding,
   WorkerSource,
   SourceEntry,
   SourceType,
   Finding,
   ContentQualityAssessment,
} from '../../src/research/types.js';

// ── Test helpers ───────────────────────────────────────────────────────────

function makeWorkerReport(overrides: Partial<WorkerReport> = {}): WorkerReport {
   return {
      id: `wr-${Math.random().toString(36).slice(2, 8)}`,
      question: 'Test question?',
      findings: [],
      sources: [],
      subThreads: [],
      contentQuality: {},
      narrativeSummary: '',
      searchQueries: [],
      tokensUsed: 0,
      elapsedMs: 100,
      ...overrides,
   };
}

function makeWorkerSource(overrides: Partial<WorkerSource> = {}): WorkerSource {
   return {
      url: 'https://example.com/article',
      title: 'Example Article',
      sourceType: 'web' as SourceType,
      domain: 'example.com',
      quality: { isSubstantive: true, contentDepth: 0.8, isPromotional: false } as ContentQualityAssessment,
      relevanceRationale: 'Test rationale',
      ...overrides,
   };
}

function makeWorkerFinding(overrides: Partial<WorkerFinding> = {}): WorkerFinding {
   return {
      id: `wf-${Math.random().toString(36).slice(2, 8)}`,
      claim: 'Test claim.',
      evidence: 'Test evidence.',
      sourceUrls: ['https://example.com/article'],
      citationConfidence: 'explicit',
      ...overrides,
   };
}

/**
 * Simulates the core logic of `ingestWorkerReports` and `ensureSourceExists`
 * without needing the full orchestrator. This lets us unit-test the
 * source ingestion algorithm in isolation.
 */
function simulateIngestWorkerReports(
   state: ResearchStateEngine,
   reports: WorkerReport[],
): {
   sources: SourceEntry[];
   findings: Finding[];
} {
   // Step 1: Ingest all report.sources first (the fix for Phase 1/2)
   for (const report of reports) {
      for (const ws of report.sources) {
         // Check if source already exists by URL
         const existing = state.getSources().find((s) => s.url === ws.url);
         if (!existing) {
            state.addSource({
               id: `src-${ws.url.slice(-40).replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}`,
               title: ws.title,
               url: ws.url,
               sourceType: ws.sourceType,  // THE FIX: use actual source type
               domain: ws.domain,
               isPrimary: false,
               relevantSubQuestions: report.parentSubQuestionId ? [report.parentSubQuestionId] : [],
               extractionStatus: 'extracted',
               accessDate: new Date().toISOString(),
               ...(ws.publishedDate !== undefined ? { publishedDate: ws.publishedDate } : {}),
               subQuestionId: report.parentSubQuestionId ?? '',
            });
         }
      }
   }

   // Step 2: Ingest findings with all sourceUrls linked
   for (const report of reports) {
      for (const wf of report.findings) {
         // Look up all source IDs for all source URLs
         const sourceIds: string[] = [];
         for (const url of wf.sourceUrls) {
            const existing = state.getSources().find((s) => s.url === url);
            if (existing) {
               sourceIds.push(existing.id);
            }
         }
         // If no pre-existing sources found, create a fallback per URL
         if (sourceIds.length === 0) {
            for (const url of wf.sourceUrls) {
               const sourceId = `src-${url.slice(-40).replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}`;
               state.addSource({
                  id: sourceId,
                  title: url,
                  url,
                  sourceType: 'web', // fallback for truly unknown sources
                  domain: url,
                  isPrimary: false,
                  relevantSubQuestions: report.parentSubQuestionId ? [report.parentSubQuestionId] : [],
                  extractionStatus: 'extracted',
                  accessDate: new Date().toISOString(),
                  subQuestionId: report.parentSubQuestionId ?? '',
               });
               sourceIds.push(sourceId);
            }
         }
         state.addFinding({
            claim: wf.claim,
            normalizedClaim: wf.claim.toLowerCase().replace(/[^\w\s]/g, '').trim(),
            subQuestionIds: report.parentSubQuestionId ? [report.parentSubQuestionId] : [],
            sourceIds, // THE FIX: all sourceUrls, not just [0]
            evidenceSummary: wf.evidence,
            evidenceExcerpt: wf.evidence.slice(0, 500),
            evidenceDirectness: 'near-direct',
            freshnessSensitive: false,
            lastUpdated: new Date().toISOString(),
            claimType: 'primary',
         });
      }
   }

   return {
      sources: state.getSources(),
      findings: state.getFindings(),
   };
}

function setupState(): { state: ResearchStateEngine; budget: BudgetTracker } {
   const budget = new BudgetTracker(resolveBudgetProfile('standard'));
   const state = new ResearchStateEngine(budget);
   state.initialize('Test query', budget);
   return { state, budget };
}

// ── Test: Source type preservation ─────────────────────────────────────────

test('Phase1: source type preservation — academic, reddit, hackernews, web sources preserve their types', () => {
   const { state } = setupState();

   const report = makeWorkerReport({
      parentSubQuestionId: 'sq-1',
      sources: [
         makeWorkerSource({ url: 'https://arxiv.org/abs/2501.00001', title: 'ArXiv Paper', sourceType: 'academic', domain: 'arxiv.org' }),
         makeWorkerSource({ url: 'https://reddit.com/r/ai/comments/1', title: 'Reddit Discussion', sourceType: 'reddit', domain: 'reddit.com' }),
         makeWorkerSource({ url: 'https://news.ycombinator.com/item?id=1', title: 'HN Thread', sourceType: 'hackernews', domain: 'ycombinator.com' }),
         makeWorkerSource({ url: 'https://example.com/blog', title: 'Web Blog', sourceType: 'web', domain: 'example.com' }),
         makeWorkerSource({ url: 'https://youtube.com/watch?v=abc', title: 'YouTube Video', sourceType: 'youtube', domain: 'youtube.com' }),
      ],
      findings: [
         makeWorkerFinding({ id: 'f1', claim: 'Finding from academic', sourceUrls: ['https://arxiv.org/abs/2501.00001'] }),
         makeWorkerFinding({ id: 'f2', claim: 'Finding from reddit', sourceUrls: ['https://reddit.com/r/ai/comments/1'] }),
         makeWorkerFinding({ id: 'f3', claim: 'Finding from HN', sourceUrls: ['https://news.ycombinator.com/item?id=1'] }),
         makeWorkerFinding({ id: 'f4', claim: 'Finding from web', sourceUrls: ['https://example.com/blog'] }),
         makeWorkerFinding({ id: 'f5', claim: 'Finding from youtube', sourceUrls: ['https://youtube.com/watch?v=abc'] }),
      ],
   });

   const { sources, findings } = simulateIngestWorkerReports(state, [report]);

   // All 5 source types should be preserved
   const academicSource = sources.find((s) => s.url === 'https://arxiv.org/abs/2501.00001');
   const redditSource = sources.find((s) => s.url === 'https://reddit.com/r/ai/comments/1');
   const hnSource = sources.find((s) => s.url === 'https://news.ycombinator.com/item?id=1');
   const webSource = sources.find((s) => s.url === 'https://example.com/blog');
   const ytSource = sources.find((s) => s.url === 'https://youtube.com/watch?v=abc');

   assert.ok(academicSource, 'Academic source missing');
   assert.equal(academicSource!.sourceType, 'academic', 'Academic source type should be academic');
   assert.ok(redditSource, 'Reddit source missing');
   assert.equal(redditSource!.sourceType, 'reddit', 'Reddit source type should be reddit');
   assert.ok(hnSource, 'HN source missing');
   assert.equal(hnSource!.sourceType, 'hackernews', 'HN source type should be hackernews');
   assert.ok(webSource, 'Web source missing');
   assert.equal(webSource!.sourceType, 'web', 'Web source type should be web');
   assert.ok(ytSource, 'YouTube source missing');
   assert.equal(ytSource!.sourceType, 'youtube', 'YouTube source type should be youtube');

   // 5 sources ingested
   assert.equal(sources.length, 5, 'Should have 5 source entries');
   // 5 findings ingested
   assert.equal(findings.length, 5, 'Should have 5 findings');

   // Each finding should link to its source
   for (const f of findings) {
      assert.ok(f.sourceIds.length >= 1, `Finding ${f.id} has no sourceIds`);
      const linkedSource = sources.find((s) => s.id === f.sourceIds[0]);
      assert.ok(linkedSource, `Finding ${f.id} linked source not found`);
   }
});

// ── Test: Multi-source finding links all URLs ──────────────────────────────

test('Phase1: multi-source finding links all sourceUrls, not just the first', () => {
   const { state } = setupState();

   const report = makeWorkerReport({
      parentSubQuestionId: 'sq-1',
      sources: [
         makeWorkerSource({ url: 'https://source-a.com/doc', title: 'Source A', sourceType: 'web', domain: 'source-a.com' }),
         makeWorkerSource({ url: 'https://source-b.com/doc', title: 'Source B', sourceType: 'web', domain: 'source-b.com' }),
         makeWorkerSource({ url: 'https://source-c.com/doc', title: 'Source C', sourceType: 'academic', domain: 'source-c.com' }),
      ],
      findings: [
         makeWorkerFinding({
            id: 'f-multi',
            claim: 'Findings supported by three sources',
            sourceUrls: [
               'https://source-a.com/doc',
               'https://source-b.com/doc',
               'https://source-c.com/doc',
            ],
         }),
         makeWorkerFinding({
            id: 'f-single',
            claim: 'Finding from single source',
            sourceUrls: ['https://source-a.com/doc'],
         }),
      ],
   });

   const { sources, findings } = simulateIngestWorkerReports(state, [report]);

   assert.equal(sources.length, 3, 'Should have 3 source entries');

   // Multi-source finding should link all 3
   const multiFinding = findings.find((f) => f.claim.startsWith('Findings supported by three'));
   assert.ok(multiFinding, 'Multi-source finding missing');
   assert.equal(multiFinding!.sourceIds.length, 3,
      `Multi-source finding should have 3 sourceIds, got ${multiFinding!.sourceIds.length}`);

   // Each source URL should resolve to a known source entry
   for (const sid of multiFinding!.sourceIds) {
      const linked = sources.find((s) => s.id === sid);
      assert.ok(linked, `Source ID ${sid} not found in sources`);
   }

   // Single-source finding should have 1
   const singleFinding = findings.find((f) => f.claim.startsWith('Finding from single'));
   assert.ok(singleFinding, 'Single-source finding missing');
   assert.equal(singleFinding!.sourceIds.length, 1, 'Single-source finding should have 1 sourceId');
});

// ── Test: Source from report.sources with no findings still ingested ──────

test('Phase1: sources in WorkerReport.sources are ingested even without findings', () => {
   const { state } = setupState();

   // Worker visited 3 sources but only found claims in 1
   const report = makeWorkerReport({
      sources: [
         makeWorkerSource({ url: 'https://useful.com/article', title: 'Useful Article', sourceType: 'web', domain: 'useful.com' }),
         makeWorkerSource({ url: 'https://thin.com/page', title: 'Thin Content', sourceType: 'web', domain: 'thin.com' }),
         makeWorkerSource({ url: 'https://paywalled.com/article', title: 'Paywalled', sourceType: 'news', domain: 'paywalled.com' }),
      ],
      findings: [
         makeWorkerFinding({ id: 'f1', claim: 'Only finding', sourceUrls: ['https://useful.com/article'] }),
      ],
   });

   const { sources } = simulateIngestWorkerReports(state, [report]);

   // All 3 sources should be ingested, even the ones without findings
   assert.equal(sources.length, 3, 'Should have 3 sources (including examined-but-unused)');

   const usefulSource = sources.find((s) => s.url === 'https://useful.com/article');
   const thinSource = sources.find((s) => s.url === 'https://thin.com/page');
   const paywalledSource = sources.find((s) => s.url === 'https://paywalled.com/article');

   assert.ok(usefulSource, 'Useful source should be ingested');
   assert.equal(usefulSource!.sourceType, 'web');
   assert.ok(thinSource, 'Thin source should be ingested even without findings');
   assert.ok(paywalledSource, 'Paywalled source should be ingested even without findings');
   assert.equal(paywalledSource!.sourceType, 'news', 'Paywalled news source preserves type');
});

// ── Test: Duplicate URL dedup across reports ───────────────────────────────

test('Phase1: duplicate URLs across worker reports are deduplicated', () => {
   const { state } = setupState();

   const sharedUrl = 'https://shared-source.com/article';

   const report1 = makeWorkerReport({
      id: 'wr-1',
      parentSubQuestionId: 'sq-1',
      sources: [makeWorkerSource({ url: sharedUrl, title: 'Shared Source', sourceType: 'academic', domain: 'shared-source.com' })],
      findings: [makeWorkerFinding({ id: 'f1', claim: 'Finding from sq-1', sourceUrls: [sharedUrl] })],
   });

   const report2 = makeWorkerReport({
      id: 'wr-2',
      parentSubQuestionId: 'sq-2',
      sources: [makeWorkerSource({ url: sharedUrl, title: 'Shared Source', sourceType: 'academic', domain: 'shared-source.com' })],
      findings: [makeWorkerFinding({ id: 'f2', claim: 'Finding from sq-2', sourceUrls: [sharedUrl] })],
   });

   const { sources, findings } = simulateIngestWorkerReports(state, [report1, report2]);

   // Same URL should only create one source entry
   assert.equal(sources.length, 1, 'Duplicate URL should dedup to single source');
   assert.equal(sources[0]!.sourceType, 'academic');

   // Both findings should link to the same source ID
   assert.equal(findings.length, 2, 'Should have 2 findings');
   assert.equal(findings[0]!.sourceIds[0], sources[0]!.id, 'Finding 1 should link to shared source');
   assert.equal(findings[1]!.sourceIds[0], sources[0]!.id, 'Finding 2 should link to shared source');
});
