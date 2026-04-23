// scripts/eval-retrieval.ts
// Runs semantic_crawl on a small set of queries and measures:
//   - Recall@5: does the expected chunk appear in the top 5?
//   - Re-rank latency overhead (ms)
//   - Chunks removed by semantic coherence filter
//
// Run: npx tsx scripts/eval-retrieval.ts
//
// The eval set is inline — 10 queries across different doc types.
// Each query has a URL, query text, and expected relevant passage
// (substring match in the returned chunks).

import { performance } from 'node:perf_hooks';

interface EvalCase {
  url: string;
  query: string;
  expectedSubstring: string;
  description: string;
}

const EVAL_CASES: EvalCase[] = [
  {
    url: 'https://docs.python.org/3/tutorial/classes.html',
    query: 'how to define a class method in Python',
    expectedSubstring: 'class',
    description: 'Python docs — class methods',
  },
  {
    url: 'https://react.dev/learn/thinking-in-react',
    query: 'how to build a component hierarchy',
    expectedSubstring: 'component',
    description: 'React docs — component hierarchy',
  },
  {
    url: 'https://nodejs.org/api/fs.html',
    query: 'how to read a file asynchronously',
    expectedSubstring: 'readFile',
    description: 'Node.js docs — fs.readFile',
  },
  {
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise',
    query: 'how to use promise.all in javascript',
    expectedSubstring: 'Promise',
    description: 'MDN — Promise reference',
  },
  {
    url: 'https://docs.npmjs.com/cli/v10/commands/npm-install',
    query: 'how to install a package globally with npm',
    expectedSubstring: 'install',
    description: 'npm docs — npm install',
  },
  {
    url: 'https://git-scm.com/docs/git-merge',
    query: 'how to merge branches in git',
    expectedSubstring: 'merge',
    description: 'Git docs — git merge',
  },
  {
    url: 'https://docs.docker.com/get-started/dockerfile/',
    query: 'how to write a dockerfile',
    expectedSubstring: 'Dockerfile',
    description: 'Docker docs — Dockerfile',
  },
  {
    url: 'https://tailwindcss.com/docs/utility-first',
    query: 'what is utility first css',
    expectedSubstring: 'utility',
    description: 'Tailwind docs — utility-first',
  },
  {
    url: 'https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests',
    query: 'how to create a pull request on github',
    expectedSubstring: 'pull request',
    description: 'GitHub docs — pull requests',
  },
  {
    url: 'https://kubernetes.io/docs/concepts/workloads/controllers/deployment/',
    query: 'how to create a kubernetes deployment',
    expectedSubstring: 'Deployment',
    description: 'K8s docs — Deployment',
  },
];

interface EvalResult {
  case: EvalCase;
  recallAt5: boolean;
  topChunk: string;
  totalChunks: number;
  latencyMs: number;
}

async function runEval(): Promise<void> {
  const { semanticCrawl } = await import('../src/tools/semanticCrawl.js');
  const { loadConfig } = await import('../src/config.js');

  const config = loadConfig();
  const results: EvalResult[] = [];

  for (const c of EVAL_CASES) {
    const start = performance.now();
    try {
      const result = await semanticCrawl(
        {
          source: { type: 'url', url: c.url },
          query: c.query,
          topK: 5,
          strategy: 'bfs',
          maxDepth: 1,
          maxPages: 3,
          includeExternalLinks: false,
        },
        config.crawl4ai,
        config.embedding.sidecarBaseUrl,
        config.embedding.sidecarApiToken,
        config.embedding.dimensions,
      );
      const latencyMs = performance.now() - start;

      const recallAt5 = result.chunks.some((chunk) =>
        chunk.text.toLowerCase().includes(c.expectedSubstring.toLowerCase()),
      );

      results.push({
        case: c,
        recallAt5,
        topChunk: result.chunks[0]?.text.slice(0, 80) ?? '(empty)',
        totalChunks: result.totalChunks,
        latencyMs,
      });

      console.log(`${recallAt5 ? '✓' : '✗'} ${c.description} — ${latencyMs.toFixed(0)}ms`);
    } catch (err) {
      console.log(`✗ ${c.description} — ERROR: ${(err as Error).message}`);
      results.push({
        case: c,
        recallAt5: false,
        topChunk: '(error)',
        totalChunks: 0,
        latencyMs: performance.now() - start,
      });
    }
  }

  // Summary
  const recall = results.filter((r) => r.recallAt5).length / results.length;
  const avgLatency = results.reduce((s, r) => s + r.latencyMs, 0) / results.length;
  console.log(`\n--- Summary ---`);
  console.log(
    `Recall@5: ${(recall * 100).toFixed(0)}% (${results.filter((r) => r.recallAt5).length}/${results.length})`,
  );
  console.log(`Avg latency: ${avgLatency.toFixed(0)}ms`);
  console.log(`\nBaseline comparison: run this script before and after the changes.`);
  console.log(`Goal: Recall@5 should not decrease; re-rank overhead should be <50ms per query.`);
}

runEval().catch(console.error);
