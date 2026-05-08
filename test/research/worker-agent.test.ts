import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerAgent } from '../../src/research/workerAgent.js';
import type { DeepResearchLlmClient } from '../../src/research/llm/chat.js';
import type { ResearchTools, WorkerReport } from '../../src/research/types.js';

// ── Mocks ──────────────────────────────────────────────────────────────────

class MockLlmClient {
   async callWorker() {
      return { success: true, content: 'Mock response', tokensUsed: 100 };
   }
   async callOrchestrator() {
      return { success: true, content: 'Mock response', tokensUsed: 100 };
   }
   async callJSON(options: { model: string, messages: { role: string, content: string }[] }) {
      const allContent = options.messages.map(m => m.content).join('\n');
      if (allContent.includes('research strategist')) {
         // Mock thinkReflect
         return {
            success: true,
            data: { shouldContinue: false, reflection: 'Done.' },
            response: { success: true, content: '', tokensUsed: 10 }
         };
      }
      if (allContent.includes('autonomous research investigator')) {
         // Mock planSearch
         return {
            success: true,
            data: {
               sourceTypes: ['web'],
               reasoning: 'Test reasoning',
               queries: ['test query'],
            },
            response: { success: true, content: '', tokensUsed: 100 }
         };
      }
      if (allContent.includes('Provide a 2-3 sentence summary')) {
         // Mock summarizeSinglePage
         return {
            success: true,
            data: {
               url: 'https://example.com',
               title: 'Test',
               sourceType: 'web',
               domain: 'example.com',
               summary: 'Test summary',
               keyExcerpts: ['Test excerpt'],
            },
            response: { success: true, content: '', tokensUsed: 50 }
         };
      }
      // Default: Mock synthesis response
      return {
         success: true,
         data: {
            findings: [{ claim: 'Test claim', evidence: 'Test evidence', sourceIndices: [1] }],
            subThreads: [],
         },
         response: { success: true, content: '', tokensUsed: 200 }
      };
   }
}

const mockTools: ResearchTools = {
   webSearch: async () => [{ title: 'Test', url: 'https://example.com', description: 'Test desc' }],
   webCrawl: async () => [{ title: 'Test', url: 'https://example.com', markdown: 'Test content that is long enough to be substantive and interesting for the agent to process. '.repeat(10) }],
   webRead: async () => ({ title: 'Test', url: 'https://example.com', markdown: 'Test content that is long enough to be substantive and interesting for the agent to process. '.repeat(10) }),
   academicSearch: async () => [],
   githubSearch: async () => [],
   redditSearch: async () => [],
   hackernewsSearch: async () => [],
   youtubeSearch: async () => [],
   youtubeTranscript: async () => [],
   redditComments: async () => ({ post: { title: '', selftext: '' }, comments: [] }),
   semanticYoutube: async () => ({ chunks: [], videoCount: 0, failedTranscripts: 0, warnings: [] }),
   semanticReddit: async () => ({ chunks: [], postCount: 0, failedPosts: 0, warnings: [] }),
   semanticGitHubCode: async () => ({ results: [], warnings: [] }),
   semanticCrawl: async () => ({ chunks: [], pagesCrawled: 0, warnings: [] }),
   pubmedSearch: async () => [],
   wikipediaSearch: async () => [],
   stackoverflowSearch: async () => [],
   browserSession: async () => ({ sessionId: 'test-session' }),
   browserExtract: async () => ({ content: '', findings: [], sources: [] }),
   browserClose: async () => {},
};

// ── Tests ──────────────────────────────────────────────────────────────────

test('WorkerAgent.investigate high-level flow', async () => {
   const agent = new WorkerAgent(
      new MockLlmClient() as unknown as DeepResearchLlmClient,
      mockTools as ResearchTools,
      undefined,
      { maxSearchRounds: 1 }
   );

   const report: WorkerReport = await agent.investigate('What is the capital of France?');

   assert.strictEqual(report.question, 'What is the capital of France?');
   assert.ok(report.findings.length > 0);
   assert.strictEqual(report.findings[0]!.claim, 'Test claim');
   assert.ok(report.sources.length > 0);
   assert.strictEqual(report.sources[0]!.url, 'https://example.com');
});

test('WorkerAgent handles empty search results', async () => {
   const toolsNoResults: ResearchTools = {
      ...mockTools,
      webSearch: async () => [],
   } as unknown as ResearchTools;

   const agent = new WorkerAgent(
      new MockLlmClient() as unknown as DeepResearchLlmClient,
      toolsNoResults,
      undefined,
      { maxSearchRounds: 1 }
   );

   const report = await agent.investigate('Impossible question?');
   assert.strictEqual(report.sources.length, 0);
   assert.strictEqual(report.findings.length, 0);
});
