# Deep Research Architecture

## Core Loop: State → Evaluate → Decide → Act → Update State

The orchestrator runs a tight control loop. Phases are capabilities the loop calls, not sequential steps.

```
                 ┌─────────────────────────────────────────────┐
                 │               Orchestrator LLM               │
                 │         (expensive model for planning)        │
                 └──────┬──────────┬──────────┬─────────────────┘
                        │          │          │
            Evaluate ───┤  Decide  ├── Act    │
         (gap analysis,  │ (next     │ (search, │
          audit,         │  action)  │  extract)│
          confidence)    │          │          │
                        ▼          ▼          ▼
                 ┌─────────────────────────────────────────────┐
                 │               Worker LLM / Tools             │
                 │         (cheap model for extraction)          │
                 └─────────────────────────────────────────────┘
```

### State → Evaluate → Decide → Act → Update State

1. **State** = typed ResearchState (Findings, Sources, Contradictions, Gaps, Budget, Phase)
2. **Evaluate** = Orchestrator LLM or rule-based evaluation:
   - "What do we know? What are we missing? What's the confidence?"
   - Gap analysis, audit checks, confidence distribution
3. **Decide** = Orchestrator LLM decides next action:
   - "decompose" | "discover" | "extract" | "fill_gaps" | "audit" | "synthesize" | "complete"
   - Decision based on current state + budget + depth profile
4. **Act** = Execute the chosen action:
   - Worker LLM for extraction (cheap model)
   - Existing search tools for discovery
   - Rule-based modules as fallbacks
5. **Update State** = Persist results, update phase

### Model Routing

- **Orchestrator Model** (`DEEP_RESEARCH_MODEL`, mid-tier): Planning, evaluation, decision-making, synthesis, audit
- **Worker Model** (`DEEP_RESEARCH_WORKER_MODEL`, cheap): Extraction from content, classification, search query generation
- Both use the same base URL, different model strings

### 3D Confidence Model

Instead of a single confidence number:

1. **Evidence Confidence** (0-1)
   - Source authority (domain trust scoring, academic vs web)
   - Source freshness
   - Corroboration count (how many independent sources agree)
   - Domain trust factor from existing `domainTrust.ts`

2. **Extraction Confidence** (0-1)
   - Method reliability (LLM > regex > direct extract)
   - Content quality (well-structured vs noisy)
   - Whether content was scrubbed (scrubbed = lower extraction confidence)

3. **Consistency Confidence** (0-1)
   - Agreement ratio among sources on this claim
   - Contradiction resolution status
   - Cross-source triangulation

**Aggregate**: weighted product or minimum of the three dimensions, reported separately for debugging.

### Tool Ecosystem Integration

| Existing Tool        | Integration Point                                                               |
| -------------------- | ------------------------------------------------------------------------------- |
| `domainTrust.ts`     | Feeds into Evidence Confidence (domain authority score)                         |
| `contentScrubber.ts` | Extraction pre-processing; risk score → Extraction Confidence adjustment        |
| `semantic_crawl`     | Gap filling strategy — prefer semantic crawl on known domains over blind search |
| `queryExpansion.ts`  | Decomposition feedback — sub-questions feed into query expansion                |

### Failure Mitigations

1. **State explosion**: Hard caps per sub-question (max 15 sources, max 25 findings). Pruning: keep top-K findings per sub-question by confidence.
2. **Degenerate loops**: Max iterations (budget-constrained). Confidence plateau detection (<5% improvement). Diminishing returns threshold.
3. **Partial failure**: Mark failed sub-questions. Degraded synthesis mode. Explicit "coverage gaps" in output report.

### Module Boundaries

```
src/research/
├── orchestrator.ts        # Control loop: Evaluate → Decide → Act → Update State
├── confidence.ts          # 3D confidence model
├── state.ts               # ResearchStateEngine (immutable-ish)
├── progress.ts            # Progressive rendering timeline
├── decomposer.ts          # Rule-based decomposition (fallback)
├── taxonomy.ts            # Rule-based taxonomy revision (fallback)
├── discovery.ts           # Multi-backend search engine
├── extraction.ts          # Rule-based extraction (fallback path)
├── gapAnalysis.ts         # Rule-based gap analysis (fallback path)
├── audit.ts               # Rule-based audit (fallback path)
├── synthesizer.ts         # Rule-based synthesis (fallback path)
├── llm/
│   ├── chat.ts            # LLM client (model routing, token tracking)
│   ├── prompts.ts         # Agent system prompts
│   ├── extractor.ts       # Worker-based extraction (calls cheap model)
│   └── synthesis.ts       # Orchestrator-based synthesis (calls main model)
└── types.ts               # Shared types
```

When LLM is not configured, all phases fall back to their rule-based counterparts.
