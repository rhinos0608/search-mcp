# ROADMAP.md / PROGRESS.md Re-Review Findings

Date: 2026-05-01
Scope: Canonical-order table, V3.2.0 note sufficiency, legacy/archive framing

---

## Review

### Correct (with evidence)

- **ROADMAP.md top banner** clearly states: *"Canonical plan status lives in `docs/plans/index.md`; this file is a legacy high-level summary and the detailed sections below are archival."* This orients readers correctly before they dive into body sections.
- **Current-state table ordering** in ROADMAP.md is strictly by version number (V3.0.0 → V4.3.0), matching the canonical order in `docs/plans/index.md`.
- **V3.2.0 table note** accurately reflects the scope defined in `docs/plans/index.md`: domain adapters (Stack Overflow, HN, academic, news), full job pipeline, `semantic_search`, constraint ranking, dedup, and distribution packaging (Phase 6).
- **V2.0.0 body section** is explicitly labeled `⚠️ Legacy`, consistent with the archival framing.
- **PROGRESS.md Phase Status table** is correctly ordered and statuses match `docs/plans/index.md` (V3.2.0 = planning in progress, V3.3.0 = complete).

---

### Blocker (critical issues that must be resolved)

#### 1. Body section order is scrambled and contradicts the canonical table

The ROADMAP.md table presents versions in canonical order, but the body sections are not. A reader scrolling or Ctrl+F-ing for a version will hit content in this sequence:

- V3.1.1 → V2.0.0 → V3.0.0 → V3.0.5 → V3.1.0 → V3.1.5 → **V3.4.0** → V4.0.0 → V4.1.0 → V4.2.0 → V4.3.0 → **V3.2.0** → V3.5.0

**Specific problems:**
- **V3.2.0** appears *after all V4.x sections*, despite being an in-progress V3 release.
- **V3.5.0** appears *after V4.3.0*, even though it logically belongs before V4.0.0.
- **V3.4.0** is wedged between V3.1.5 and V4.0.0, which is roughly correct by version number, but its content is stale (see Blocker #2).

**Impact**: The table says one thing about chronology/sequence; the body says another. This undermines the table's navigational value and makes the "archival" label feel like an excuse for disorganization.

**Resolution**: Reorder body sections to match the table's canonical version order: V3.0.0 → V3.0.5 → V3.1.0 → V3.1.1 → V3.1.5 → V3.2.0 → V3.3.0 (or a placeholder) → V3.3.1 (or placeholder) → V3.4.0 → V3.5.0 → V4.0.0 → V4.1.0 → V4.2.0 → V4.3.0. Move the V2.0.0 legacy block to an appendix or the end.

#### 2. V3.4.0 body is a stale legacy summary that contradicts the table

The ROADMAP.md table lists V3.4.0 as:

> 🟡 Planned | Integration: resolver pattern, output budget, structured errors, diagnostics

But the body section `## V3.4.0 — Integration (legacy summary)` is entirely about **distribution packaging** (Docker Compose bundle, MCP registry publishing, Ollama/Transformers.js local embedding). That content has been migrated into **V3.2.0 Phase 6** per `docs/plans/index.md`:

> V3.2.0 ... Includes distribution packaging (Docker Compose, Ollama/Transformers.js, MCP registry — originally V3.4.0) as Phase 6 intermediate milestone.

So the body section labeled "V3.4.0" describes a plan that no longer lives in V3.4.0, while the table describes a completely different scope for V3.4.0. There is *no* body section for resolver pattern, output budget, structured errors, or diagnostics.

**Impact**: A reader who trusts the table and then reads the body will find the wrong scope for a planned release. A reader who finds the body first will think distribution packaging is still a V3.4.0 deliverable, which is false.

**Resolution**: Remove or collapse the stale V3.4.0 distribution content into a V3.2.0 subsection (or delete it and rely on `docs/plans/index.md`). Add a new V3.4.0 body section (even a brief stub) that aligns with the table: resolver pattern, output budget, structured errors, diagnostics. Alternatively, if the file is strictly archival, remove the V3.4.0 body entirely and keep only the table row pointing to `docs/plans/v3.4.0/`.

#### 3. V3.2.0 body does not cover "distribution packaging" claimed in its table note

The table note for V3.2.0 explicitly promises:

> domain adapters ..., constraint ranking, dedup, **distribution packaging**

But the `## V3.2.0 — Domain Adapters + Structured Retrieval` body section has **zero mention** of Docker Compose, registry publishing, or Ollama/Transformers.js. That content is isolated in the misplaced V3.4.0 legacy section.

**Impact**: The table makes a scope promise that the body does not keep. Readers looking for the "distribution packaging" part of V3.2.0 will not find it under V3.2.0.

**Resolution**: Once the V3.4.0 distribution content is moved/collapsed, insert a "Phase 6 — Distribution Packaging" subsection inside the V3.2.0 body so the table note and body are consistent.

---

### Note (observation, risk, or follow-up item)

#### 4. V3.2.0 parallel-track status can confuse sequential readers

The current-state table shows V3.3.0 as **Done** while V3.2.0 is still **In progress**. This is factually correct (V3.3.0 shipped in parallel), but a reader scanning top-to-bottom in version order may assume something is wrong because a later version is complete before an earlier one. A brief parenthetical in the V3.2.0 table note or body header — e.g., *(parallel planning track; V3.3.0 shipped first)* — would remove the ambiguity without breaking canonical ordering.

#### 5. PROGRESS.md lacks a canonical-plan pointer

ROADMAP.md's banner directs readers to `docs/plans/index.md`; PROGRESS.md has no equivalent pointer. Since both files live at repo root and are likely to be opened first, adding a single line at the top of PROGRESS.md — *"Canonical plan status: `docs/plans/index.md`*" — would prevent readers from treating PROGRESS.md as the sole source of truth.

#### 6. Minor archival staleness in V3.1.0 body

The V3.1.0 body contains a subsection `### 2. Advanced Extraction (The "Kill Chain") [PLANNED]`. That work actually shipped as part of V3.3.0. Because the file is explicitly labeled archival at the top, this is acceptable, but it illustrates why per-section legacy labels (like the one used for V2.0.0 and V3.4.0) are safer than a single top-level banner.

---

## Summary

| # | Severity | File | Issue |
|---|----------|------|-------|
| 1 | Blocker | ROADMAP.md | Body sections are not in canonical version order (V3.2.0/V3.5.0 after V4.x; V3.4.0 misplaced). |
| 2 | Blocker | ROADMAP.md | V3.4.0 body is stale distribution content (now V3.2.0 scope) and contradicts the table's "resolver pattern, output budget, structured errors, diagnostics" scope. |
| 3 | Blocker | ROADMAP.md | V3.2.0 body missing "distribution packaging" scope that the table note promises. |
| 4 | Note | ROADMAP.md | V3.2.0 parallel-track status vs. V3.3.0 Done could confuse sequential readers; add clarifying parenthetical. |
| 5 | Note | PROGRESS.md | Missing pointer to `docs/plans/index.md` as canonical plan status. |
| 6 | Note | ROADMAP.md | V3.1.0 body still marks Kill Chain as [PLANNED] despite being completed in V3.3.0; tolerable under archival framing but worth a per-section legacy label. |
