# Structured Extraction Improvements Implementation Plan

> Source design: `docs/superpowers/specs/2026-04-24-structured-extraction-improvements-design.md`
>
> Scope guard: tighten existing structured-content callers only. Do not expand structured extraction to new tools during this implementation.

## Plan Review Fixes

This plan incorporates the review findings against the design and current codebase:

- Finalized HTML helpers must accept an optional base URL so relative image URLs keep current `webRead` behavior.
- Raw extractors should stop enforcing the final `MAX_ELEMENTS` budget, but they still need a generous candidate safety cap to avoid unbounded memory work on huge pages.
- GitHub file structured code must be built from decoded UTF-8 content, not from the base64 response body used when `raw=false`.
- YouTube transcript structured output should be intentionally migrated from per-segment unfinalized elements to one finalized text element for the returned transcript text.
- Stack Overflow must use finalized HTML output, not markdown output.
- Focused verification must include Stack Overflow and YouTube because both callers are in scope.

## Target Contract

`StructuredContent` remains additive and optional:

```ts
interface StructuredContent {
  elements?: ContentElement[];
  truncatedElements?: true;
  originalElementCount?: number;
  omittedElementCount?: number;
}
```

Element-local payload truncation is explicit only for elements with one large payload field:

```ts
interface TextElement {
  type: 'text';
  text: string;
  truncated?: true;
  originalLength?: number;
}

interface CodeElement {
  type: 'code';
  language: string | null;
  content: string;
  truncated?: true;
  originalLength?: number;
}

interface TableElement {
  type: 'table';
  markdown: string;
  caption: string | null;
  rows: number;
  cols: number;
  truncated?: true;
  originalLength?: number;
}
```

Metadata is omitted when it does not apply. Do not add element-local truncation metadata to headings, lists, images, or table captions in this pass.

## Shared Constants And Helpers

Keep `MAX_ELEMENTS = 50` as the final output budget.

Add a separate raw candidate safety cap, for example `MAX_RAW_ELEMENTS = 1000`, used only by raw extractors as a defensive bound. If that cap is reached, extraction may stop, but the finalization metadata still reports the number of candidates the helper received.

Centralize text truncation behavior in the helper layer or a small shared utility so HTML extraction, markdown extraction, text wrapping, and code wrapping all attach identical metadata for `TextElement`, `CodeElement`, and `TableElement`.

## Helper API Shape

Update `src/utils/elementHelpers.ts` to return spreadable structured-content objects:

```ts
export function safeStructuredFromHtml(
  html: string | null | undefined,
  baseUrl?: string,
): StructuredContent;
export function safeStructuredFromMarkdown(markdown: string | null | undefined): StructuredContent;
export function wrapTextAsStructuredContent(text: string | null | undefined): StructuredContent;
export function wrapCodeAsStructuredContent(
  content: string | null | undefined,
  language: string | null,
): StructuredContent;
export function finalizeStructuredContent(elements: ContentElement[]): StructuredContent;
```

Old array-returning helper names may remain temporarily only if tests or transitional call sites need them. Final caller code should use the structured helper names above.

## Selection Rules

When raw candidates exceed `MAX_ELEMENTS`:

1. Attach each candidate's original index.
2. Score element types deterministically:
   - heading: `100 + (7 - level)`
   - table: `90`
   - code: `85`
   - list: `75`
   - image: `65`
   - text: `50`
3. Sort by score descending, then original index ascending.
4. Select up to `MAX_ELEMENTS`.
5. Sort selected elements back by original index before returning.
6. Return `truncatedElements: true`, `originalElementCount`, and `omittedElementCount`.

When candidates are within budget, return `{ elements }`. Return `{}` for empty or whitespace-only inputs.

## Task 1: Add Tests First

Files:

- `test/htmlElements.test.ts`
- `test/markdownElements.test.ts`
- `test/elementHelpers.test.ts`
- `test/webReadElements.test.ts`
- `test/webCrawlElements.test.ts`
- `test/githubRepoFile.test.ts`
- Stack Overflow focused test file if present or a new focused test
- YouTube transcript focused test file if present or a new focused test

Steps:

- Add raw extractor tests proving a late heading/table is still emitted after more than `MAX_ELEMENTS` early low-value text candidates.
- Add element-local truncation tests for text, code, and table markdown.
- Add finalization tests for over-budget prioritization, restored document order, and top-level omission metadata.
- Add helper tests for empty inputs returning `{}` and URL-aware image resolution.
- Add caller tests:
  - `webRead` preserves relative image URL resolution and emits omission metadata.
  - `webCrawl` emits finalized markdown omission metadata.
  - `githubRepoFile` emits code elements from decoded content for both `raw=true` and `raw=false`.
  - Stack Overflow spreads finalized HTML structured output.
  - YouTube emits finalized transcript text output and omission metadata only if applicable.

Verification:

```bash
npm test test/htmlElements.test.ts test/markdownElements.test.ts test/elementHelpers.test.ts test/webReadElements.test.ts test/webCrawlElements.test.ts test/githubRepoFile.test.ts
```

Include the Stack Overflow and YouTube focused tests in this command once their filenames are identified or created.

Expected result before implementation: tests fail because the structured contract and helpers do not exist yet.

## Task 2: Extend Shared Types

File:

- `src/types.ts`

Steps:

- Add `truncatedElements?: true`, `originalElementCount?: number`, and `omittedElementCount?: number` to `StructuredContent`.
- Add `truncated?: true` and `originalLength?: number` to `TextElement`, `CodeElement`, and `TableElement`.
- Keep `GitHubFileResult.truncated: boolean` and other existing tool-level flags unchanged.

## Task 3: Make Raw Extractors Candidate-Oriented

Files:

- `src/utils/htmlElements.ts`
- `src/utils/markdownElements.ts`

Steps:

- Replace final-budget breaks with the separate raw candidate safety cap.
- Preserve document order.
- Use shared truncation metadata for `TextElement.text`, `CodeElement.content`, and `TableElement.markdown`.
- Keep current truncation behavior for headings, list items, image alt/title, and table captions without adding metadata.
- Preserve existing HTML image source safety filtering and JSDOM URL resolution behavior.

## Task 4: Centralize Finalization

Files:

- `src/utils/elementHelpers.ts`
- `test/elementHelpers.test.ts`

Steps:

- Implement `finalizeStructuredContent(elements)`.
- Implement `safeStructuredFromHtml(html, baseUrl?)` with `JSDOM(html, baseUrl ? { url: baseUrl } : undefined)` and guaranteed `window.close()`.
- Implement `safeStructuredFromMarkdown(markdown)` with best-effort failure behavior returning `{}`.
- Implement `wrapTextAsStructuredContent(text)`.
- Implement `wrapCodeAsStructuredContent(content, language)` directly as a code element.
- Ensure all helpers omit structured-content fields for empty input.

## Task 5: Migrate Existing Callers

Files:

- `src/tools/webRead.ts`
- `src/tools/webCrawl.ts`
- `src/tools/githubRepo.ts`
- `src/tools/githubRepoFile.ts`
- `src/tools/redditSearchParser.ts`
- `src/tools/stackoverflowSearch.ts`
- `src/tools/youtubeTranscript.ts`

Steps:

- Replace direct raw HTML extraction in `webRead.ts` with `safeStructuredFromHtml(content, url)` and `safeStructuredFromHtml(html, url)` as appropriate.
- Replace direct raw markdown extraction in `webCrawl.ts` with `safeStructuredFromMarkdown(markdown)`.
- Update `githubRepo.ts` and `redditSearchParser.ts` to spread finalized markdown helper output.
- Update `stackoverflowSearch.ts` to spread finalized HTML helper output.
- Replace `githubRepoFile.ts` text-wrap-then-mutate behavior with `wrapCodeAsStructuredContent(decodedFinalContent, detectLanguage(path))`, where `decodedFinalContent` is the UTF-8 text before response base64 encoding.
- Update `youtubeTranscript.ts` to wrap the finalized returned transcript text once, using the same text that backs `fullText`.
- Preserve existing omission behavior: when no elements exist, no structured-content fields should be emitted.
- Preserve existing cache payload shape apart from additive structured metadata.

## Task 6: Documentation Sync

Files to check:

- `docs/composition-with-rag-anything.md`
- `docs/tools.md`
- Any docs mentioning `elements` or structured content

Steps:

- Document optional `truncatedElements`, `originalElementCount`, `omittedElementCount`.
- Document element-local `truncated` and `originalLength` for text, code, and table elements.
- Keep wording clear that structured content remains best-effort and optional.

## Task 7: Full Verification

Run:

```bash
npm test test/elementHelpers.test.ts test/htmlElements.test.ts test/markdownElements.test.ts test/webReadElements.test.ts test/webCrawlElements.test.ts test/githubRepoFile.test.ts test/redditSearchParser.test.ts test/redditSearchCompatibility.test.ts
npm test test/stackoverflowSearch.test.ts test/youtubeTranscript.test.ts
npm run typecheck
npm run lint
```

If exact Stack Overflow or YouTube test filenames differ, use the actual focused filenames.

## Exit Criteria

- Raw extractors preserve late high-signal candidates while staying defensively bounded.
- Element-local truncation is explicit for text, code, and table markdown.
- Final structured output explicitly reports omitted elements when final budgeting drops candidates.
- Existing structured-content callers spread the same finalized contract.
- Documentation reflects the additive metadata fields.
- Focused tests, typecheck, and lint pass or any remaining failures are clearly unrelated and documented.
