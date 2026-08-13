# Choppy Prose Diagnosis — webSearchResultFormatter

## Files Under Inspection

| File                                    | Lines   | Status                   |
| --------------------------------------- | ------- | ------------------------ |
| `src/tools/webSearchResultFormatter.ts` | 1–976   | Untracked (new)          |
| `test/webSearchResultFormatter.test.ts` | 1–1176  | Untracked (new)          |
| `src/tools/standalone/webSearch.ts`     | 13, 111 | Modified (import + call) |

## Minimal Concrete Example

**Input** (single paragraph):

```
The quick brown fox jumps over the lazy dog. This famous pangram has been used since the late 19th century. It contains every letter of the English alphabet.
```

**Current output** (choppy — each sentence on its own line):

```
The quick brown fox jumps over the lazy dog. [1-1]
This famous pangram has been used since the late 19th century. [1-2]
It contains every letter of the English alphabet. [1-3]
```

**Desired output** (coherent paragraph, inline citations):

```
The quick brown fox jumps over the lazy dog. [1-1] This famous pangram has been used since the late 19th century. [1-2] It contains every letter of the English alphabet. [1-3]
```

### List choppy example

**Input:**

```
- First point with detail. Supporting evidence here. Third sentence too.
- Second bullet.
```

**Current output** (continuation sentences lose bullet prefix, become bare lines):

```
- First point with detail. [1-1]
Supporting evidence here. [1-2]
Third sentence too. [1-3]
- Second bullet. [1-4]
```

### Blockquote choppy example

**Current output** (each sentence is a separate blockquote line):

```
> Important quote sentence one. [1-1]
> Quote sentence two. [1-2]
> Quote sentence three. [1-3]
```

(Least problematic — blockquote lines are naturally line-separated.)

## Root Cause Chain

1. **`splitIntoBlocks()`** (line 553–605): Correctly groups markdown into typed `Block` objects. A prose paragraph that is one blank-line-delimited block is one `Block { type: 'prose', text: '...' }`.

2. **`renderBlock()`** (line 621–668): For each block type, creates `RenderUnit[]`. **THE PROBLEM** — for `type === 'prose'` (line 660–664):

   ```ts
   for (const sentence of splitIntoSentences(text)) {
     units.push({ text: sentence, prose: true, citation: 'inline' });
   }
   ```

   Each sentence becomes an **independent** `RenderUnit`. No notion of "these sentences belong to the same paragraph."

3. **`formatDocument()` emission loop** (line 871–887):

   ```ts
   const cited = renderCited(unit);
   const candidate = text + cited + '\n';
   ```

   Every unit gets `\n` appended. Sentences from the same paragraph each land on their own line → choppy.

4. **Same pattern for lists** (line 636–651): Multi-sentence list items split into: first sentence (with bullet prefix) + bare continuation sentences (no prefix, no indentation).

5. **Same pattern for blockquotes** (line 652–659): Each sentence gets `> ` prefix, creating one blockquote line per sentence.

## Function/Line Map

| Function                         | File                          | Lines   | Role                                                                                                  |
| -------------------------------- | ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `splitIntoSentences()`           | `webSearchResultFormatter.ts` | 464–517 | Deterministic sentence splitter. Works correctly.                                                     |
| `splitIntoBlocks()`              | `webSearchResultFormatter.ts` | 553–605 | Groups markdown into typed blocks. Works correctly.                                                   |
| `blockTypeOf()`                  | `webSearchResultFormatter.ts` | 519–527 | Classifies line type. Works correctly.                                                                |
| `renderBlock()`                  | `webSearchResultFormatter.ts` | 621–668 | **CHOPPY SOURCE** — splits prose/list/quote blocks sentence-by-sentence into independent RenderUnits. |
| `renderCited()`                  | `webSearchResultFormatter.ts` | 853–858 | Appends `[N-M]` to a unit. Works correctly in isolation.                                              |
| `formatDocument()` emission loop | `webSearchResultFormatter.ts` | 871–887 | Appends `\n` after every unit — no paragraph grouping.                                                |
| `RenderUnit` interface           | `webSearchResultFormatter.ts` | 610–616 | No field for paragraph membership or multi-sentence grouping.                                         |

## Severity Assessment

| Issue                                                    | Severity          | Impact                                                                                   |
| -------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| Prose paragraphs split to one-sentence-per-line          | **Medium**        | Choppy, harder to read; LLM consumers still parse it but human-adjacent tooling degrades |
| List continuation sentences lose bullet prefix           | **Medium-High**   | Visual fragmentation; continuation lines float as orphaned prose                         |
| Blockquote sentences split to separate `>` lines         | **Low**           | Acceptable markdown semantics; minor readability loss                                    |
| Budget/citation math unchanged if fix is paragraph-level | **Informational** | Must be carefully preserved during any fix                                               |

## Proposed Smallest Behavior Contract

### Contract: Paragraph-Inline Citations

1. **Sentence-level `[N-M]` citations stay inline within their original paragraph.** Each sentence gets its own citation, but sentences in the same paragraph are space-joined, not newline-split.

2. **Paragraph boundaries preserved as `\n\n`.** Different paragraphs (separated by blank lines in input) remain separated by blank lines in output.

3. **Semantic blocks preserved.** Lists keep bullet prefix on the first sentence; continuation sentences are appended inline with space (same bullet scope). Blockquotes keep `> ` prefix with sentences space-joined. Headings remain uncited. Code fences and tables remain atomic.

4. **Budget trimming at sentence boundaries.** When a sentence doesn't fit the per-document budget, it and all subsequent sentences in the paragraph are dropped. Partial paragraphs are never emitted.

5. **Citations remain contiguous.** No gaps in `[N-M]` numbering even when sentences are dropped by budget or prose cap.

### Minimal Implementation Sketch

**Step A: Extend `RenderUnit`**

```ts
interface RenderUnit {
  text: string;
  prose: boolean;
  citation: 'own-line' | 'inline' | 'none';
  /** Pre-split sentences for paragraph-inline rendering. When present,
   *  the emit function joins them with space and inserts citations inline,
   *  instead of emitting each on its own line. */
  paragraphSentences?: string[];
}
```

**Step B: Modify `renderBlock()` prose branch (lines 660–664)**

```ts
} else {
  // prose paragraph
  const sentences = splitIntoSentences(text);
  if (sentences.length > 0) {
    units.push({
      text: sentences.join(' '),
      prose: true,
      citation: 'inline',
      paragraphSentences: sentences,
    });
  }
}
```

**Step C: Modify emission loop (lines 879–886)**

```ts
if (unit.paragraphSentences && unit.paragraphSentences.length > 0) {
  // Buffer the whole paragraph transactionally: build the candidate text and
  // provisional citation/prose counters, then commit only if every sentence
  // fits the document budget. On overflow the entire paragraph is discarded —
  // no partial paraText is emitted and no counters advance.
  let paraText = '';
  let paraProse = 0;
  let paraM = 0;
  let fits = true;
  for (const s of unit.paragraphSentences) {
    if (unit.prose && proseCount + paraProse >= maxBodyProse) {
      fits = false;
      break;
    }
    const next = m + paraM + 1;
    const cite = ` [${docIndex}-${next}]`;
    // Include the paragraph separator (\n\n) in the budget so a committed
    // paragraph never overflows once the blank line is appended.
    if (utf8Length(text + paraText + s + cite + '\n\n') > docContentBudget) {
      fits = false;
      break;
    }
    paraText += s + cite + ' ';
    paraM++;
    if (unit.prose) paraProse++;
  }
  if (fits && paraText.length > 0) {
    // Commit atomically: advance the real counters and append the paragraph
    // with a blank-line separator between paragraphs.
    m += paraM;
    if (unit.prose) proseCount += paraProse;
    text = text + paraText.trim() + '\n\n';
  } else if (paraText.length > 0) {
    truncated = true;
  }
}
```

Apply the same pattern to list (lines 636–651) and blockquote (lines 652–659) branches.

## Regression Tests Likely Needed

| Test                                                           | What it validates                  | Risk of collision                                                                                                                                 |
| -------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-sentence prose paragraph renders inline                  | Core behavior change               | **HIGH** — all existing sentence-citation assertions like `assert.match(md, /Sentence\. \[1-1\]/)` may need regex update if output format changes |
| Two-paragraph prose renders with `\n\n` separator              | Paragraph boundary                 | **MEDIUM** — new test, no collision                                                                                                               |
| Multi-sentence list item retains bullet scope                  | List continuation inline           | **HIGH** — test at line 674 explicitly asserts bare continuation `Second sentence. [1-2]`                                                         |
| Budget trimming stops mid-paragraph at sentence boundary       | Sentence-level truncation          | **HIGH** — test at line 421 (`documentBudgetBytes: 150`) asserts per-sentence drop                                                                |
| `MAX_SNIPPET_PROSE_SENTENCES` cap works with inline paragraphs | Prose cap                          | **MEDIUM** — test at line 823 caps at 6 sentences; logic must still count sentences                                                               |
| AI summary sentences inline after body                         | Summary + body citation continuity | **MEDIUM** — tests at lines 529, 1052 assert per-sentence citation numbers                                                                        |
| Citation contiguity when body unit dropped by byte budget      | No phantom citations               | **MEDIUM** — test at line 1119 asserts `[1-2]` follows `[1-1]` after body drop                                                                    |
| Blockquote stays as blockquote                                 | Minor semantic                     | **LOW** — test at line 812 asserts `> ` prefix per sentence                                                                                       |

## Collision Risks

1. **Existing test expectations** — 6+ tests explicitly assert one-sentence-per-line output with individual citations. These tests define the _current_ behavior and would become regression guards against the _new_ behavior. They must be updated simultaneously.

2. **Budget math** — Paragraph-inline rendering packs more text per line, changing when `\n` + truncation note overflows. Byte budget assertions (tests at lines 421, 430, 567, 581, 593, 755) may need tolerance adjustments.

3. **`proseCount` cap logic** — Currently increments per RenderUnit. With paragraph-level units, must count sentences within the paragraph, not the unit itself.

4. **Summary rendering** — AI summary paragraphs go through the same `renderBlock` → emission path. The fix must apply uniformly or summaries will remain choppy while body prose is fixed.

5. **List continuation rendering** — The `paragraphSentences` approach for lists needs the first sentence to carry the bullet prefix and subsequent sentences to be bare. This requires different handling than plain prose.

## Acceptance Status

**2026-08-13** — `node --import tsx/esm --test test/webSearchResultFormatter.test.ts` → **116 tests, 116 pass, 0 fail** (the formatter suite only; this diagnosis targets the formatter's paragraph emission path).
