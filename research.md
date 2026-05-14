# Research: Practical Entity-Resolution / Record-Linkage Patterns for a TypeScript MCP Deep-Research Tool

## Summary
To improve the existing heuristic lexical alignment, one-pass LLM revision and compact-output fallback, the most leverage comes from three incremental additions: (1) **ANN-based blocking** over the existing embedding sidecar to cut the comparison space, (2) **graph-based transitive clustering** (connected components → merge/split) to replace pairwise-only reasoning, and (3) **clustered LLM revision with uncertainty guardrails** so the model reviews related findings together and abstains when token-probability or source-provenance signals are weak. All three can reuse the current embedding provider and RAG cache, keeping architecture changes small and avoidable.

## Findings

1. **Direct matching & blocking — replace all-pairs lexical scans with ANN on concatenated record text.**
   BlockingPy (2025) shows that schema-agnostic blocking—concatenating all entity attributes into a single text field and using approximate-nearest-neighbour search (HNSW, FAISS, Annoy, etc.) followed by graph connected-components—cuts the candidate space by >99% while preserving recall >0.95 on standard benchmarks. The tool already ships an embedding sidecar (FastAPI `POST /embed`) and supports `cosineSimilarity` in the RAG pipeline, so the incremental work is: normalise each finding into a blocking string, batch-embed via the sidecar, build an in-memory HNSW index (npm: `hnswlib-node`, `voyager`, or a brute-force k-NN for modest corpora), and retrieve top-k neighbours as candidate pairs. [Source: BlockingPy](https://arxiv.org/abs/2504.04266)

2. **Transitive linkage via graph components turns pairwise scores into entity clusters.**
   Pairwise ER ignores transitivity constraints, which is why the Science Advances review recommends clustering over independent pairwise decisions. A lightweight two-step graph method—first build a similarity graph from the ANN candidates, then extract connected components (union-find / `mnemonist` in JS)—yields soft clusters that naturally capture transitive identity. For splitting oversized or heterogeneous components, apply a greedy diameter threshold on the embedding space or run weighted modularity optimisation. [Source: “(Almost) all of entity resolution” — Science Advances eabi8021](https://www.science.org/doi/10.1126/sciadv.abi8021); [Graph-based hierarchical record clustering](https://arxiv.org/abs/2112.06331)

3. **Reuse existing vector infrastructure instead of adding a new database.**
   DeepER (2018) demonstrated that pre-trained tuple embeddings + LSH/ANN blocking outperform hand-tuned rules. The tool already has a persistent SQLite `corpusCache`, chunk-level embeddings, and cosine/BM25+RRF retrieval. Recommendation: store finding-level embeddings in the same SQLite cache or in a small in-memory `Float32Array` index; reuse the same embedding model (`EMBEDDING_PROVIDER`) to avoid model drift. There is no need to introduce a separate vector DB if corpus sizes stay within the 10k–100k range typical for deep-research jobs. [Source: DeepER](https://arxiv.org/abs/1710.00597)

4. **In-context clustering with LLMs reduces API calls and improves coherence.**
   LLM-CER (SIGMOD 2026) replaces expensive pairwise LLM matching with direct in-context clustering. Their design-space analysis shows that batching 15–20 records per LLM prompt, ordering records by embedding similarity, and using a constrained label space minimise hallucination and cost. For this tool, the analogue is: after ANN blocking + graph clustering, feed each cluster (instead of the whole result set) into the LLM revision step. This gives the model local context for contradiction detection and merge decisions while keeping prompt size bounded. [Source: LLM-CER](https://arxiv.org/abs/2506.02509)

5. **Cluster merging should be deterministic first, LLM-second.**
   LLM-CER and the hierarchical graph clustering paper both recommend a two-phase merge: (a) deterministic merge when Jaccard/embedding similarity exceeds a tight threshold, and (b) LLM-based merge only for borderline clusters. This avoids hallucinated merges and keeps latency low. A simple TypeScript implementation is: compute intra-cluster centroid distance; if `max(pairwiseCosine) > 0.92`, merge automatically; if `0.80–0.92`, ask the LLM; otherwise keep separate. [Source: LLM-CER](https://arxiv.org/abs/2506.02509); [Graph-based hierarchical record clustering](https://arxiv.org/abs/2112.06331)

6. **Hallucination guardrails should operate at entity/token level, not output level.**
   DRAD (2024) detects entity-level hallucinations by monitoring token probability and entropy in the LLM output; when an entity’s aggregate probability falls below a threshold or entropy spikes, a retrieval module is triggered to correct the claim. The tool’s existing `web_search` / `web_read` tools can serve as that retrieval module. Similarly, the HalluEntity benchmark (2025) shows that named entities and dates hallucinate most often (PERSON 13%, DATE 28%, NUM 36%), so guardrails should specifically validate dates, IDs and numeric statistics. [Source: DRAD](https://arxiv.org/abs/2407.09417); [HalluEntity benchmark](https://arxiv.org/abs/2502.11948)

7. **Provenance grounding via embedding similarity to source chunks.**
   Guardrails AI’s provenance validators demonstrate that sentence-level embedding checks against source documents reduce hallucination. The tool already chunks sources and stores embeddings for RAG. After LLM revision, each claim can be re-embedded and matched against its closest source chunk; if the cosine similarity is below a threshold (e.g. 0.72), the claim is flagged as ungrounded and either removed or sent back for re-verification. This is a lightweight post-process that requires no extra infrastructure. [Source: Guardrails AI provenance validators](https://guardrailsai.com/blog/reduce-ai-hallucinations-provenance-guardrails)

8. **Open-source LLMs are now competitive with proprietary models for ER, but cross-script and date fields remain failure modes.**
   OpenSanctions Pairs (2026) benchmarked rule-based vs LLM matchers on 755k real-world pairs; GPT-4o reached 98.95% F1 and DeepSeek-R1-Distill-Qwen-14B 98.23% F1. LLMs failed mainly on cross-script transliteration and minor date/identifier inconsistencies. For a TypeScript MCP tool, this implies (a) local/open-weight models are viable for the “match” step, but (b) deterministic normalisation (date parsing, URL canonicalisation, lowercasing) should still run before the LLM sees the record. [Source: OpenSanctions Pairs](https://arxiv.org/abs/2603.11051)

## Sources
- **Kept:** BlockingPy (https://arxiv.org/abs/2504.04266) — concrete ANN blocking design and open-source implementation; directly portable to the existing embedding sidecar.
- **Kept:** “(Almost) all of entity resolution” — Science Advances (https://www.science.org/doi/10.1126/sciadv.abi8021) — authoritative survey advocating clustering over pairwise independence.
- **Kept:** DeepER (https://arxiv.org/abs/1710.00597) — demonstrates that distributed representations + LSH/ANN blocking works end-to-end and reduces human tuning.
- **Kept:** LLM-CER (https://arxiv.org/abs/2506.02509) — latest in-context clustering design for ER, accepted at SIGMOD 2026; gives concrete batch sizes and ordering strategies.
- **Kept:** Graph-based hierarchical record clustering (https://arxiv.org/abs/2112.06331) — provides a graph + modularity algorithm for transitive clustering that is simple to implement.
- **Kept:** DRAD (https://arxiv.org/abs/2407.09417) — real-time hallucination detection via token probability/entropy with dynamic retrieval augmentation.
- **Kept:** HalluEntity benchmark (https://arxiv.org/abs/2502.11948) — entity-level hallucination rates by POS/NER tag, useful for targeting guardrails.
- **Kept:** OpenSanctions Pairs (https://arxiv.org/abs/2603.11051) — large-scale benchmark showing LLM ceiling and residual failure modes.
- **Kept:** Guardrails AI provenance validators blog (https://guardrailsai.com/blog/reduce-ai-hallucinations-provenance-guardrails) — practical sentence-level embedding check against sources.
- **Dropped:** Generic medium explainers on vector databases — did not add specifics beyond what is already known from the embedding sidecar.
- **Dropped:** Early surveys on classical Fellegi-Sunter probabilistic linkage — superseded by embedding-based methods for this context.

## Gaps
- We have not benchmarked the exact latency of `hnswlib-node` vs brute-force k-NN at the typical corpus size of a single deep-research job (mid-thousands of chunks). A quick in-repo micro-benchmark is recommended before finalising the ANN library.
- The confidence model currently uses `Math.min(evidence, extraction, consistency)`. No source explicitly validates this conservative aggregation for research findings. A small ablation (e.g., geometric mean vs min) on a held-out corpus would clarify whether it is too punitive.
- Token-level log-probabilities are not always exposed by the LLM endpoint the tool uses. If the orchestrator model does not return logprobs, the DRAD-style entity-entropy guardrail must be approximated (e.g., via self-consistency sampling or proxy model), which adds cost.

## Supervisor coordination
No supervisor escalation needed. If blocked during implementation on the choice of ANN library or on whether to store embeddings in the existing SQLite corpus cache vs a separate in-memory flat index, a `contact_supervisor` decision may be requested.
