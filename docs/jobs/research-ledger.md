# Jobs research ledger

This ledger records dossier evidence and caveats; it is not a new source of facts.

| ID      | Finding                                                             | Evidence / caveat                                            |
| ------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| E01     | Acquisition is JobSpy-first fallback                                | `src/rag/jobPipeline.ts:191-219`                             |
| E02     | JobSpy defaults limited boards                                      | `src/utils/jobspyClient.ts:18,94-109`                        |
| E03     | One location, remote filtering, fixed 72h semantics                 | `src/tools/semanticJobs.ts:98-117`                           |
| E04     | Quality policy embeds Sydney/AU/seniority assumptions               | `src/rag/quality/types.ts:138-150`                           |
| E05     | Metadata rank stage ignores query                                   | `src/rag/jobRanking.ts:47-55`; pipeline `378-398`            |
| E06     | Enrichment truncates before semantic relevance                      | `src/rag/jobPipeline.ts:404-405,606-651`                     |
| E07     | Raw RRF mixed with unrelated scale                                  | `src/rag/pipeline.ts:276-293`; ranking `73-90`               |
| E08     | Company/title dedup merges destructively                            | `src/rag/jobDedup.ts:91-115`                                 |
| E09     | Rich JobSpy fields do not survive sparse model                      | `src/utils/jobspyClient.ts:27-62`; `src/rag/types/job.ts`    |
| E10     | Existing graph lacks observations/lifecycle/interactions            | `src/utils/jobGraphDb.ts:45-143`                             |
| E11     | Candidate-profile infrastructure absent                             | Current schemas and repository map                           |
| E12     | Document parsers and ZIP guards exist                               | `src/utils/documentExtraction.ts`; office parser `1-77`      |
| E13     | Python JobSpy sidecar appears unused                                | Direct `jobspy-js` imports; repository/Compose scan          |
| E14     | SEEK automation policy blocker                                      | Captured robots/terms evidence                               |
| E15     | EthicalJobs XML publishes listings, not discovery API               | Official EthicalJobs help evidence                           |
| E16     | NSW framework and APS WLS structures validated                      | NSW Government/APSC primary evidence                         |
| E17     | SSRF guard lacks resolved-address/redirect validation               | `src/httpGuards.ts:71-174`                                   |
| E18     | Raw job queries/location can enter logs                             | `src/tools/standalone/semanticJobs.ts:113`; client `149-175` |
| E19–E22 | Observation/lifecycle, missing weights, `$HOME`, dual-write defects | Prior dossier; corrected in frozen design                    |

Research roles: A current architecture/call graph/tests; B acquisition/source ecosystem; C Sydney/NSW topology; D classifications/enrichment; E retrieval/ranking/evaluation; F profile/reasoning; G MCP interaction; H persistence/security/operations. Oracle pass 1 reconciled research and corrected source overclaims; user review supplied binding amendments; Oracle pass 2 froze this dossier.

Caveats retained: PageUp and government routes remain under-researched; public-looking ATS endpoints require tenant/terms review; source-policy evidence can age; parser network isolation requires deployment enforcement; compatibility consumers may be absent from repository search.
