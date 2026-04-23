/**
 * Okapi BM25+ implementation.
 *
 * Parameters:
 *   k1    = 1.2   (term-frequency saturation)
 *   b     = 0.75  (length normalization)
 *   delta = 1.0   (BM25+ lower-bound addend)
 *
 * Scoring formula per document d, query q:
 *   score(d,q) = Σ_t IDF(t) × [ (tf(t,d)×(k1+1)) / (tf(t,d) + k1×(1-b+b×|d|/avgdl)) + delta ]
 *
 * IDF(t) = ln((N - df(t) + 0.5) / (df(t) + 0.5) + 1)   [smoothed Robertson-Sparck Jones]
 */

export interface Bm25Document {
  id: string;
  text: string;
}

export interface Bm25Index {
  search(query: string, topK?: number): { id: string; score: number }[];
}

// BM25+ parameters
const K1 = 1.2;
const B = 0.75;
const DELTA = 1.0;

function tokenize(text: string): string[] {
  return (text.match(/\b\w+\b/g) ?? []).map(t => t.toLowerCase());
}

function buildTermFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  return tf;
}

export function buildBm25Index(docs: Bm25Document[]): Bm25Index {
  const N = docs.length;

  if (N === 0) {
    return {
      search(): { id: string; score: number }[] {
        return [];
      },
    };
  }

  // Pre-compute per-document term frequencies and lengths, zipped with doc id
  const corpus: { id: string; tf: Map<string, number>; dl: number }[] = [];
  let totalLength = 0;

  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    corpus.push({ id: doc.id, tf: buildTermFreq(tokens), dl: tokens.length });
    totalLength += tokens.length;
  }

  const avgdl = totalLength / N;

  // Build document-frequency map: term → count of docs containing term
  const df = new Map<string, number>();
  for (const entry of corpus) {
    for (const term of entry.tf.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  function idf(term: string): number {
    const dft = df.get(term) ?? 0;
    return Math.log((N - dft + 0.5) / (dft + 0.5) + 1);
  }

  return {
    search(query: string, topK?: number): { id: string; score: number }[] {
      const queryTerms = tokenize(query);
      if (queryTerms.length === 0) return [];

      const scores: { id: string; score: number }[] = [];

      for (const entry of corpus) {
        const { id, tf, dl } = entry;
        let score = 0;

        for (const term of queryTerms) {
          const termTf = tf.get(term) ?? 0;
          if (termTf === 0) continue;

          const termIdf = idf(term);
          const numerator = termTf * (K1 + 1);
          const denominator = termTf + K1 * (1 - B + B * (dl / avgdl));
          score += termIdf * (numerator / denominator + DELTA);
        }

        if (score > 0) {
          scores.push({ id, score });
        }
      }

      // Sort descending by score
      scores.sort((a, b) => b.score - a.score);

      if (topK !== undefined) {
        return scores.slice(0, topK);
      }
      return scores;
    },
  };
}
