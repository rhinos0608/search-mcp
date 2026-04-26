import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJobLinksFromHtml } from '../src/rag/adapters/job.js';

// ── extractJobLinksFromHtml ───────────────────────────────────────────────────

test('extracts SEEK job links from a search result page', () => {
  const html = `
    <a href="/job/91431086">Software Engineer</a>
    <a href="/job/91431087">Data Entry Clerk</a>
    <a href="/company/acme">ACME Corp</a>
  `;
  const links = extractJobLinksFromHtml(html, 'https://www.seek.com.au/data-entry-jobs');
  assert.equal(links.length, 2);
  assert.ok(links[0]?.includes('/job/91431086'));
  assert.ok(links[1]?.includes('/job/91431087'));
});

test('extracts Indeed job links via jk param', () => {
  const html = '<a href="/viewjob?jk=abc123def456">Data Entry</a>';
  const links = extractJobLinksFromHtml(html, 'https://au.indeed.com/jobs?q=data+entry');
  assert.equal(links.length, 1);
  assert.ok(links[0]?.includes('jk=abc123def456'));
});

test('extracts LinkedIn job links', () => {
  const html = '<a href="/jobs/view/1234567890/">Software Engineer</a>';
  const links = extractJobLinksFromHtml(html, 'https://www.linkedin.com/jobs');
  assert.equal(links.length, 1);
  assert.ok(links[0]?.includes('/jobs/view/'));
});

test('extracts Jora job links', () => {
  const html = '<a href="/job/12345-software-engineer">Software Engineer</a>';
  const links = extractJobLinksFromHtml(html, 'https://www.jora.com/jobs');
  assert.equal(links.length, 1);
  assert.ok(links[0]?.includes('/job/'));
});

test('ignores cross-domain links', () => {
  const html = '<a href="https://other.com/job/123">Cross-domain</a>';
  const links = extractJobLinksFromHtml(html, 'https://www.seek.com.au/jobs');
  assert.equal(links.length, 0);
});

test('deduplicates identical links', () => {
  const html = `
    <a href="/job/12345">Job A</a>
    <a href="/job/12345">Job A again</a>
  `;
  const links = extractJobLinksFromHtml(html, 'https://www.seek.com.au/jobs');
  assert.equal(links.length, 1);
});

test('resolves relative URLs against base', () => {
  const html = '<a href="/../job/999">Relative</a>';
  const links = extractJobLinksFromHtml(html, 'https://www.seek.com.au/jobs');
  assert.equal(links.length, 1);
  assert.ok(links[0]?.startsWith('https://www.seek.com.au/job/999'));
});

test('returns empty array for invalid base URL', () => {
  const links = extractJobLinksFromHtml('<a href="/job/1">X</a>', 'not-a-url');
  assert.equal(links.length, 0);
});

test('handles empty HTML gracefully', () => {
  const links = extractJobLinksFromHtml('', 'https://www.seek.com.au/jobs');
  assert.equal(links.length, 0);
});

test('handles pages with no matching job links', () => {
  const html = '<p>No jobs here</p>';
  const links = extractJobLinksFromHtml(html, 'https://www.seek.com.au/jobs');
  assert.equal(links.length, 0);
});

test('preserves query params in resolved URLs', () => {
  const html = '<a href="/viewjob?jk=abc123&from=web">Job</a>';
  const links = extractJobLinksFromHtml(html, 'https://au.indeed.com/jobs?q=dev');
  assert.equal(links.length, 1);
  assert.ok(links[0]?.includes('jk=abc123'));
});
