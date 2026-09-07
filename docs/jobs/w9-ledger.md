# W9 Assessment + Ranking — Closure Ledger

**Wave:** W9
**Date:** 2026-01-01
**Status:** Complete

## Scope

Implemented W9 assessment + ranking using enriched canonical posting and real W8 output.

### Additive Modules

| Module                             | Purpose                                                   |
| ---------------------------------- | --------------------------------------------------------- |
| `src/jobs/assessment/contracts.ts` | Schemas: grouped scores, eligibility, PA delta            |
| `src/jobs/assessment/scorer.ts`    | Component scoring, eligibility gates, PA delta processing |
| `src/jobs/assessment/index.ts`     | Barrel exports                                            |
| `src/jobs/ranking/ranker.ts`       | Utility aggregation, diversity presentation, ranking      |
| `src/jobs/ranking/index.ts`        | Barrel exports                                            |
| `test/jobs/assessment.test.ts`     | 24 tests covering all invariants                          |

### Public Grouped Score Fields (exactly)

`relevance`, `candidateFit`, `preferenceFit`, `marketState`, `evidenceQuality`, `personalAdaptation`

### Frozen Invariants Satisfied

| Invariant                         | Implementation                                                     |
| --------------------------------- | ------------------------------------------------------------------ |
| Missing evidence → stable 0.5     | `neutralComponent()` returns 0.5 with `hasEvidence: false`         |
| Coverage/confidence falls         | Components with missing evidence get `confidence: 0.3`             |
| No weight redistribution          | Group weights sum independently; zero-weight groups skipped        |
| Eligibility separate from utility | `EligibilityVerdict` is a discrete field, not part of utilityScore |
| W11 delta ±0.10                   | `processPersonalAdaptationDelta()` clamps to ±0.10                 |
| Explicit preference once          | Single location/workMode/compensation component per group          |
| RRF excluded from utility         | `retrievalMetadata` param accepted but never used in scoring       |
| Diversity presentation only       | `applyDiversityPresentation()` returns identity (no-op)            |
| No LLM, network, persistence      | Pure deterministic computation                                     |
| Deterministic ties                | Sort by utilityScore desc, then candidateId asc                    |
| Explainable evidence refs         | Every `ComponentScore` carries `evidenceRefs[]`                    |

### Tests (24/24 pass)

1. All six score groups present
2. Missing evidence → stable 0.5
3. Absent evidence components → neutral 0.5
4. Contradicted evidence (confirmed_closed)
5. Weight accounting — no redistribution
6. Residual bounds [0, 1]
7. No RRF effect on utility
8. Preference-once contribution
9. Eligibility separate from utility
10. Diversity non-mutation
11. PA delta clamp ±0.10
12. Deterministic ties
13. computeUtilityScore weighted mean
14. Missing evidence fallback to 0.5
15. Evidence refs propagated
16. Flag propagation
17. Ranking truncation
18. Weight=0 no redistribution
19. Active group count
20. PA accepted delta
21. Conditionally eligible
22. Employment type mismatch ineligible
23. Component dimension strings
24. Evidence quality summary

### Prior Tests (31/31 pass)

`test/jobs/retrieval.test.ts` — no regressions
`test/jobs/evaluation.test.ts` — 26/26 pass

## Commands Run

| Command                                                   | Result                    |
| --------------------------------------------------------- | ------------------------- |
| `tsc --noEmit`                                            | passed                    |
| `eslint src/jobs/assessment/ src/jobs/ranking/`           | passed                    |
| `prettier --check src/jobs/assessment/ src/jobs/ranking/` | passed                    |
| `npm run build`                                           | passed                    |
| `tsx --test test/jobs/assessment.test.ts`                 | 24/24 pass                |
| `tsx --test test/jobs/retrieval.test.ts`                  | 31/31 pass                |
| `tsx --test test/jobs/evaluation.test.ts`                 | 26/26 pass                |
| `git status --short`                                      | only new files, no staged |
| `git diff --check`                                        | clean                     |

## Residual Risks

- Diversity presentation is a no-op; future waves may add score-gap exempt moves
- PA delta defaults to 0 (no learning); W11 wiring needed
- Eligibility gates are posting-level; candidate-level eligibility (skills) not yet implemented
- No live W8 evidence flow (orchestration wire not connected)

## Unimplemented

- W11 learning pipeline → PA delta supply
- Orchestration wire: W8 → W9 → ranking
- Candidate-level eligibility (skills, certifications)
- Diversity moves with score-gap exemptions
