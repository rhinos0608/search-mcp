import type { SemanticCrawlChunk, CorpusChunk } from '../types.js';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
  'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
  'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
  'below', 'between', 'under', 'and', 'but', 'or', 'yet', 'so', 'if',
  'because', 'although', 'though', 'while', 'where', 'when', 'how', 'that',
  'which', 'who', 'whom', 'whose', 'what', 'this', 'these', 'those',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her',
  'us', 'them', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
]);

function tokenize(text: string): string[] {
  return (text.match(/\b\w+\b/g) ?? []).map((t) => t.toLowerCase());
}

function getWordSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

export function applySoftLexicalConstraint(
  chunks: SemanticCrawlChunk[],
  query: string,
  corpusChunks: CorpusChunk[],
): { filtered: SemanticCrawlChunk[]; warning?: string } {
  // 1. Tokenize query, remove stopwords
  const queryTokens = tokenize(query).filter((t) => !STOPWORDS.has(t));

  if (queryTokens.length === 0) {
    return { filtered: chunks };
  }

  // 2. Compute IDF for each token against corpus (word-level matching)
  const N = corpusChunks.length;
  const corpusWordSets = corpusChunks.map((c) => getWordSet(c.text));
  const tokenIdf = new Map<string, number>();
  for (const token of queryTokens) {
    let df = 0;
    for (const words of corpusWordSets) {
      if (words.has(token)) {
        df++;
      }
    }
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    tokenIdf.set(token, idf);
  }

  // 3. Select top-3 highest-IDF tokens
  const sortedTokens = [...tokenIdf.entries()].sort((a, b) => b[1] - a[1]);
  const topTokens = sortedTokens.slice(0, 3).map(([t]) => t);

  // 4. Edge cases
  const requiredCount = queryTokens.length < 3 ? queryTokens.length : 2;

  // 5. Filter chunks (word-level matching)
  const filtered = chunks.filter((chunk) => {
    const chunkWords = getWordSet(chunk.text);
    let matchCount = 0;
    for (const token of topTokens) {
      if (chunkWords.has(token)) {
        matchCount++;
      }
    }
    return matchCount >= requiredCount;
  });

  if (filtered.length === 0) {
    return {
      filtered: chunks,
      warning: 'Soft lexical constraint yielded zero matches; returning unfiltered results',
    };
  }

  return { filtered };
}