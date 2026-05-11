/**
 * Tests for GitHub-specific content cleanup.
 * TDD: Write tests that fail before implementing GitHub nav stripping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMarkdownContent } from '../src/utils/contentCleanup.js';

// ── GitHub navigation patterns ────────────────────────────────────────────

test('cleanMarkdownContent: strips GitHub Navigation Menu heading', () => {
  const input = `## Navigation Menu
Toggle navigation
Appearance settings
  * Platform
    * [ Actions ](https://github.com/features/actions)

# Actual Content
This is the README content.`;
  const result = cleanMarkdownContent(input);
  assert.ok(!result.includes('Navigation Menu'), 'should strip Navigation Menu');
  assert.ok(!result.includes('Toggle navigation'), 'should strip toggle nav');
  assert.ok(result.includes('Actual Content'), 'should keep actual content');
});

test('cleanMarkdownContent: strips Skip to content link', () => {
  const input = `[Skip to content](https://github.com#start-of-content)
# README
Content.`;
  const result = cleanMarkdownContent(input);
  assert.ok(!result.includes('Skip to content'), 'should strip skip-to-content link');
  assert.ok(result.includes('README'), 'should keep README heading');
});

test('cleanMarkdownContent: strips GitHub sidebar links (Sign in)', () => {
  const input = `[Sign in](https://github.com/login)
[Sign up](https://github.com/signup)
# README`;
  const result = cleanMarkdownContent(input);
  assert.ok(!result.includes('Sign in'), 'should strip sign in link');
  assert.ok(!result.includes('Sign up'), 'should strip sign up link');
  assert.ok(result.includes('README'), 'should keep content');
});

test('cleanMarkdownContent: strips GitHub footer navigation', () => {
  const input = `# Content
Hello world.

## Footer
### Footer navigation
  * [Terms](https://docs.github.com/terms)
  * [Privacy](https://docs.github.com/privacy)
  * [Security](https://github.com/security)
  * [Status](https://www.githubstatus.com/)
  * [Community](https://github.community/)
  * [Contact](https://support.github.com)
  * Manage cookies
  * Do not share my personal information`;
  const result = cleanMarkdownContent(input);
  assert.ok(!result.includes('Footer navigation'), 'should strip Footer navigation');
  assert.ok(!result.includes('Manage cookies'), 'should strip cookie notice');
  assert.ok(!result.includes('Do not share'), 'should strip privacy notice');
  assert.ok(result.includes('Content'), 'should keep content');
});

test('cleanMarkdownContent: strips GitHub search UI elements', () => {
  const input = `Search or jump to...
Search code, repositories, users, issues, pull requests...
[Search syntax tips](https://docs.github.com/search)
# README
Content.`;
  const result = cleanMarkdownContent(input);
  assert.ok(!result.includes('Search or jump'), 'should strip search UI');
  assert.ok(!result.includes('Search syntax tips'), 'should strip search tip');
  assert.ok(result.includes('README'), 'should keep content');
});

test('cleanMarkdownContent: strips Provide feedback section', () => {
  const input = `# README
Content.

## Provide feedback
We read every piece of feedback.
Include my email address so I can be contacted`;
  const result = cleanMarkdownContent(input);
  assert.ok(!result.includes('Provide feedback'), 'should strip feedback section');
  assert.ok(result.includes('README'), 'should keep content');
});

test('cleanMarkdownContent: strips GitHub Sponsor / Donate patterns', () => {
  const input = `# README

[!["Buy us a coffee"](https://img.shields.io/badge/Donate-Buy%20me%20a%20coffee-orange)](https://buymeacoffee.com)
[!["Sponsor"](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-red)](https://github.com/sponsors)

## Content
Hello world.`;
  const result = cleanMarkdownContent(input);
  assert.ok(!result.includes('Buy us a coffee'), 'should strip donate link');
  assert.ok(!result.includes('buymeacoffee'), 'should strip buy me coffee');
  assert.ok(result.includes('Content'), 'should keep content');
});

test('cleanMarkdownContent: preserves actual README content', () => {
  const input = `# My Project

## Installation
\`\`\`bash
npm install my-package
\`\`\`

## Usage
\`\`\`typescript
import { thing } from 'my-package';
\`\`\`

## API

### thing(options)
Creates a thing with the given options.

| Option | Type | Default |
|--------|------|---------|
| name | string | required |
| port | number | 3000 |

Returns a Thing instance.

## License
MIT
`;
  const result = cleanMarkdownContent(input);
  assert.ok(result.includes('My Project'), 'should keep title');
  assert.ok(result.includes('npm install'), 'should keep code block');
  assert.ok(result.includes('thing(options)'), 'should keep API docs');
  assert.ok(result.includes('| Option |'), 'should keep table');
  assert.ok(result.includes('MIT'), 'should keep license');
});
