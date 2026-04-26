import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSections,
  extractCitations,
  extractEquations,
  extractFigures,
  createAcademicAdapter,
  academicResultToRawDocument,
} from '../src/rag/adapters/academic.js';

// ── detectSections ───────────────────────────────────────────────────────────

test('detectSections finds standard paper sections', () => {
  const content = `Abstract\nThis is the abstract.\n\nIntroduction\nWe present...\n\nMethod\nOur approach...\n\nResults\nThe results show...\n\nDiscussion\nIn conclusion...\n\nReferences\n[1] Smith et al.`;

  const sections = detectSections(content);
  const types = sections.map((s) => s.type);
  assert.ok(types.includes('abstract'));
  assert.ok(types.includes('introduction'));
  assert.ok(types.includes('method'));
  assert.ok(types.includes('results'));
  assert.ok(types.includes('discussion'));
  assert.ok(types.includes('references'));
});

test('detectSections handles numbered sections', () => {
  const content = `1 Introduction\nWe present...\n\n2 Related Work\nPrior art...\n\n3 Method\nOur approach...`;
  const sections = detectSections(content);
  assert.equal(sections.length, 3);
  assert.equal(sections[0]!.type, 'introduction');
  assert.equal(sections[1]!.type, 'related');
});

// ── extractCitations ─────────────────────────────────────────────────────────

test('extractCitations extracts bracket citations', () => {
  const text = 'As shown in [1, 2, 3], and later [4-6].';
  const citations = extractCitations(text);
  assert.ok(citations.length >= 2);
});

test('extractCitations extracts author-year citations', () => {
  const text = 'Smith et al. (2023) demonstrated this.';
  const citations = extractCitations(text);
  assert.ok(citations.some((c) => c.includes('Smith')));
});

test('extractCitations deduplicates', () => {
  const text = '[1] [1] [1]';
  const citations = extractCitations(text);
  assert.equal(citations.length, 1);
});

// ── extractEquations ─────────────────────────────────────────────────────────

test('extractEquations extracts inline math', () => {
  const text = 'Let $x = y + z$ and $a = b$.';
  const equations = extractEquations(text);
  assert.ok(equations.length >= 1);
  assert.ok(equations.some((e) => e.includes('x = y')));
});

test('extractEquations extracts equation environments', () => {
  const text = '\\begin{equation}\\sum_{i=0}^{n} i\\end{equation}';
  const equations = extractEquations(text);
  assert.ok(equations.length >= 1);
});

// ── extractFigures ───────────────────────────────────────────────────────────

test('extractFigures extracts figure descriptions', () => {
  const text = 'Figure 1: Our architecture.\n\nFigure 2: Results plot.';
  const figures = extractFigures(text);
  assert.ok(figures.length >= 1);
});

// ── createAcademicAdapter ────────────────────────────────────────────────────

const mockPaper = {
  paperId: 'abc123',
  title: 'Attention Is All You Need',
  authors: ['Vaswani', 'Shazeer', 'Parmar'],
  abstract: 'We propose a new simple network architecture, the Transformer.',
  venue: 'NeurIPS',
  year: 2017,
  doi: '10.5555/abc',
  arxivId: '1706.03762',
  url: 'https://arxiv.org/abs/1706.03762',
};

const mockFullText = `Abstract
We propose a new simple network architecture, the Transformer.

Introduction
In this work we aim to solve sequence transduction problems using neural networks.

Method
Our model uses self-attention mechanisms to process sequences in parallel.

Results
We achieve state-of-the-art results on multiple benchmarks and datasets.

Discussion
The Transformer is fast, accurate, and generalizes well to many tasks.

References
[1] Vaswani et al. Attention Is All You Need.`;

test('chunk creates chunks from academic documents', () => {
  const adapter = createAcademicAdapter();
  const doc = academicResultToRawDocument(mockPaper, mockFullText);
  const chunks = adapter.chunk([doc]);

  assert.ok(chunks.length > 0);
  const abstractChunk = chunks.find((c) => c.section === 'abstract');
  assert.ok(abstractChunk);
  assert.equal(abstractChunk!.title, 'Attention Is All You Need');
  assert.equal(abstractChunk!.authors.length, 3);
});

test('chunk detects all major sections', () => {
  const adapter = createAcademicAdapter();
  const doc = academicResultToRawDocument(mockPaper, mockFullText);
  const chunks = adapter.chunk([doc]);

  const sections = [...new Set(chunks.map((c) => c.section))];
  assert.ok(sections.includes('abstract'));
  assert.ok(sections.includes('introduction'));
  assert.ok(sections.includes('method'));
  assert.ok(sections.includes('results'));
});

test('chunk extracts citations from text', () => {
  const adapter = createAcademicAdapter();
  const doc = academicResultToRawDocument(mockPaper, mockFullText);
  const chunks = adapter.chunk([doc]);

  const refChunk = chunks.find((c) => c.section === 'references');
  assert.ok(refChunk);
  assert.ok(refChunk!.citations.length > 0);
});

test('buildAbstractChunk creates abstract chunk', () => {
  const adapter = createAcademicAdapter();
  const chunk = adapter.buildAbstractChunk(mockPaper);
  assert.equal(chunk.section, 'abstract');
  assert.equal(chunk.paperId, 'abc123');
  assert.equal(chunk.year, 2017);
});

test('buildSectionChunk creates section chunks', () => {
  const adapter = createAcademicAdapter();
  const chunks = adapter.buildSectionChunk(mockPaper, {
    type: 'method',
    content: 'Our model uses self-attention. It is based on multi-head attention mechanism.',
  });
  assert.ok(chunks.length > 0);
  assert.equal(chunks[0]!.section, 'method');
});

test('academicResultToRawDocument builds document', () => {
  const doc = academicResultToRawDocument(mockPaper);
  assert.equal(doc.adapter, 'academic');
  assert.equal(doc.title, 'Attention Is All You Need');
  assert.equal(
    ((doc.metadata as Record<string, unknown>)['paper'] as { paperId: string }).paperId,
    'abc123',
  );
});
