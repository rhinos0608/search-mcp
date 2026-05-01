# V3.3.1 — Out-of-Box Search Backends

**Status**: Planning
**Priority**: High
**Depends On**: V3.3.0

**Research Sources**:

- `src/tools/webSearch.ts`, `src/config.ts`, `src/utils/searchMerge.ts` — current search orchestration, availability gating, and result fusion
- [OpenClaw DuckDuckGo search](https://docs.openclaw.ai/tools/duckduckgo-search) — key-free HTML fallback with bot-challenge risk
- [OpenClaw Ollama web search](https://docs.openclaw.ai/tools/ollama-search) — opt-in account-gated backend; free account/API key required
- [OpenClaw Web Search overview](https://docs.openclaw.ai/tools/web) — provider precedence and merge patterns
- [OpenClaw SearXNG search](https://docs.openclaw.ai/tools/searxng-search) — self-hosted, key-free JSON provider

## Summary

V3.3.1 adds search backends that work without paid API keys, while keeping the current crawl4ai/browser layer and search fusion stack intact.

Important: this plan is search-backend work only. It uses a distinct search label, proposed as `ollama-search`, so `EMBEDDING_PROVIDER=ollama` stays separate from the new web-search path.

The concrete anchors are:

- **DuckDuckGo** — zero-key, always-on fallback
- **Ollama web search** — opt-in account-gated backend for users who want an Ollama-backed search path

Existing providers stay in place:

- Brave / Exa remain key-backed options
- SearXNG remains the self-hosted key-free fallback
- `mergeSearchBackends` and result fusion stay the ranking path when multiple backends are available

## Backend Classes

| Backend           | Class                  | Setup friction | Notes                                                                                                |
| ----------------- | ---------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| DuckDuckGo        | zero-key / always-on   | none           | HTML scraping, experimental, bot-challenge risk                                                      |
| Ollama web search | opt-in / account-gated | low-medium     | proposed label: `ollama-search`; use `SEARCH_OLLAMA_*` config so it does not collide with embeddings |
| SearXNG           | self-hosted/free       | medium         | already supported; remains the structured self-hosted fallback                                       |
| Brave / Exa       | key-backed             | medium         | retained, not the out-of-box anchor                                                                  |

## Problem

Today the default search path still leans on either self-hosted SearXNG or key-backed providers. That leaves a gap for users who want immediate search coverage without paid APIs _and_ without self-hosting.

## Goals

1. Make `web_search` useful with no paid API key.
2. Add at least one true zero-key backend and one opt-in account-gated backend.
3. Keep existing normalization, dedupe, and fusion behavior unchanged in spirit.
4. Preserve explicit provider overrides for operators who want determinism.
5. Keep crawl4ai/browser automation as the rendered-page layer, not the search backend strategy.

## Non-Goals

- No browser/CDP search backend rewrite.
- No new query-expansion work.
- No change to semantic crawl or RAG adapters.
- No removal of existing Brave, Exa, or SearXNG support.

## Proposed Behavior

### 1. Provider selection becomes availability-aware

If the user does not pin a backend explicitly, `web_search` should prefer available out-of-box providers before falling back to key-backed ones.

### 2. DuckDuckGo is the zero-key default

DuckDuckGo should be available with no config and no key. It is the cheapest path to “works right now”.

### 3. Ollama is the opt-in backend

If an Ollama account/API key is configured, Ollama web search should be selected before dropping to worse fallbacks.

### 4. Existing merge/fusion stays in charge

When more than one backend is healthy and merge mode is enabled, the current `searchMerge` + `rrfMerge` path should rank the combined results.

## Integration Points

- `src/config.ts`
  - extend backend config and availability detection
  - add Ollama/DuckDuckGo config surface if needed
  - allow explicit `auto` / availability-driven selection
- `src/tools/webSearch.ts`
  - add backend adapters and updated fallback order
  - keep `mergeSearchBackends` opt-in
- `src/utils/searchMerge.ts`
  - add new backend source labels and keep canonical URL dedupe stable
- `src/types.ts`
  - expand `SearchResult.source` union for new backends
- `src/utils/backendHealth.ts` (new)
  - per-backend sliding-window health monitoring with degradation/recovery thresholds
- `src/utils/botChallenge.ts` (new)
  - bot-challenge detection, exponential backoff with jitter, circuit-breaker state machine
- `src/server.ts`
  - keep the current tool surface; only add schema fields if config surfaces need them

## Acceptance Criteria

- Zero-key installs can return results without any API keys.
- A configured Ollama account/API key can serve search results without a paid search API.
- The search backend name and env vars remain distinct from `EMBEDDING_PROVIDER=ollama`.
- Existing configured Brave/Exa/SearXNG paths still work.
- Merged results do not duplicate the same URL across backends.
- Search output still carries stable citation metadata (`position`, `domain`, `source`, `engines`).

## Risks

- DuckDuckGo HTML parsing may break or trigger bot challenges.
- Ollama availability depends on an explicitly configured account/API key and the provider's hosted availability.
- The new search path must avoid config-name collisions with existing Ollama embeddings.
- More backends mean more duplicates and timeout edges.
- Default-provider changes can surprise users if explicit override semantics are unclear.

## Mitigation

### Backend health criteria

- Keep explicit provider selection first-class.
- Use short per-backend timeouts and existing retry guards.
- Keep merge opt-in unless the backend roster meets the health threshold: at least 2 distinct search backends returned non-empty results within the configured per-backend timeout for the last N requests (configurable N). When the healthy roster contains fewer than 2 distinct backends, merge mode remains disabled and the system falls back to using the single healthy backend; if no healthy backends exist, the system returns a 503 Service Unavailable or follows a configurable fallback policy. Additionally, a backend is considered degraded if its recent timeout/error rate exceeds 20% over the last N requests. Degraded backends are excluded from the healthy roster until the rate drops below 10% (relative to the same window N).
- Keep Ollama opt-in and disabled by default unless explicitly configured.
- Use distinct `SEARCH_OLLAMA_*` env vars so search config does not collide with embeddings.
- Fall back to SearXNG / Brave / Exa when zero-key providers fail.

### Bot-challenge detection and response

- **Detection**: Monitor provider responses for repeated HTTP 403/429 status codes, challenge HTML fingerprints (e.g., CAPTCHA iframes, challenge script tags, redirect to challenge domain), or unusually high latency indicative of rate limiting.
- **Immediate actions**: When a bot challenge is detected on a provider, immediately mark that provider as unhealthy, apply exponential backoff with jitter on retries (initial delay 10s, multiplier 2x, max 300s), and engage a circuit-breaker retry guard that trips after 3 consecutive challenge responses within a 5-minute window.
- **Fallback behavior**: Switch to the next provider in the fallback chain. For zero-key providers use DuckDuckGo → SearXNG → Brave → Exa; for key-backed or opt-in providers use Exa → Brave → SearXNG → DuckDuckGo. Log each challenge incident with provider name, response code, and fallback action taken for operator review.
