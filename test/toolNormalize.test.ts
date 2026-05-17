/**
 * Tests for shared input normalization helpers (src/tools/normalize.ts).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/v4';

import {
  emptyStringToUndefined,
  nullishOrEmptyToUndefined,
  optionalTrimmedString,
  resolveLimit,
  resolveGitHubRepoLocator,
} from '../src/tools/normalize.js';

// ── emptyStringToUndefined ──────────────────────────────────────────────────

test('emptyStringToUndefined converts empty string to undefined', () => {
  assert.equal(emptyStringToUndefined(''), undefined);
});

test('emptyStringToUndefined passes through non-empty string', () => {
  assert.equal(emptyStringToUndefined('hello'), 'hello');
});

test('emptyStringToUndefined passes through null', () => {
  assert.equal(emptyStringToUndefined(null), null);
});

test('emptyStringToUndefined passes through number', () => {
  assert.equal(emptyStringToUndefined(0), 0);
});

test('emptyStringToUndefined passes through undefined', () => {
  assert.equal(emptyStringToUndefined(undefined), undefined);
});

// ── nullishOrEmptyToUndefined ──────────────────────────────────────────────

test('nullishOrEmptyToUndefined converts null to undefined', () => {
  assert.equal(nullishOrEmptyToUndefined(null), undefined);
});

test('nullishOrEmptyToUndefined converts empty string to undefined', () => {
  assert.equal(nullishOrEmptyToUndefined(''), undefined);
});

test('nullishOrEmptyToUndefined passes through non-empty string', () => {
  assert.equal(nullishOrEmptyToUndefined('hello'), 'hello');
});

// ── optionalTrimmedString ──────────────────────────────────────────────────

test('optionalTrimmedString without schema treats empty string as undefined', () => {
  const schema = optionalTrimmedString();
  assert.equal(schema.parse(''), undefined);
  assert.equal(schema.parse(null), undefined);
  assert.equal(schema.parse('hello'), 'hello');
  assert.equal(schema.parse(undefined), undefined);
});

test('optionalTrimmedString with enum schema treats empty string as undefined and default works', () => {
  const schema = optionalTrimmedString(z.enum(['a', 'b'])).default('a');
  assert.equal(schema.parse(''), 'a');
  assert.equal(schema.parse(undefined), 'a');
  assert.equal(schema.parse('b'), 'b');
});

// ── resolveLimit ──────────────────────────────────────────────────────────

test('resolveLimit returns the first matching alias value', () => {
  const result = resolveLimit({ limit: 50, commentLimit: 100 }, ['limit', 'commentLimit'], 25);
  assert.equal(result, 50);
});

test('resolveLimit falls back to aliases in order', () => {
  const result = resolveLimit({ maxResults: 75 }, ['limit', 'commentLimit', 'maxResults'], 25);
  assert.equal(result, 75);
});

test('resolveLimit returns default when no alias matches', () => {
  const result = resolveLimit({}, ['limit', 'commentLimit'], 25);
  assert.equal(result, 25);
});

test('resolveLimit ignores non-number values', () => {
  const result = resolveLimit({ limit: '50' }, ['limit'], 25);
  assert.equal(result, 25);
});

test('resolveLimit ignores Infinity', () => {
  const result = resolveLimit({ limit: Infinity }, ['limit'], 25);
  assert.equal(result, 25);
});

// ── resolveGitHubRepoLocator ──────────────────────────────────────────────

test('resolveGitHubRepoLocator parses owner/repo string', () => {
  const loc = resolveGitHubRepoLocator('owner/repo');
  assert.deepEqual(loc, { owner: 'owner', repo: 'repo' });
});

test('resolveGitHubRepoLocator parses owner/repo with hyphens and dots', () => {
  const loc = resolveGitHubRepoLocator('my-org/my.repo');
  assert.deepEqual(loc, { owner: 'my-org', repo: 'my.repo' });
});

test('resolveGitHubRepoLocator parses full GitHub URL', () => {
  const loc = resolveGitHubRepoLocator('https://github.com/owner/repo');
  assert.deepEqual(loc, { owner: 'owner', repo: 'repo' });
});

test('resolveGitHubRepoLocator parses GitHub URL with trailing path', () => {
  const loc = resolveGitHubRepoLocator('https://github.com/owner/repo/tree/main/src');
  assert.deepEqual(loc, { owner: 'owner', repo: 'repo' });
});

test('resolveGitHubRepoLocator parses GitHub URL with .git', () => {
  const loc = resolveGitHubRepoLocator('https://github.com/owner/repo.git');
  assert.deepEqual(loc, { owner: 'owner', repo: 'repo' });
});

test('resolveGitHubRepoLocator parses http github URL', () => {
  const loc = resolveGitHubRepoLocator('http://github.com/owner/repo');
  assert.deepEqual(loc, { owner: 'owner', repo: 'repo' });
});

test('resolveGitHubRepoLocator parses github.com without protocol', () => {
  const loc = resolveGitHubRepoLocator('github.com/owner/repo');
  assert.deepEqual(loc, { owner: 'owner', repo: 'repo' });
});

test('resolveGitHubRepoLocator parses github URL with www', () => {
  const loc = resolveGitHubRepoLocator('https://www.github.com/owner/repo');
  assert.deepEqual(loc, { owner: 'owner', repo: 'repo' });
});

test('resolveGitHubRepoLocator parses object form', () => {
  const loc = resolveGitHubRepoLocator({ owner: 'owner', repo: 'repo' });
  assert.deepEqual(loc, { owner: 'owner', repo: 'repo' });
});

test('resolveGitHubRepoLocator returns null for undefined input', () => {
  assert.equal(resolveGitHubRepoLocator(undefined), null);
});

test('resolveGitHubRepoLocator returns null for empty string', () => {
  assert.equal(resolveGitHubRepoLocator(''), null);
});

test('resolveGitHubRepoLocator returns null for invalid string', () => {
  assert.equal(resolveGitHubRepoLocator('not-a-repo'), null);
});

test('resolveGitHubRepoLocator returns null for object with missing repo', () => {
  assert.equal(resolveGitHubRepoLocator({ owner: 'owner' }), null);
});
