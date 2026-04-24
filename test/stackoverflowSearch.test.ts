import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { stackoverflowSearch } from '../src/tools/stackoverflowSearch.js';
import { MAX_ELEMENTS } from '../src/utils/htmlElements.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function buildMockResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
  });
}

test('stackoverflowSearch spreads finalized HTML structured content', async () => {
  const paragraphs = Array.from(
    { length: MAX_ELEMENTS + 5 },
    (_, i) => `<p>Paragraph ${i}</p>`,
  ).join('');
  const body = `${paragraphs}<h2>Late heading</h2><table><tr><th>A</th></tr><tr><td>B</td></tr></table>`;

  globalThis.fetch = async () =>
    buildMockResponse({
      items: [
        {
          question_id: 123,
          title: 'How do I test finalized elements?',
          body,
          link: 'https://stackoverflow.com/q/123',
          score: 5,
          answer_count: 1,
          is_answered: true,
          tags: ['typescript'],
          creation_date: 1_700_000_000,
          owner: { display_name: 'Ada' },
          view_count: 10,
        },
      ],
    });

  const [question] = await stackoverflowSearch('finalized elements unique stackoverflow test', '');

  assert.ok(question);
  assert.equal(question.elements?.length, MAX_ELEMENTS);
  assert.equal(question.truncatedElements, true);
  assert.ok((question.originalElementCount ?? 0) > MAX_ELEMENTS);
  assert.ok((question.omittedElementCount ?? 0) > 0);
  assert.ok(
    question.elements?.some(
      (element) => element.type === 'heading' && element.text === 'Late heading',
    ),
  );
  assert.ok(question.elements?.some((element) => element.type === 'table'));
});
