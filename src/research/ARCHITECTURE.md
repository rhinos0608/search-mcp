# Deep Research Architecture (V5.0.0)

## Overview

The deep research tool is an orchestration engine that performs multi-source research with adaptive gap filling, contradiction detection, and intelligent synthesis. It uses a job/poll pattern for non-blocking async operation.

## MCP Tool Interface (`src/tools/deepResearch.ts`)

The tool uses a **job/poll protocol** instead of blocking until completion:

```
start  → Returns jobId immediately (research runs in background)
poll   → Returns current status + partial results (blocks up to 60s)
list   → Lightweight summary of all jobs
cancel → Abort a running job
save   → Persist result to disk
```

- Max 5 concurrent active jobs
- 24-hour TTL for job results
- Auto-save to `~/.cache/search-mcp/research-results/YYYY/MM/DD/jobId.json`

## Orchestrator (`src/research/orchestrator.ts`)

The `ResearchOrchestrator` is the central coordinator:

1. Initializes state and budget based on depth profile
2. Detects query language
3. Selects a strategy based on context
4. Handles fallback from agent → pipeline if LLM fails

### Depth Profiles

| Depth      | Sources           | Gap Loops | Max Time |
| ---------- | ----------------- | --------- | -------- |
| quick      | 5-10              | 1         | ~3 min   |
| standard   | 15-25             | 2         | ~8 min   |
| deep       | 30-60             | 3         | ~15 min  |
| exhaustive | 100+              | -         | ~30 min  |
| tree       | 4×4 breadth×depth | -         | ~12 min  |

## Strategy Pattern (`src/research/strategies/`)

Three pluggable strategies:

| Strategy     | Description                           | Requires LLM |
| ------------ | ------------------------------------- | ------------ |
| **agent**    | ReAct-style agent with worker pool    | Yes          |
| **pipeline** | Fixed 7-phase deterministic pipeline  | No           |
| **tree**     | Delegates to pipeline with tree depth | No           |

Strategy selection:

- `depth === 'tree'` → tree
- `deterministic === true` → pipeline
- LLM available → agent (default)
- Otherwise → pipeline

## 7-Phase Pipeline (`src/research/strategies/pipelineStrategy.ts`, `src/research/phases/`)

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PIPELINE STRATEGY                                │
├─────────────────────────────────────────────────────────────────────┤
│ Phase 1: DECOMPOSITION                                              │
│   → Uses QueryDecomposer to break query into sub-questions         │
│   → Classifies query type (explainer, comparative, technical...)   │
│   → Sets freshness intent (recent/historical/any)                 │
├─────────────────────────────────────────────────────────────────────┤
│ Phase 2: DISCOVERY                                                  │
│   → Uses DiscoveryEngine to find sources across backends           │
│   → Multi-backend: web, academic, GitHub, Reddit, HN, StackOverflow│
│   → Source ranking + deduplication                                 │
│   → Taxonomy revision (reclassify sub-questions based on results)   │
├─────────────────────────────────────────────────────────────────────┤
│ LLM PATH (when LLM configured):                                    │
│   → WorkerAgentPhase: Spawns worker agents for each sub-question    │
│   → GapLoopPhase: EDA loop for adaptive gap filling                 │
├─────────────────────────────────────────────────────────────────────┤
│ RULE-BASED PATH (no LLM):                                          │
│   → ExtractionPhase: Rule-based extraction from top sources        │
├─────────────────────────────────────────────────────────────────────┤
│ Phase 3.5: POST-PROCESSING                                          │
│   → Finding merging, contradiction detection                       │
├─────────────────────────────────────────────────────────────────────┤
│ Phase 4: GAP LOOP (LLM only)                                        │
│   → Contradiction detection (rule-based + evidence-pool + LLM)     │
│   → Gap analysis (what's missing, low confidence areas)            │
│   → Gap filling (spawn workers for knowledge gaps)                 │
│   → Confidence plateau detection                                   │
│   → Adaptive band extension for complex topics                     │
├─────────────────────────────────────────────────────────────────────┤
│ Phase 5: AUDIT                                                      │
│   → StateAuditor runs 7 checks                                      │
│   → LLM-powered audit (when available) merges with rule-based      │
├─────────────────────────────────────────────────────────────────────┤
│ Phase 6: SYNTHESIS                                                  │
│   → LlmSynthesizer generates narrative report (LLM)                │
│   → ResearchSynthesizer generates report (rule-based)              │
│   → URL validation for hallucinations/dead links                   │
└─────────────────────────────────────────────────────────────────────┘
```

## Worker Pool Architecture (`src/research/pool/`, `src/research/workerAgent.ts`)

V5 introduced a worker pool for parallel sub-question investigation:

- `WorkerPoolManager`: Manages concurrent workers (default: 3)
- `WorkerAgent`: Autonomous agent per sub-question
- Per-worker tool call limit (default: 15)
- Token budget tracking across all workers
- Context injection: prior knowledge from decomposition

## Tree Research Engine (`src/research/treeEngine.ts`)

For `depth: 'tree'`, uses `DeepTreeResearchEngine`:

- Breadth×depth recursive exploration
- Default: 4 sub-queries × 2 levels
- Configurable breadth, depth, concurrency
- Context word limit for LLM context window

## Compaction for MCP Transport (`src/research/compaction.ts`)

V4.2.0 added result compaction:

- Multi-layer compaction for MCP response limits
- Trims timeline, caps findings
- Writes full result to file, returns reference
- Hard size guard to prevent oversized payloads

## 3D Confidence Model

Instead of a single confidence number, tracks three dimensions:

1. **Evidence Confidence** (0-1)
   - Source authority (domain trust scoring, academic vs web)
   - Source freshness
   - Corroboration count (how many independent sources agree)

2. **Extraction Confidence** (0-1)
   - Method reliability (LLM > regex > direct extract)
   - Content quality (well-structured vs noisy)
   - Whether content was scrubbed

3. **Consistency Confidence** (0-1)
   - Agreement ratio among sources on this claim
   - Contradiction resolution status
   - Cross-source triangulation

**Aggregate**: `Math.min(evidence, extraction, consistency)` (conservative)

## Model Routing

Two LLM models configured separately:

| Model                        | Role                                                           | Temperature |
| ---------------------------- | -------------------------------------------------------------- | ----------- |
| `DEEP_RESEARCH_MODEL`        | Orchestrator: planning, evaluation, decision, audit, synthesis | 0.7         |
| `DEEP_RESEARCH_WORKER_MODEL` | Worker: extraction, classification, search query generation    | 0.3         |

Both share the same base URL (OpenAI-compatible).

## Job Manager (`src/research/jobManager.ts`)

Manages job lifecycle:

- Status flow: `queued → running → complete/failed/cancelled → expired`
- Tracks bounded partial state (source count, finding count, etc.)
- Provides AbortSignal for cancellation
- Automatic TTL cleanup every minute
- Adaptive timeout extension for complex topics

## Failure Mitigations

1. **State explosion**: Hard caps per sub-question (max 15 sources, max 25 findings). Pruning: keep top-K findings per sub-question by confidence.
2. **Degenerate loops**: Max iterations (budget-constrained). Confidence plateau detection (<5% improvement). Diminishing returns threshold.
3. **Partial failure**: Mark failed sub-questions. Degraded synthesis mode. Explicit "coverage gaps" in output report.
4. **LLM fallback**: Agent → pipeline fallback when LLM produces no results. Rule-based modules as fallbacks for all phases.

## Tool Ecosystem Integration

| Existing Tool        | Integration Point                                                               |
| -------------------- | ------------------------------------------------------------------------------- |
| `domainTrust.ts`     | Feeds into Evidence Confidence (domain authority score)                         |
| `contentScrubber.ts` | Extraction pre-processing; risk score → Extraction Confidence adjustment        |
| `semantic_crawl`     | Gap filling strategy — prefer semantic crawl on known domains over blind search |
| `queryExpansion.ts`  | Decomposition feedback — sub-questions feed into query expansion                |

## Module Boundaries

```
src/research/
├── orchestrator.ts        # Strategy selection, depth profiles, LLM config
├── jobManager.ts          # Job lifecycle, TTL, abort signals
├── state.ts               # ResearchStateEngine (mutable state container)
├── progress.ts            # Progressive rendering timeline
├── types.ts               # Shared types (ResearchState, Finding, Source, etc.)
│
├── strategies/            # Pluggable research strategies
│   ├── index.ts           # Strategy registration
│   ├── registry.ts        # StrategyRegistry singleton
│   ├── types.ts           # Strategy interface
│   ├── pipelineStrategy.ts # 7-phase pipeline (default)
│   ├── agentStrategy.ts  # ReAct-style agent (LLM required)
│   └── treeStrategy.ts   # Delegates to pipeline with tree depth
│
├── phases/                # Composable pipeline phases
│   ├── index.ts           # Phase exports
│   ├── basePhase.ts       # Base phase class
│   ├── decompositionPhase.ts  # Query → sub-questions
│   ├── discoveryPhase.ts     # Source finding
│   ├── extractionPhase.ts    # Content extraction (rule-based)
│   ├── gapLoopPhase.ts       # EDA loop for gap filling (LLM only)
│   ├── postProcessingPhase.ts # Finding merge, contradiction detection
│   ├── auditPhase.ts          # State validation
│   └── synthesisPhase.ts      # Report generation
│
├── llm/                   # LLM integration
│   ├── chat.ts            # DeepResearchLlmClient (model routing)
│   ├── prompts.ts         # System prompts for different roles
│   ├── extractor.ts       # Worker-based extraction
│   └── synthesis.ts       # LLM-powered report synthesis
│
├── pool/                  # Worker pool (V5)
│   └── workerPool.ts     # WorkerPoolManager
│
├── treeEngine.ts          # DeepTreeResearchEngine
├── decomposer.ts          # QueryDecomposer (rule-based)
├── taxonomy.ts           # TaxonomyRevision
├── discovery.ts           # DiscoveryEngine (multi-backend)
├── extraction.ts         # ExtractionEngine (rule-based)
├── gapAnalysis.ts        # GapAnalyzer + GapFiller
├── audit.ts               # StateAuditor (7 checks)
├── synthesizer.ts        # ResearchSynthesizer (rule-based)
├── contradictionGenerator.ts # Contradiction detection
├── pruning.ts            # State pruning
├── compaction.ts         # Result compaction for MCP
├── compactionInFlight.ts # In-progress compaction
├── provenance.ts         # Source provenance tracking
├── findingLinkage.ts     # Finding clustering
├── sourceQuality.ts      # Quality assessment
├── sourceRanking.ts      # URL ranking
├── urlHealth.ts          # URL validation
├── language.ts           # Language detection
├── actionGates.ts        # Per-step action flags
├── agenda.ts             # Structured agenda management
├── retry.ts              # Retry logic
└── workerAgent.ts        # Worker agent implementation
```

When LLM is not configured, all phases fall back to their rule-based counterparts.
