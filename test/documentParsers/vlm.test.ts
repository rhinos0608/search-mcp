import test from 'node:test';
import assert from 'node:assert/strict';
import { describeVisuals } from '../../src/utils/documentParsers/vlm.js';
import { loadConfig, type SearchConfig } from '../../src/config.js';
import type { ParsedDocument } from '../../src/utils/documentParsers/types.js';

/** A minimal valid PNG header (magic bytes) — enough for base64 data-URL encoding. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function makeDoc(images: ParsedDocument['images']): ParsedDocument {
  return { markdown: 'hello', title: '', images, tables: [], warnings: [] };
}

/** Build a config clone with multimodal + llm forced to the given values. */
function configWith(opts: {
  multimodal: boolean;
  baseUrl?: string;
  provider?: string;
}): SearchConfig {
  const base = loadConfig();
  return {
    ...base,
    documentParsing: { ...base.documentParsing, multimodal: opts.multimodal },
    llm: {
      ...base.llm,
      baseUrl: opts.baseUrl ?? '',
      provider: opts.provider ?? '',
    },
  };
}

/** Mock global fetch to count calls and return a canned chat completion. */
function mockFetch(respond: (body: unknown) => Response): {
  calls: number;
  bodies: unknown[];
  restore: () => void;
} {
  const state = { calls: 0, bodies: [] as unknown[] };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    state.calls += 1;
    if (init?.body) state.bodies.push(JSON.parse(String(init.body)));
    return respond(input);
  }) as typeof fetch;
  // Return the live state object (not a spread copy) so `calls`/`bodies` stay
  // in sync with the closure the mock increments.
  return Object.assign(state, { restore: () => (globalThis.fetch = original) });
}

test('multimodal:false → describeVisuals returns empty outcome with zero LLM calls', async () => {
  const cfg = configWith({
    multimodal: false,
    baseUrl: 'http://localhost:9999',
    provider: 'gpt-4o',
  });
  const mock = mockFetch(() => new Response('{}', { status: 200 }));
  try {
    const result = await describeVisuals(
      makeDoc([{ data: PNG_BYTES, mime: 'image/png', page: 1 }]),
      new Uint8Array(0),
      cfg,
    );
    assert.equal(result.warning, undefined, 'no warning when multimodal is off');
    assert.deepEqual(result, { snippets: [] });
    assert.equal(mock.calls, 0, 'multimodal:false must not call the LLM');
  } finally {
    mock.restore();
  }
});

test('llm.baseUrl empty → describeVisuals returns empty outcome with zero calls even if multimodal true', async () => {
  const cfg = configWith({ multimodal: true, baseUrl: '', provider: 'gpt-4o' });
  const mock = mockFetch(() => new Response('{}', { status: 200 }));
  try {
    const result = await describeVisuals(
      makeDoc([{ data: PNG_BYTES, mime: 'image/png', page: 1 }]),
      new Uint8Array(0),
      cfg,
    );
    assert.deepEqual(result, { snippets: [] });
    assert.equal(mock.calls, 0, 'unconfigured LLM must not be called');
  } finally {
    mock.restore();
  }
});

test('multimodal true + configured llm + one image → returns a non-empty markdown snippet', async () => {
  const cfg = configWith({
    multimodal: true,
    baseUrl: 'http://localhost:9999',
    provider: 'gpt-4o',
  });
  const mock = mockFetch(
    () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'A bar chart showing quarterly revenue growth.' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  try {
    const result = await describeVisuals(
      makeDoc([{ data: PNG_BYTES, mime: 'image/png', page: 1 }]),
      new Uint8Array(0), // garbage bytes → rasterizePages returns [] (no extra visuals)
      cfg,
    );
    assert.ok(Array.isArray(result.snippets));
    assert.ok(result.snippets.length > 0, 'expected at least one snippet');
    assert.ok(
      result.snippets[0]!.includes('bar chart'),
      'snippet should contain the mocked description',
    );
    assert.equal(mock.calls, 1, 'exactly one LLM call for one image');
    // The request body must carry an image_url data-URL part.
    const body = mock.bodies[0] as { messages: { content: unknown[] }[] };
    const parts = body.messages[0]!.content as { type: string; image_url?: { url: string } }[];
    const imagePart = parts.find((p) => p.type === 'image_url');
    assert.ok(imagePart, 'request must include an image_url part');
    assert.ok(
      imagePart!.image_url!.url.startsWith('data:image/png;base64,'),
      'image_url must be a base64 data URL',
    );
  } finally {
    mock.restore();
  }
});

test('graceful degradation: no images + garbage pdf → no throw, returns empty outcome', async () => {
  const cfg = configWith({
    multimodal: true,
    baseUrl: 'http://localhost:9999',
    provider: 'gpt-4o',
  });
  const mock = mockFetch(() => new Response('{}', { status: 200 }));
  try {
    const result = await describeVisuals(
      makeDoc([]),
      new TextEncoder().encode('this is definitely not a pdf'),
      cfg,
    );
    assert.deepEqual(result.snippets, []);
    assert.equal(mock.calls, 0, 'no visuals → no LLM call');
  } finally {
    mock.restore();
  }
});

// REGRESSION (Task 11): an embedded image larger than the per-visual budget is
// excluded during collection and never reaches describeOne (zero LLM calls).
test('oversized embedded image is excluded and never passed to describeOne', async () => {
  const cfg = configWith({
    multimodal: true,
    baseUrl: 'http://localhost:9999',
    provider: 'gpt-4o',
  });
  const mock = mockFetch(
    () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'should not be reached' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  try {
    const oversized = new Uint8Array(5 * 1024 * 1024).fill(0x89); // > MAX_VISUAL_BYTES
    const result = await describeVisuals(
      makeDoc([{ data: oversized, mime: 'image/png', page: 1 }]),
      new Uint8Array(0),
      cfg,
    );
    assert.deepEqual(
      result.snippets,
      [],
      'oversized image must be excluded before reaching describeOne',
    );
    assert.equal(mock.calls, 0, 'excluded oversized image must not trigger an LLM call');
  } finally {
    mock.restore();
  }
});
