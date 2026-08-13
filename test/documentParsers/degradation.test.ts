import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePdf } from '../../src/utils/documentParsers/pdf.js';
import { parseOffice } from '../../src/utils/documentParsers/office.js';
import { appendVisualsSection } from '../../src/utils/documentExtraction.js';

// Graceful-degradation tests. These exercise the injected-loader seam so the
// missing-dependency path can be tested deterministically without a real
// pdf-parse/officeparser module or any network access.

test('parsePdf: injected loader resolving to null → empty result, no throw', async () => {
  const doc = await parsePdf(new Uint8Array(0), undefined, {
    loadModule: async () => null,
  });
  assert.equal(doc.markdown, '');
  assert.equal(doc.title, '');
  assert.deepEqual(doc.images, []);
  assert.deepEqual(doc.tables, []);
  assert.ok(
    doc.warnings.some((w) => w.includes('unavailable')),
    'warning should mention unavailable',
  );
});

test('parsePdf: injected loader that throws → empty result, no throw', async () => {
  const doc = await parsePdf(new Uint8Array(0), undefined, {
    loadModule: async () => {
      throw new Error('simulated load failure');
    },
  });
  assert.equal(doc.markdown, '');
  assert.ok(
    doc.warnings.some((w) => w.includes('unavailable')),
    'warning should mention unavailable',
  );
});

test('parseOffice: injected loader resolving to null → empty result, no throw', async () => {
  const doc = await parseOffice(new Uint8Array(0), '.docx', {
    loadModule: async () => null,
  });
  assert.equal(doc.markdown, '');
  assert.equal(doc.title, '');
  assert.deepEqual(doc.images, []);
  assert.deepEqual(doc.tables, []);
  assert.ok(
    doc.warnings.some((w) => w.includes('unavailable')),
    'warning should mention unavailable',
  );
});

test('parseOffice: injected loader that throws → empty result, no throw', async () => {
  const doc = await parseOffice(new Uint8Array(0), '.docx', {
    loadModule: async () => {
      throw new Error('simulated load failure');
    },
  });
  assert.equal(doc.markdown, '');
  assert.ok(
    doc.warnings.some((w) => w.includes('unavailable')),
    'warning should mention unavailable',
  );
});

// ── appendVisualsSection (pure helper) ───────────────────────────────────────

test('appendVisualsSection: non-empty snippets append a Figures & visuals section', () => {
  const out = appendVisualsSection('intro', ['A bar chart.', 'A table.']);
  assert.ok(out.includes('### Figures & visuals'), 'heading should be present');
  assert.ok(out.includes('A bar chart.'), 'first snippet should be present');
  assert.ok(out.includes('A table.'), 'second snippet should be present');
});

test('appendVisualsSection: empty snippets return markdown unchanged', () => {
  const md = 'intro only';
  assert.equal(appendVisualsSection(md, []), md);
});
