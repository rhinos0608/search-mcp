import test from 'node:test';
import assert from 'node:assert/strict';
import {
   applyReportValidation,
   assessEvidenceAlignment,
   buildClaimLedger,
   classifySourceAuthority,
   detectLatestOfficialVersion,
   enrichFindingsWithSemanticEvidenceAlignment,
   inferSourceTypeFromUrl,
   validateResearchReport
} from '../../src/research/provenance.js';
import { compactResearchResult } from '../../src/research/compaction.js';
import { buildFindingLinkage } from '../../src/research/findingLinkage.js';
import { LlmSynthesizer } from '../../src/research/llm/synthesis.js';
import type { DeepResearchLlmClient, LlmResponse } from '../../src/research/llm/chat.js';
import type { EmbedRequest, EmbedResponse } from '../../src/rag/embedding.js';
import type { Finding, ResearchReport, ResearchState, SourceEntry } from '../../src/research/types.js';

function source(overrides: Partial<SourceEntry> & Pick<SourceEntry, 'id' | 'title' | 'url'>): SourceEntry {
   const domain = new URL(overrides.url).hostname.replace(/^www\./, '');
   const sourceType = inferSourceTypeFromUrl(overrides.url, overrides.sourceType ?? 'web');
   const base: SourceEntry = {
      id: overrides.id,
      title: overrides.title,
      url: overrides.url,
      sourceType,
      domain,
      authorityClass: classifySourceAuthority({ url: overrides.url, domain, sourceType }),
      isPrimary: false,
      relevantSubQuestions: ['sq1'],
      extractionStatus: 'extracted',
      accessDate: '2026-05-12T00:00:00.000Z',
      subQuestionId: 'sq1'
   };
   return { ...base, ...overrides };
}

function finding(overrides: Partial<Finding> & Pick<Finding, 'id' | 'claim' | 'sourceIds'>): Finding {
   const base: Finding = {
      id: overrides.id,
      claim: overrides.claim,
      normalizedClaim: overrides.claim.toLowerCase().replace(/[^\w\s]/g, '').trim(),
      subQuestionIds: ['sq1'],
      sourceIds: overrides.sourceIds,
      evidenceSummary: overrides.claim,
      evidenceDirectness: 'direct',
      freshnessSensitive: true,
      lastUpdated: '2026-05-12T00:00:00.000Z',
      claimType: 'primary',
      createdAt: '2026-05-12T00:00:00.000Z'
   };
   return { ...base, ...overrides };
}

function report(claimText: string): ResearchReport {
   return {
      query: 'What are the latest developments in Anthropic MCP as of 2026?',
      classification: 'current-events',
      depth: 'standard',
      executiveSummary: claimText,
      narrativeMarkdown: claimText,
      themes: [{ title: 'Latest developments', narrative: claimText }],
      contradictions: [],
      uncertainties: [],
      sourceNotes: [],
      openQuestions: [],
      limitations: [],
      sourceCount: 0,
      findingCount: 0,
      sourceTypeCount: 0,
      sourceDiversity: [],
      evidenceSources: []
   };
}

test('package release must not become protocol release', () => {
   const sources = [
      source({
         id: 'pkg-blog',
         title: '@ai-sdk/mcp v2.0.0-beta.3 release notes',
         url: 'https://vercel.com/blog/ai-sdk-mcp-v2-beta',
         publishedDate: '2026-03-13'
      }),
      source({
         id: 'official-spec',
         title: 'Model Context Protocol specification 2025-11-25',
         url: 'https://modelcontextprotocol.io/specification/2025-11-25'
      })
   ];
   const findings = [
      finding({
         id: 'bad',
         claim:
            'On March 13, 2026, Anthropic released MCP v2 beta, the most substantial redesign since MCP was open-sourced in November 2024.',
         sourceIds: ['pkg-blog']
      })
   ];

   const validated = applyReportValidation(report(findings[0]!.claim), sources, findings);

   assert.ok(!validated.narrativeMarkdown.includes('Anthropic released MCP v2 beta'));
   assert.ok(validated.reportAudit?.issues.some((i) => i.type === 'entity_mismatch'));
});

test('protocol release claims require primary official support', () => {
   const sources = [
      source({
         id: 'third-party',
         title: 'MCP v2 introduced OAuth',
         url: 'https://example.com/mcp-v2-oauth'
      })
   ];
   const findings = [
      finding({
         id: 'weak-protocol-release',
         claim: 'MCP v2 introduced OAuth support for protected resource metadata.',
         sourceIds: ['third-party']
      })
   ];

   const ledger = buildClaimLedger(findings, sources, 'latest MCP protocol release');

   assert.strictEqual(ledger[0]!.authorityRequirement, 'primary_required');
   assert.strictEqual(ledger[0]!.supportLevel, 'weak');
   assert.ok(ledger[0]!.risks.includes('weak_authority'));
});

test('publication date is not treated as release date', () => {
   const sources = [
      source({
         id: 'article',
         title: 'March 2026 explainer about @ai-sdk/mcp',
         url: 'https://example.com/articles/ai-sdk-mcp',
         publishedDate: '2026-03-13'
      })
   ];
   const findings = [
      finding({
         id: 'publication-date-release',
         claim: 'The MCP protocol released structured tool output on March 13, 2026.',
         sourceIds: ['article']
      })
   ];

   const ledger = buildClaimLedger(findings, sources, 'latest MCP developments');

   assert.ok(ledger[0]!.risks.includes('temporal_misattribution'));
});

test('latest official MCP version is detected from official spec pages', () => {
   const sources = [
      source({
         id: 'spec-2025-06-18',
         title: 'Model Context Protocol specification 2025-06-18',
         url: 'https://modelcontextprotocol.io/specification/2025-06-18'
      }),
      source({
         id: 'spec-2025-11-25',
         title: 'Model Context Protocol specification 2025-11-25',
         url: 'https://modelcontextprotocol.io/specification/2025-11-25'
      })
   ];

   const latest = detectLatestOfficialVersion(sources, 'latest MCP developments as of 2026');

   assert.strictEqual(latest?.version, '2025-11-25');
   assert.strictEqual(latest?.sourceId, 'spec-2025-11-25');
});

test('MCP source authority ranking prefers official sources over third-party commentary', () => {
   const officialSpec = source({
      id: 'spec',
      title: 'MCP spec',
      url: 'https://modelcontextprotocol.io/specification/2025-11-25'
   });
   const officialRepo = source({
      id: 'repo',
      title: 'MCP repo',
      url: 'https://github.com/modelcontextprotocol/modelcontextprotocol'
   });
   const officialBlog = source({
      id: 'blog',
      title: 'MCP blog',
      url: 'https://blog.modelcontextprotocol.io/posts/example'
   });
   const thirdParty = source({
      id: 'third-party',
      title: 'MCP explainer',
      url: 'https://example.com/mcp-explainer'
   });

   assert.strictEqual(officialSpec.authorityClass, 'official_spec');
   assert.strictEqual(officialRepo.authorityClass, 'official_repo');
   assert.strictEqual(officialBlog.authorityClass, 'official_vendor');
   assert.strictEqual(thirdParty.authorityClass, 'third_party_analysis');
});

test('source and finding counts are derived from canonical registry', () => {
   const sources = [
      source({ id: 's1', title: 'MCP spec', url: 'https://modelcontextprotocol.io/specification/2025-11-25' }),
      source({ id: 's2', title: 'MCP blog', url: 'https://blog.modelcontextprotocol.io/posts/example' })
   ];
   const findings = [
      finding({
         id: 'f1',
         claim: 'The latest official MCP specification version is 2025-11-25.',
         sourceIds: ['s1']
      })
   ];

   const validated = applyReportValidation(report(findings[0]!.claim), sources, findings);

   assert.strictEqual(validated.sourceCount, sources.length);
   assert.strictEqual(validated.findingCount, findings.length);
   assert.strictEqual(validated.evidenceSources.length, validated.sourceRegistry?.filter((s) => s.usedInReport).length);
});

test('marketing language is flagged rather than laundered as factual evidence', () => {
   const sources = [source({ id: 's1', title: 'Commentary', url: 'https://example.com/mcp-commentary' })];
   const findings = [
      finding({
         id: 'marketing',
         claim: 'MCP is the TCP/IP of the agentic web.',
         sourceIds: ['s1']
      })
   ];

   const audit = validateResearchReport(report(findings[0]!.claim), sources, findings);

   assert.ok(audit.issues.some((i) => i.type === 'marketing_language'));
});

test('unrelated official source cannot satisfy package-backed protocol release claim', () => {
   const sources = [
      source({
         id: 'pkg',
         title: '@ai-sdk/mcp v2.0.0-beta.3 package release',
         url: 'https://vercel.com/blog/ai-sdk-mcp-v2-beta'
      }),
      source({
         id: 'official',
         title: 'Model Context Protocol specification 2025-11-25',
         url: 'https://modelcontextprotocol.io/specification/2025-11-25'
      })
   ];
   const findings = [
      finding({
         id: 'bad-package-backed-protocol',
         claim: 'Anthropic released MCP v2 beta as a protocol release.',
         sourceIds: ['pkg']
      })
   ];

   const ledger = buildClaimLedger(findings, sources, 'latest MCP protocol release');

   assert.strictEqual(ledger[0]!.supportLevel, 'weak');
   assert.ok(ledger[0]!.risks.includes('weak_authority'));
});

test('arbitrary docs and GitHub repos are not classified as official MCP protocol authority', () => {
   const randomDocs = source({
      id: 'docs',
      title: 'Random docs',
      url: 'https://docs.example.com/mcp-guide',
      sourceType: 'documentation'
   });
   const randomRepo = source({
      id: 'repo',
      title: 'Random MCP helper repo',
      url: 'https://github.com/example/mcp-helper'
   });

   assert.notStrictEqual(randomDocs.authorityClass, 'official_spec');
   assert.notStrictEqual(randomRepo.authorityClass, 'official_repo');
});

test('unsafe narrative-only protocol claim is removed and audit reruns', () => {
   const sources = [
      source({
         id: 'pkg',
         title: '@ai-sdk/mcp v2.0.0-beta.3 package release',
         url: 'https://vercel.com/blog/ai-sdk-mcp-v2-beta'
      })
   ];
   const claim = 'Vercel says Anthropic released MCP v2 beta as the official protocol release.';
   const validated = applyReportValidation(report(claim), sources, []);

   assert.ok(!validated.narrativeMarkdown.includes(claim));
   assert.ok(validated.uncertainties.some((u) => u.includes('Validation removed an unsafe claim')));
});

test('claim evidence alignment tracks missing package and version anchors', () => {
   const f = finding({
      id: 'unaligned',
      claim: '@ai-sdk/mcp v2.0.0-beta.3 adds resumable stream support.',
      evidenceSummary: 'The article discusses protocol design ideas without package release details.',
      sourceIds: ['pkg']
   });
   const sources = [
      source({
         id: 'pkg',
         title: '@ai-sdk/mcp release notes',
         url: 'https://vercel.com/blog/ai-sdk-mcp-v2-beta'
      })
   ];

   const alignment = assessEvidenceAlignment(f);
   const ledger = buildClaimLedger([f], sources, 'latest MCP package release');

   assert.ok(alignment.missingAnchorTerms.includes('@ai-sdk/mcp'));
   assert.ok(ledger[0]!.risks.includes('weak_evidence_alignment'));
   assert.strictEqual(ledger[0]!.evidenceAlignment?.method, 'lexical_anchor_overlap');
});

test('compact output prefers canonical findings over timeline findings events', () => {
   const canonical = finding({
      id: 'canonical',
      claim: 'The canonical state finding is preserved.',
      sourceIds: ['s1']
   });
   const stale = finding({
      id: 'stale',
      claim: 'The stale timeline finding should not be used.',
      sourceIds: ['s1']
   });
   const compact = compactResearchResult({
      report: report(canonical.claim),
      timeline: [{ phase: 'findings', findings: [stale] }, { phase: 'complete' }],
      canonicalFindings: [canonical]
   });

   assert.deepStrictEqual(compact.findings.map((f) => f.id), ['canonical']);
   assert.deepStrictEqual(compact.findings[0]!.sourceIds, ['s1']);
});

test('finding linkage clusters vector-neighbour records without all-pairs LLM calls', () => {
   const f1 = finding({ id: 'f1', claim: 'LLM-CER clusters records directly in context.', sourceIds: ['s1'] });
   const f2 = finding({ id: 'f2', claim: 'In-context clustering groups entity records directly.', sourceIds: ['s2'] });
   const f3 = finding({ id: 'f3', claim: 'Blocking filters candidate pairs before matching.', sourceIds: ['s3'] });

   const linkage = buildFindingLinkage([f1, f2, f3], {
      embeddings: [
         [1, 0],
         [0.99, 0.01],
         [0, 1]
      ],
      vectorThreshold: 0.95
   });

   const f1Cluster = linkage.clusters.find((cluster) => cluster.findingIds.includes('f1'));
   assert.ok(f1Cluster?.findingIds.includes('f2'));
   assert.ok(!f1Cluster?.findingIds.includes('f3'));
   assert.ok(linkage.edges.some((edge) => edge.method === 'vector'));
   assert.ok(linkage.edges.some((edge) => edge.relation === 'near_duplicate' && edge.strength === 'strong'));
});

test('weak semantic bridge edges do not transitively over-merge distinct entity claims', () => {
   const protocol = finding({ id: 'protocol', claim: 'MCP added OAuth support for protected resources.', sourceIds: ['s1'] });
   const desktop = finding({ id: 'desktop', claim: 'Claude Desktop added OAuth support for MCP servers.', sourceIds: ['s2'] });
   const unrelated = finding({ id: 'unrelated', claim: 'Blocking filters candidate pairs before matching.', sourceIds: ['s3'] });

   const linkage = buildFindingLinkage([protocol, desktop, unrelated], {
      embeddings: [
         [1, 0],
         [0.99, 0.01],
         [0, 1]
      ],
      vectorThreshold: 0.95
   });

   const protocolCluster = linkage.clusters.find((cluster) => cluster.findingIds.includes('protocol'));
   const bridgeEdge = linkage.edges.find((edge) => edge.leftFindingId === 'protocol' && edge.rightFindingId === 'desktop');

   assert.ok(!protocolCluster?.findingIds.includes('desktop'));
   assert.strictEqual(bridgeEdge?.strength, 'weak');
   assert.strictEqual(bridgeEdge?.bridge, true);

   const sources = [
      source({ id: 's1', title: 'MCP OAuth', url: 'https://example.com/mcp-oauth' }),
      source({ id: 's2', title: 'Claude Desktop OAuth', url: 'https://example.com/claude-desktop-oauth' })
   ];
   const validated = applyReportValidation(
      { ...report(protocol.claim), findingClusters: linkage.clusters, findingClusterEdges: linkage.edges },
      sources,
      [protocol, desktop]
   );

   const clusterIssue = validated.reportAudit?.issues.find((issue) => issue.type === 'cluster_integrity');
   assert.strictEqual(clusterIssue?.enforcement, 'quarantine');
   assert.ok(validated.evidenceGraph?.findingClusterEdges.some((edge) => edge.bridge));
});

test('semantic evidence alignment lifts paraphrased evidence through embeddings', async () => {
   const f = finding({
      id: 'semantic-alignment',
      claim: 'The protocol supports resumable stream recovery.',
      evidenceSummary: 'Clients can reconnect and continue interrupted message streams.',
      sourceIds: ['s1']
   });
   const fakeEmbedder = async (request: EmbedRequest): Promise<EmbedResponse> => ({
      embeddings: request.texts.map(() => [1, 0]),
      model: 'test-embedding',
      modelRevision: 'test',
      dimensions: 2,
      mode: request.mode,
      truncatedIndices: []
   });

   const enriched = await enrichFindingsWithSemanticEvidenceAlignment([f], fakeEmbedder);

   assert.strictEqual(enriched[0]!.evidenceAlignment?.method, 'hybrid_lexical_semantic');
   assert.ok((enriched[0]!.evidenceAlignment?.semanticScore ?? 0) > 0.99);
   assert.ok((enriched[0]!.evidenceAlignment?.score ?? 0) > assessEvidenceAlignment(f).score);
});

function makeState(query: string, sources: SourceEntry[], findings: Finding[]): ResearchState {
   return {
      query,
      taxonomy: { originalQuery: query, subQuestions: [], revised: false, revisionHistory: [] },
      subQuestions: [],
      sources,
      findings,
      contradictions: [],
      openQuestions: [],
      gaps: [],
      claimGraph: [],
      currentPhase: 'synthesis',
      budget: {
         toolCallsUsed: 0,
         tokensUsed: 0,
         extractionsUsed: 0,
         gapLoopsUsed: 0,
         startTime: Date.now(),
         maxToolCalls: 100,
         maxTokens: 100000,
         maxExtractions: 50,
         maxGapLoops: 3,
         stateEntriesUsed: 0,
         maxStateEntries: 500,
         stepCosts: {},
         maxTimeMs: 300000,
         findingsAddedPerLoop: []
      },
      flags: { taxonomyRevised: false, audited: true, loopCount: 1 },
      gapTargets: [],
      allQuestions: [],
      resolvedGaps: [],
      searchClusters: [],
      diary: [],
      searchAttempts: [],
      workerReports: {},
      contentQuality: {},
      subQuestionCoverage: []
   };
}

test('LLM synthesis performs an audit-guided revision pass', async () => {
   const sources = [
      source({
         id: 'pkg',
         title: '@ai-sdk/mcp v2.0.0-beta.3 package release',
         url: 'https://vercel.com/blog/ai-sdk-mcp-v2-beta'
      })
   ];
   const badClaim = 'Anthropic released MCP v2 beta as the official protocol release.';
   const findings = [
      finding({
         id: 'bad',
         claim: badClaim,
         evidenceSummary: 'Vercel package notes for @ai-sdk/mcp v2.0.0-beta.3.',
         sourceIds: ['pkg']
      })
   ];
   const responses = [
      report(badClaim),
      report('Vercel published @ai-sdk/mcp v2.0.0-beta.3 package release notes.')
   ];
   const fakeLlm = {
      async callJSON() {
         const data = responses.shift()!;
         const response: LlmResponse = {
            content: JSON.stringify(data),
            model: 'test',
            tokensUsed: 1,
            durationMs: 1,
            success: true
         };
         return { success: true as const, data, response };
      }
   } as unknown as DeepResearchLlmClient;

   const synthesizer = new LlmSynthesizer(fakeLlm);
   const revised = await synthesizer.synthesize(makeState('latest MCP protocol release', sources, findings));

   assert.strictEqual(responses.length, 0);
   assert.ok(!revised.narrativeMarkdown.includes('Anthropic released MCP v2 beta'));
   assert.ok(revised.narrativeMarkdown.includes('@ai-sdk/mcp v2.0.0-beta.3 package release notes'));
});

test('validated reports expose an auditable evidence graph and cluster enforcement', () => {
   const sources = [source({ id: 's1', title: 'MCP commentary', url: 'https://example.com/mcp-oauth' })];
   const f = finding({
      id: 'f1',
      claim: 'MCP added OAuth support for protected resources.',
      sourceIds: ['s1']
   });
   const linkage = buildFindingLinkage([f]);
   const validated = applyReportValidation(
      { ...report(f.claim), findingClusters: linkage.clusters },
      sources,
      [f]
   );

   assert.ok(validated.evidenceGraph);
   assert.ok(validated.evidenceGraph?.edges.some((edge) => edge.relation === 'source_provides_evidence'));
   assert.ok(validated.evidenceGraph?.edges.some((edge) => edge.relation === 'evidence_supports_finding'));
   assert.ok(validated.reportAudit?.issues.every((issue) => issue.id && issue.enforcement));
});
