---
name: Structured Extraction Improvements
description: Tighten the existing structured-content rollout with explicit truncation metadata, shared finalization, and consistent helper usage.
type: project
---

# Design Spec: Structured Extraction Improvements

## Review Outcome

The earlier structured-web-content plan is too broad for the repo's current state. This repository already shipped a first-pass structured-content rollout:

- `StructuredContent` already exists in `src/types.ts`
- `src/utils/elementHelpers.ts` already exists
- `githubRepo`, `githubRepoFile`, `redditSearchParser`, `stackoverflowSearch`, and `youtubeTranscript` already attach `elements`

The remaining work is not "add structured extraction everywhere." The real gap is that the current rollout stops too early, loses truncation intent, and does not finalize output consistently across callers.

## Current State

### What already works

- `web_read` can emit `elements` from extracted HTML.
- `web_crawl` can emit `elements` from markdown returned by Crawl4AI.
- Several non-web tools already expose structured content from markdown, HTML, or wrapped text/code.

### What is still wrong

1. `htmlElements.ts` and `markdownElements.ts` stop once they hit `MAX_ELEMENTS`, so later high-signal elements are never even considered.
2. String truncation is implicit. Callers can see `... [truncated]`, but they cannot tell which fields were shortened or what the original size was.
3. There is no shared finalization step that applies one deterministic budget and emits one common metadata contract.
4. `webRead.ts` and `webCrawl.ts` still call the raw extractors directly instead of going through a finalized helper path.
5. `githubRepoFile.ts` builds a text element and then mutates it into a code element, which is the wrong abstraction.

## Goal

Improve the current structured extraction pipeline so that:

- raw extractors preserve full candidate sets in document order
- per-element truncation is explicit
- final element selection is prioritized and deterministic
- top-level structured-content truncation is explicit
- all current structured-content callers emit the same finalized shape

## Non-Goals

- Expanding structured extraction to every tool in the repo
- Redesigning the element taxonomy
- Changing the JSON-RPC tool envelope
- Reworking semantic crawl output in this pass

## Design Decisions

### 1. Keep extraction and finalization separate

`htmlElements.ts` and `markdownElements.ts` should remain raw candidate extractors. They should:

- preserve document order
- extract as many candidates as they can
- annotate element-local truncation only

They should not decide the final output budget.

### 2. Add additive truncation metadata

`StructuredContent` should gain additive top-level metadata:

- `truncatedElements?: true`
- `originalElementCount?: number`
- `omittedElementCount?: number`

`TextElement`, `CodeElement`, and `TableElement` should gain additive field metadata:

- `truncated?: true`
- `originalLength?: number`

Metadata must be omitted when it does not apply.

### 3. Move budgeting into shared helpers

`elementHelpers.ts` should own finalization. That layer should:

- accept raw candidate arrays
- prioritize high-signal structural elements when over budget
- preserve headings preferentially
- restore original order before returning
- emit one `StructuredContent` object, not a bare `ContentElement[]`

This is the right place for:

- finalized HTML extraction
- finalized markdown extraction
- finalized plain-text wrapping
- finalized code wrapping

### 4. Unify current callers on the finalized contract

This pass should cover the callers that already participate in structured extraction today:

- `webRead.ts`
- `webCrawl.ts`
- `githubRepo.ts`
- `githubRepoFile.ts`
- `redditSearchParser.ts`
- `stackoverflowSearch.ts`
- `youtubeTranscript.ts`

The helpers should return a spreadable object so every caller emits the same shape and omission behavior.

### 5. Keep failure behavior non-fatal

Structured extraction remains best-effort:

- HTML helper failures must still close `JSDOM` windows
- markdown helper failures must degrade to no structured content
- tool handlers must still succeed without `elements`

## File Impact

| File                               | Planned responsibility                                         |
| ---------------------------------- | -------------------------------------------------------------- |
| `src/types.ts`                     | Add truncation metadata to shared structured types             |
| `src/utils/htmlElements.ts`        | Emit full candidate sets and annotate element-local truncation |
| `src/utils/markdownElements.ts`    | Same for markdown extraction                                   |
| `src/utils/elementHelpers.ts`      | Finalization, prioritization, budgeting, and wrapper helpers   |
| `src/tools/webRead.ts`             | Use finalized HTML helper output                               |
| `src/tools/webCrawl.ts`            | Use finalized markdown helper output                           |
| `src/tools/githubRepo.ts`          | Spread finalized markdown output                               |
| `src/tools/githubRepoFile.ts`      | Use dedicated finalized code wrapping                          |
| `src/tools/redditSearchParser.ts`  | Spread finalized markdown output                               |
| `src/tools/stackoverflowSearch.ts` | Spread finalized HTML output                                   |
| `src/tools/youtubeTranscript.ts`   | Use finalized text wrapping                                    |

## Acceptance Criteria

1. Raw extractors no longer discard later candidates purely because they appear after the first `MAX_ELEMENTS`.
2. Long text, code, and table payloads explicitly report truncation.
3. Final structured output explicitly reports when elements were omitted by the final budget.
4. `web_read`, `web_crawl`, and the current structured callers all emit the same finalized contract.
5. Focused tests pass and `npm run typecheck` passes.
