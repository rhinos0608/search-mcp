# Jobs source coverage

Technical adapters and source policy remain separate. This matrix records intended routes and gates; it does not claim implementation or availability.

| Source family                                   | Route                                                      | Priority / decision                                                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing JobSpy                                 | `jobspy-js` adapter                                        | P0 retain rich fields; remove global remote/freshness assumptions                                                                                           |
| I Work for NSW / NSW Health                     | Generic portal/ATS after policy review                     | P0; no bypass; prioritize direct attachments                                                                                                                |
| APSJobs                                         | Candidate route pending current policy/access evidence     | P0; no invented API                                                                                                                                         |
| Workday                                         | Configured-tenant adapter                                  | P0; contract-test each tenant                                                                                                                               |
| PageUp                                          | Research then generic adapter                              | P0; access unresolved                                                                                                                                       |
| Greenhouse/Lever/Ashby/SmartRecruiters/Workable | Configured tenants                                         | P1; order by measured yield                                                                                                                                 |
| Sydney councils                                 | ATS registry + bounded permitted crawl                     | P1; sample platforms first                                                                                                                                  |
| Universities/research                           | ATS registry                                               | P1; USyd, UNSW, UTS, Macquarie, WSU                                                                                                                         |
| Healthscope/Ramsay/Calvary                      | ATS registry                                               | P1; detect platform; avoid bespoke scraper                                                                                                                  |
| NFP/disability employers                        | ATS/direct permitted routes                                | P1; bespoke only if reusable route impossible                                                                                                               |
| EthicalJobs XML                                 | No direct discovery route                                  | Blocked for direct discovery; endpoint publishes ads                                                                                                        |
| SEEK                                            | Direct board search/fetch unavailable absent authorization | Direct routes policy-blocked; permitted third-party indexed candidates remain visible, caveated, and `indexed_only`; manual/user-supplied imports supported |
| LinkedIn/other risky boards                     | Per-source disabled default                                | P2 risk; terms review/operator acceptance                                                                                                                   |
| LG Assist/Jora/secondary aggregators            | Conditional                                                | P2; policy and marginal-yield evidence first                                                                                                                |

## Edge and provenance rules

Policy modes: automated search/fetch, user-supplied content, manual import, employer API. Every decision records revision, evidence, date, and notes. Policy binds actor, operation, route, and target—not an information or evidence object. Discoverer, publisher, and content donor are distinct; snippets and summaries are provider-attributed donor evidence, not publisher facts. Indexed evidence does not inherit publisher restrictions. Any legal/confidentiality/safety handling propagation requires separate explicit classification with cited basis; no such subsystem is defined here.

Provider authorization permits provider search and indexed candidate admission only. It never grants direct publisher search or destination fetch. Direct blocked or unknown edges make zero direct calls, but do not discard valid third-party indexed candidates. Failed fetch retains indexed candidate with caveat and never upgrades verification.

`requires_review` never silently permits. Arbitrary URLs cannot select ATS tenants. Partial, failed, disabled, policy-blocked, and unsupported coverage remains visible. Wave 2B, persistence, and `query_log` retention/data-minimization gates remain unchanged.

## Settlement gates

I Work for NSW/Health access, APSJobs automation, PageUp route, EthicalJobs discovery, risky boards, and NSW framework redistribution/licensing require current policy/access evidence and bounded probes or review before enablement. Direct SEEK access remains blocked absent authorization; indexed discovery via permitted providers is not direct SEEK access.
