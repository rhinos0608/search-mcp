## Review

### Correct: Ollama search is clearly distinguished from existing Ollama embeddings
- **SPEC.md** (docs/plans/v3.3.1/SPEC.md): Explicitly states the plan is "search-backend work only" and proposes the label **`ollama-search`** so **`EMBEDDING_PROVIDER=ollama`** stays separate from the new web-search path. The backend table shows `ollama-search` with `SEARCH_OLLAMA_*` config. Risks and mitigations both call out avoiding config-name collisions with existing Ollama embeddings.
- **IMPLEMENTATION.md** (docs/plans/v3.3.1/IMPLEMENTATION.md): Uses `SEARCH_OLLAMA_BASE_URL` / `SEARCH_OLLAMA_API_KEY` and explicitly notes they must not collide with `EMBEDDING_OLLAMA_*`.
- **Roadmap index** (docs/plans/index.md): Includes a bold note: "This is search-backend work only; Ollama embeddings stay under V3.2.0 / `EMBEDDING_PROVIDER=ollama`.

### Correct: Problem statement acknowledges SearXNG/self-hosted zero-key support
- **SPEC.md Problem** (docs/plans/v3.3.1/SPEC.md): "Today the default search path still leans on either **self-hosted SearXNG** or key-backed providers. That leaves a gap for users who want immediate search coverage without paid APIs **and without self-hosting**."
- **Summary**: "SearXNG remains the self-hosted key-free fallback."
- **Goals / Non-Goals**: Existing SearXNG, Brave, and Exa support are explicitly preserved; SearXNG is listed in the backend classes table as "self-hosted/free — already supported; remains the structured self-hosted fallback."

### Correct: v3.3.1 roadmap insertion is coherent
- **docs/plans/index.md** places V3.3.1 logically after V3.3.0 (Complete) and before V3.4.0 (Integration). The summary table at the bottom includes the correct scope, estimated LOC (~900), and links to SPEC.md and IMPLEMENTATION.md. The v3.3.1 spec and implementation docs are internally consistent with the roadmap index summary.

---

### Note: Two canonical docs are stale and out of sync with the updated index
These are not blockers for the v3.3.1 plan itself, but they will mislead readers who check the high-level roadmap or progress pages.

1. **`ROADMAP.md` status table is stale**
   - V3.3.0 is still marked **🔲 Pending** despite `docs/plans/index.md` and `PROGRESS.md` marking it Complete.
   - **V3.3.1 is entirely missing** from the status table and the body.
   - **V3.4.0 scope is outdated** in `ROADMAP.md` (still "Distribution & Local-First Deployment" with Docker / Ollama embedding / registry), while `docs/plans/index.md` and `PROGRESS.md` have moved that scope to V3.2.0 and redefined V3.4.0 as "Integration" (resolver pattern, output budget, structured errors, diagnostics).

2. **`PROGRESS.md` "Up Next" skips V3.3.1**
   - The Up Next section jumps directly from **V3.3.0** to **V3.4.0 — Integration** without acknowledging the planned V3.3.1 search-backend expansion.
   - `PROGRESS.md` also incorrectly marks **V3.2.0 as Complete ✅**, while `docs/plans/index.md` shows it as "Planning in progress" and the codebase lacks the V3.2.0 domain adapter tools (`semantic_stackoverflow`, `semantic_hackernews`, etc.).

**Action**: Update `ROADMAP.md` status table/body and `PROGRESS.md` Up Next to align with `docs/plans/index.md` so there is a single source of truth for version status and scope.

---
*No other actionable issues found. The naming/config separation is clean and unambiguous.*
