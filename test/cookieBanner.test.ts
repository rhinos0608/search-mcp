import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isCookieBannerPage } from '../src/utils/cookieBanner.js';

describe('isCookieBannerPage', () => {
  it('returns false for normal content', () => {
    const md = '# Getting Started\n\nThis is normal documentation.\n\n## Installation\n\nRun `npm install`.\n';
    assert.strictEqual(isCookieBannerPage(md), false);
  });

  it('detects OneTrust-dominated page (>40% banner lines)', () => {
    const lines = ['OneTrust Consent Manager', 'Your Privacy Choices'];
    const filler = 'Normal line.';
    const md = [...lines, filler, filler].join('\n');
    assert.strictEqual(isCookieBannerPage(md), true);
  });

  it('detects Cookiebot-dominated page', () => {
    const lines = ['Cookiebot', 'Manage Cookies', 'Accept All Cookies'];
    const filler = 'Docs content here.';
    const md = [...lines, filler, filler].join('\n');
    assert.strictEqual(isCookieBannerPage(md), true);
  });

  it('returns false when banner lines are below 40%', () => {
    const md = 'OneTrust\n\nNormal documentation line 1.\nNormal documentation line 2.\nNormal documentation line 3.\n';
    assert.strictEqual(isCookieBannerPage(md), false);
  });

  it('detects structural banner pattern (3+ consecutive cookie lines with button)', () => {
    const md = [
      'This site uses cookies to improve your experience.',
      'We value your privacy and tracking preferences.',
      'Please Accept or Reject cookies to continue.',
      'Normal docs line.',
    ].join('\n');
    assert.strictEqual(isCookieBannerPage(md), true);
  });
});
