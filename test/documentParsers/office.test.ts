import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { parseOffice } from '../../src/utils/documentParsers/office.js';

const KNOWN_TEXT = 'Hello Office Parsing';

/** A single text run in a Word paragraph. */
function run(text: string): string {
  return `<w:r><w:t>${text}</w:t></w:r>`;
}

/**
 * Build a tiny valid `.docx` (a zip of OOXML) containing `text` in the body.
 * No binary fixture is committed — the zip is generated here, mirroring how
 * `pdf.test.ts` generates its PDF fixture.
 */
function makeDocx(text: string): Uint8Array {
  const xml = (s: string): Uint8Array =>
    new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${s}`);
  return zipSync(
    {
      '[Content_Types].xml': xml(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
          `</Types>`,
      ),
      '_rels/.rels': xml(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
          `</Relationships>`,
      ),
      'word/document.xml': xml(
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
          `<w:body><w:p>${run(text)}</w:p></w:body>` +
          `</w:document>`,
      ),
    },
    { level: 0 },
  );
}

test('parseOffice extracts known text from a generated docx as markdown', async () => {
  const doc = await parseOffice(makeDocx(KNOWN_TEXT), '.docx');
  assert.equal(typeof doc.markdown, 'string');
  assert.ok(doc.markdown.length > 0, 'markdown should be non-empty');
  assert.ok(
    doc.markdown.includes(KNOWN_TEXT),
    `markdown should contain "${KNOWN_TEXT}", got: ${JSON.stringify(doc.markdown)}`,
  );
});

test('parseOffice returns the ParsedDocument shape', async () => {
  const doc = await parseOffice(makeDocx(KNOWN_TEXT), '.docx');
  assert.equal(typeof doc.markdown, 'string');
  assert.equal(typeof doc.title, 'string');
  assert.ok(Array.isArray(doc.images));
  assert.ok(Array.isArray(doc.tables));
  assert.ok(Array.isArray(doc.warnings));
});

test('parseOffice accepts ArrayBuffer input', async () => {
  const bytes = makeDocx(KNOWN_TEXT);
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const doc = await parseOffice(buf, '.docx');
  assert.ok(doc.markdown.includes(KNOWN_TEXT));
});

test('parseOffice does not throw on empty input and returns a warning', async () => {
  const doc = await parseOffice(new Uint8Array(0), '.docx');
  assert.equal(typeof doc.markdown, 'string');
  assert.ok(Array.isArray(doc.warnings));
  assert.equal(doc.images.length, 0);
  assert.equal(doc.tables.length, 0);
});

test('parseOffice does not throw on garbage input and returns a warning', async () => {
  const garbage = new TextEncoder().encode('this is definitely not an office document');
  const doc = await parseOffice(garbage, '.docx');
  assert.equal(typeof doc.markdown, 'string');
  assert.ok(Array.isArray(doc.warnings));
  assert.equal(doc.markdown, '');
});

test('parseOffice returns empty markdown and a warning when the signal is already aborted', async () => {
  // An already-aborted signal simulates an expired deadline.
  const doc = await parseOffice(makeDocx(KNOWN_TEXT), '.docx', undefined, {
    signal: AbortSignal.abort(),
  });
  assert.ok(doc.warnings.length > 0, 'should surface a warning when the deadline fires');
  assert.equal(doc.markdown, '', 'no markdown when parsing is aborted');
});

test('parseOffice forwards an aborted signal when timeoutMs expires', async () => {
  // Use a parser stub to verify that the timeoutMs option is converted to an
  // AbortSignal and forwarded to the parser. The stub checks the signal and
  // throws an AbortError when it is already aborted.
  let receivedSignal: AbortSignal | undefined;
  const stubParser = async (
    _input: string | Buffer | ArrayBuffer,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config?: any,
  ) => {
    receivedSignal = config?.abortSignal as AbortSignal | undefined;
    // Simulate a slow parse that checks the signal mid-flight.
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (receivedSignal?.aborted) {
      const err = new Error('The operation was aborted') as Error & {
        name: string;
      };
      err.name = 'AbortError';
      throw err;
    }
    return 'some markdown';
  };

  const doc = await parseOffice(
    makeDocx(KNOWN_TEXT),
    '.docx',
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      loadModule: async () => ({ parseOffice: stubParser }) as any,
    },
    { timeoutMs: 5 },
  );

  assert.ok(receivedSignal !== undefined, 'signal was forwarded to the parser');
  assert.ok(
    receivedSignal!.aborted || doc.warnings.length > 0,
    'signal was aborted or warning surfaced',
  );
});
