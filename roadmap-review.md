# Roadmap Synchronization Review

**Canon**: `docs/plans/index.md`  
**Reviewed**: `ROADMAP.md`, `PROGRESS.md`  
**Date**: 2026-05-01

---

## Summary

`PROGRESS.md` is fully synchronized with the canonical plan ordering and content. `ROADMAP.md` has **three remaining actionable ordering issues** and **one content omission**.

---

## Actionable Issues

### 1. ROADMAP.md — Current-State Table Out of Order
**Location**: `ROADMAP.md` line 3–18 (Current State table)  
**Issue**: Rows are not in canonical chronological order. The table starts with V3.1.5, then V3.1.1, V3.1 Phase 1, V3.0.5, V3.1.0 Code, V3.0.0, V3.2.0…  
**Canonical order** (from `docs/plans/index.md` Current State + Summary Table):
1. V3.0.0
2. V3.0.5
3. V3.1 Phase 1
4. V3.1.0 Code
5. V3.1.1
6. V3.1.5
7. V3.2.0
8. V3.3.0
9. V3.3.1
10. V3.4.0

**Fix**: Re-sort the table rows to match the canonical sequence.

---

### 2. ROADMAP.md — Detailed Sections Wildly Out of Order
**Location**: `ROADMAP.md` H2 sections  
**Issue**: Canonical plan sections appear in chronological order (V3.0.0 → V3.0.5 → V3.1.0 → V3.1.1 → V3.1.5 → V3.2.0 → V3.3.0 → V3.3.1 → V3.4.0).  
ROADMAP.md instead orders them:
1. V3.1.1
2. V2.0.0 (legacy)
3. V3.0.0
4. V3.0.5
5. V3.1.0
6. V3.1.5
7. **V3.4.0** ← appears here, between V3.1.5 and V4.0.0
8. V4.0.0
9. V4.1.0
10. V4.2.0
11. V4.3.0
12. **V3.2.0** ← appears at the very end, after all V4.x sections

V3.3.0 and V3.3.1 have no detailed sections at all.

**Fix**: Reorder H2 sections to canonical chronological order, inserting missing V3.3.0 and V3.3.1 sections. Keep V2.0.0 and V4.x sections as legacy/future bookends if desired, but place them consistently (e.g., V2 before V3, V4 after V3).

---

### 3. ROADMAP.md — Missing Detailed Sections for V3.3.0 and V3.3.1
**Location**: `ROADMAP.md`  
**Issue**: No H2/H3 sections exist for V3.3.0 or V3.3.1. The canonical plan contains detailed specs for both (8-stage kill chain for V3.3.0, DuckDuckGo + Ollama search backend for V3.3.1).  
ROADMAP.md only mentions V3.3.0 in the current-state table and mentions V3.3.1 once in a bullet at the end of the V3.0.0 section.

**Fix**: Add summary-grade sections for V3.3.0 and V3.3.1 that mirror the canonical plan’s key deliverables, or insert cross-references to `docs/plans/v3.3.0/` and `docs/plans/v3.3.1/`.

---

### 4. ROADMAP.md — V3.2.0 Description Omits Distribution Packaging
**Location**: `ROADMAP.md` Current State table row: “V3.2.0 | 🟡 In progress | Domain adapters … dedup”  
**Issue**: The description is missing the **distribution packaging** deliverable (Docker Compose bundle, Ollama/Transformers.js, MCP registry publishing), which the canonical plan explicitly lists as part of the V3.2.0 scope (moved from the old V3.4.0 phase-6 milestone).

**Fix**: Append “distribution packaging (Docker Compose, Ollama, registry)” to the V3.2.0 table-row notes.

---

## Verified Correct — No Issues

| Item | File | Evidence |
|------|------|----------|
| V3.3.1 inserted after V3.3.0 | Both | Table row present with “🟡 Planned” status; Up Next references it. |
| V3.2.0 status | Both | “In progress / Planning in progress” — consistent with canonical plan. |
| Up Next ordering | `PROGRESS.md` | V3.3.1 listed before V3.4.0, matching canonical plan. |
| Phase Status table order | `PROGRESS.md` | V3.0.0 → V3.0.5 → V3.1.0 → V3.1.1 → V3.1.5 → V3.2.0 → V3.3.0 → V3.3.1 matches canonical Summary Table exactly. |
| V3.3.1 content | Both | DDG zero-key fallback + opt-in Ollama web search + fusion/merge preservation — matches canonical spec. |
