import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePdf } from '../../src/utils/documentParsers/pdf.js';

const KNOWN_TEXT = 'Hello Document Parsing';

/**
 * Build a tiny valid, born-digital single-page PDF containing `text` in
 * Helvetica. No binary fixture is committed — the PDF is generated here.
 */
function makePdf(text: string): Uint8Array {
  const content = `BT\n/F1 18 Tf\n72 720 Td\n(${text}) Tj\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test('parsePdf extracts known text from a generated PDF as markdown', async () => {
  const doc = await parsePdf(makePdf(KNOWN_TEXT));
  assert.equal(typeof doc.markdown, 'string');
  assert.ok(doc.markdown.length > 0, 'markdown should be non-empty');
  assert.ok(doc.markdown.includes(KNOWN_TEXT), `markdown should contain "${KNOWN_TEXT}"`);
  assert.ok(doc.markdown.includes('Parsing'), 'markdown should preserve word boundaries');
});

test('parsePdf returns the ParsedDocument shape', async () => {
  const doc = await parsePdf(makePdf(KNOWN_TEXT));
  assert.equal(typeof doc.markdown, 'string');
  assert.equal(typeof doc.title, 'string');
  assert.ok(Array.isArray(doc.images));
  assert.ok(Array.isArray(doc.tables));
  assert.ok(Array.isArray(doc.warnings));
});

test('parsePdf accepts both ArrayBuffer and Uint8Array input', async () => {
  const bytes = makePdf(KNOWN_TEXT);
  const fromBuffer = await parsePdf(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  assert.ok(fromBuffer.markdown.includes(KNOWN_TEXT));
});

test('parsePdf does not throw on empty input and returns a warning', async () => {
  const doc = await parsePdf(new Uint8Array(0));
  assert.equal(typeof doc.markdown, 'string');
  assert.ok(Array.isArray(doc.warnings));
  assert.equal(doc.images.length, 0);
  assert.equal(doc.tables.length, 0);
});

test('parsePdf does not throw on garbage input and returns a warning', async () => {
  const garbage = new TextEncoder().encode('this is definitely not a pdf document');
  const doc = await parsePdf(garbage);
  assert.equal(typeof doc.markdown, 'string');
  assert.ok(Array.isArray(doc.warnings));
  assert.equal(doc.markdown, '');
});

test('parsePdf honors the maxPages option without throwing', async () => {
  const doc = await parsePdf(makePdf(KNOWN_TEXT), { maxPages: 1 });
  assert.ok(doc.markdown.includes(KNOWN_TEXT));
});
