/**
 * Tests for render recovery quality assessment.
 * Covers all 9 boilerplate families, scoring model, recovery routing,
 * platform hints, and false-positive guards.
 */
import test from 'node:test';
import assert from "node:assert/strict";
import { assessMarkdownQuality, assessMarkdownBatchQuality } from "../src/utils/renderRecovery.js";
// ── Helpers ────────────────────────────────────────────────────────────────

function makeGitHubNavPage(): string {
  return `[Skip to content](https://github.com/punkpeye/awesome-mcp-servers#start-of-content)
## Navigation Menu
Toggle navigation
[ Sign in ](https://github.com/login)
Appearance settings
  * Platform
    * AI CODE CREATION
      * [ GitHub CopilotWrite better code with AI ](https://github.com/features/copilot)
      * [ GitHub SparkBuild and deploy intelligent apps ](https://github.com/features/spark)
    * DEVELOPER WORKFLOWS
      * [ ActionsAutomate any workflow ](https://github.com/features/actions)
      * [ CodespacesInstant dev environments ](https://github.com/features/codespaces)
  * Solutions
    * [By size](https://github.com/solutions)
      * [Enterprise](https://github.com/enterprise)
      * [Teams](https://github.com/team)
    * [By industry](https://github.com/solutions/industry)
      * [Healthcare](https://github.com/solutions/industry/healthcare)
      * [Finance](https://github.com/solutions/industry/financial-services)
  * Resources
    * [Blog](https://github.com/blog)
    * [Newsletter](https://github.com/resources/newsletter)
    * [Events](https://github.com/events)
    * [Customer stories](https://github.com/customer-stories)
    * [White papers](https://github.com/resources/whitepapers)
Search or jump to...
Search code, repositories, users, issues, pull requests...
[Search syntax tips](https://docs.github.com/search-github)
## Provide feedback
We read every piece of feedback, and take your input very seriously.
Include my email address so I can be contacted
[Cancel] [Feedback]
## Footer
### Footer navigation
  * [Terms](https://docs.github.com/site-policy/github-terms)
  * [Privacy](https://docs.github.com/site-policy/privacy-policies)
  * [Security](https://github.com/security)
  * [Status](https://www.githubstatus.com/)
  * [Community](https://github.community/)
  * [Docs](https://docs.github.com/)
  * [Contact](https://support.github.com?tags=dotcom-footer)
  * Manage cookies 
  * Do not share my personal information`;
}

function makeLinkDenseNavPage(): string {
  const links = [];
  for (let i = 0; i < 50; i++) {
    links.push(`[Link ${i}](https://example.com/${i}) | [Link ${i}b](https://example.com/${i}b) | [Link ${i}c](https://example.com/${i}c)`);
  }
  return links.join('\n');
}

function makeMeaningfulPage(): string {
  return `# My Technical Article

## Introduction
This is a detailed technical article with paragraphs of meaningful content.
It has multiple sections and real information that users would want to read.

## Methodology
The approach used in this study is based on established research methods.
We analyzed data from multiple sources and validated our findings through peer review.

## Results
Our findings show significant improvement in key metrics:
- Performance increased by 45%
- Memory usage decreased by 30%
- Throughput improved by 2.5x

## Conclusion
This research demonstrates that the proposed approach is viable and effective.
Future work should explore additional optimization opportunities across deployment scenarios.`;
}

function makeMixedNavPage(): string {
  const nav = `[Skip to content](${new Array(30).fill('#').join(',')})
## Navigation Menu
Toggle navigation
  * Platform
    * [ Features ](https://example.com/features) | [ Pricing ](https://example.com/pricing) | [ Docs ](https://example.com/docs) | [ Blog ](https://example.com/blog) | [ Contact ](https://example.com/contact)
  * Products
    * [Product A](https://example.com/a) | [Product B](https://example.com/b) | [Product C](https://example.com/c) | [Enterprise](https://example.com/enterprise)
  * Company
    * [About](https://example.com/about) | [Careers](https://example.com/careers) | [Press](https://example.com/press) | [Partners](https://example.com/partners)
## Footer
  * [Terms](https://example.com/terms) | [Privacy](https://example.com/privacy) | [Sitemap](https://example.com/sitemap) | [Cookie Policy](https://example.com/cookies)`;
  const content = `\n\n# README\n\n## Getting Started\nThis is the actual README content with paragraphs of useful information.\nThe project helps you integrate MCP servers with various AI clients.\n\n## Installation\n\`\`\`bash\nnpm install my-package\n\`\`\`\n\n## Usage\n\`\`\`typescript\nimport { createServer } from 'my-package';\n\nconst server = createServer({ port: 3000 });\nawait server.start();\n\`\`\`\n\n## API Reference\n\n### createServer(options)\nCreates a new MCP server instance with the given options.\n\n### server.start()\nStarts the server and begins listening for connections.\n\n## License\nMIT\n`;
  return nav + content;
}

function makeAuthWallPage(): string {
  return `# Private Repository
You must be logged in to access this content.

Sign in with GitHub
Sign in with Google
Continue with Microsoft

## Sign in
Email address
Password
`
}

function makeJsShellPage(): string {
  return `Please enable JavaScript to view this content.
Loading...
This page requires JavaScript to function.
`;
}

function makeErrorPage(): string {
  return `# 404 Not Found
Not Found
Access Denied

The page you requested could not be found.

[Go Home](https://example.com)
[Contact Support](https://example.com/support)
`;
}

function makeCodeDocPage(): string {
  return `# My API Package

## Installation
\`\`\`bash
npm install my-package
\`\`\`

## Usage
\`\`\`typescript
import { createClient } from 'my-package';

const client = createClient({ apiKey: '...' });
const result = await client.query({ limit: 10 });
console.log(result);
\`\`\`

## API

### createClient(options)
Creates a new client with the given options.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| apiKey | string | required | Your API key |
| baseUrl | string | https://api.example.com | Base URL |

## License
MIT
`;
}

// ── Test: GitHub nav-only page ───────────────────────────────────

test('GitHub nav-only page returns nav_heavy', () => {
  const result = assessMarkdownQuality(makeGitHubNavPage());
  assert.equal(result.meaningful, false);
  assert.equal(result.classification, 'nav_heavy');
  assert.ok(result.reasons.length > 0);
  assert.ok(result.recovery.retryAggressiveRender);
});

// ── Test: Link-dense nav page ─────────────────────────────────────

test('link-dense nav page returns not meaningful', () => {
  const result = assessMarkdownQuality(makeLinkDenseNavPage());
  assert.equal(result.meaningful, false);
  assert.ok(result.reasons.length > 0);
});

// ── Test: Meaningful article page ─────────────────────────────────

test('meaningful article page returns meaningful', () => {
  const result = assessMarkdownQuality(makeMeaningfulPage());
  assert.equal(result.meaningful, true);
  assert.equal(result.classification, 'meaningful');
});

// ── Test: Mixed nav + content page ────────────────────────────────

test('mixed nav + good content returns meaningful', () => {
  const result = assessMarkdownQuality(makeMixedNavPage());
  // The content portion (code blocks, headings with body, long paragraphs)
  // should override the nav boilerplate
  assert.equal(result.meaningful, true);
});

// ── Test: Content with high link density ──────────────────────────

test('high link density page returns not meaningful', () => {
  const linkHeavy = [
    '# Top Resources',
    '[Resource 1](https://example.com/1) - description',
    '[Resource 2](https://example.com/2) - description',
    '[Resource 3](https://example.com/3) - description',
    '[Resource 4](https://example.com/4) - description',
    '[Resource 5](https://example.com/5) - description',
    '[Resource 6](https://example.com/6) - description',
    '[Resource 7](https://example.com/7) - description',
    '[Resource 8](https://example.com/8) - description',
    '[Resource 9](https://example.com/9) - description',
    '[Resource 10](https://example.com/10) - description',
    '## Footer',
    '[Privacy](https://example.com/privacy) | [Terms](https://example.com/terms)',
  ].join('\n');
  const result = assessMarkdownQuality(linkHeavy);
  assert.equal(result.meaningful, false);
});

// ── Test: Auth wall ───────────────────────────────────────────────

test('auth wall page returns auth_wall', () => {
  const result = assessMarkdownQuality(makeAuthWallPage());
  assert.equal(result.meaningful, false);
  assert.equal(result.classification, 'auth_wall');
  assert.ok(result.recovery.stopRetrying);
  assert.equal(result.recovery.retryAggressiveRender, false);
});

// ── Test: JS shell page ───────────────────────────────────────────

test('JS shell page returns js_shell', () => {
  const result = assessMarkdownQuality(makeJsShellPage());
  assert.equal(result.meaningful, false);
  assert.equal(result.classification, 'js_shell');
  assert.ok(result.recovery.retryAggressiveRender);
});

// ── Test: Error page ──────────────────────────────────────────────

test('error page returns error_or_challenge', () => {
  const result = assessMarkdownQuality(makeErrorPage());
  assert.equal(result.meaningful, false);
  assert.equal(result.classification, 'error_or_challenge');
  assert.ok(result.recovery.attemptExternalRecovery);
});

// ── Test: Code/doc page is meaningful ─────────────────────────────

test('code documentation page with blocks/tables is meaningful', () => {
  const result = assessMarkdownQuality(makeCodeDocPage());
  assert.equal(result.meaningful, true);
  assert.equal(result.classification, 'meaningful');
});

// ── Test: Empty content ───────────────────────────────────────────

test('empty content returns too_thin', () => {
  const result = assessMarkdownQuality('');
  assert.equal(result.meaningful, false);
  assert.equal(result.classification, 'too_thin');
});

// ── Test: Placeholder content ─────────────────────────────────────

test('placeholder content returns js_shell', () => {
  const result = assessMarkdownQuality('Loading...');
  assert.equal(result.meaningful, false);
  assert.equal(result.classification, 'js_shell');
});

// ── Test: Recovery recommendation routing ─────────────────────────

test('recovery recommendations are correct per classification', () => {
  // nav_heavy → aggressive render
  const navResult = assessMarkdownQuality(makeGitHubNavPage());
  assert.equal(navResult.recovery.retryAggressiveRender, true);
  assert.equal(navResult.recovery.stopRetrying, false);
  assert.equal(navResult.recovery.attemptExternalRecovery, false);

  // auth_wall → stop retrying
  const authResult = assessMarkdownQuality(makeAuthWallPage());
  assert.equal(authResult.recovery.stopRetrying, true);
  assert.equal(authResult.recovery.retryAggressiveRender, false);

  // error → external recovery
  const errResult = assessMarkdownQuality(makeErrorPage());
  assert.equal(errResult.recovery.attemptExternalRecovery, true);

  // js_shell → aggressive render
  const jsResult = assessMarkdownQuality(makeJsShellPage());
  assert.equal(jsResult.recovery.retryAggressiveRender, true);

  // meaningful → accept as-is
  const meaningResult = assessMarkdownQuality(makeMeaningfulPage());
  assert.equal(meaningResult.recovery.acceptAsIs, true);
  assert.equal(meaningResult.recovery.retryAggressiveRender, false);
});

// ── Test: False-positive guard for code docs ──────────────────────

test('short license/API headings preserved in meaningful content', () => {
  const result = assessMarkdownQuality(makeCodeDocPage());
  assert.equal(result.meaningful, true);
  // License section should not cause classification to fail
  assert.equal(result.classification, 'meaningful');
});

// ── Test: Batch quality ───────────────────────────────────────────

test('batch quality returns meaningful if any page is meaningful', () => {
  const result = assessMarkdownBatchQuality([
    makeGitHubNavPage(),
    makeMeaningfulPage(),
  ]);
  assert.equal(result.meaningful, true);
});
