import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, resetConfig } from '../src/config.js';

const BROWSER_ENV_KEYS = [
  'BROWSER_ENABLED',
  'BROWSER_ENGINE',
  'CLOAKBROWSER_HUMANIZE',
  'CLOAKBROWSER_HUMAN_PRESET',
  'CLOAKBROWSER_LOCALE',
  'CLOAKBROWSER_TIMEZONE',
  'CLOAKBROWSER_GEOIP',
  'CLOAKBROWSER_STEALTH_ARGS',
  'SEARCH_MCP_CONFIG_KEY',
  'SEARCH_BACKEND',
  'EXA_API_KEY',
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of BROWSER_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  resetConfig();
});

afterEach(() => {
  for (const key of BROWSER_ENV_KEYS) {
    const prior = saved.get(key);
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  resetConfig();
});

test('loadConfig picks up CloakBrowser env settings', () => {
  process.env.BROWSER_ENABLED = 'true';
  process.env.BROWSER_ENGINE = 'cloak';
  process.env.CLOAKBROWSER_HUMANIZE = 'true';
  process.env.CLOAKBROWSER_HUMAN_PRESET = 'careful';
  process.env.CLOAKBROWSER_LOCALE = 'en-AU';
  process.env.CLOAKBROWSER_TIMEZONE = 'Australia/Melbourne';
  process.env.CLOAKBROWSER_GEOIP = 'true';
  process.env.CLOAKBROWSER_STEALTH_ARGS = 'false';
  resetConfig();

  const cfg = loadConfig();

  assert.equal(cfg.browser.enabled, true);
  assert.equal(cfg.browser.browserEngine, 'cloak');
  assert.equal(cfg.browser.cloakHumanize, true);
  assert.equal(cfg.browser.cloakHumanPreset, 'careful');
  assert.equal(cfg.browser.cloakLocale, 'en-AU');
  assert.equal(cfg.browser.cloakTimezone, 'Australia/Melbourne');
  assert.equal(cfg.browser.cloakGeoip, true);
  assert.equal(cfg.browser.cloakStealthArgs, false);
});

test('loadConfig defaults to Playwright browser backend', () => {
  const cfg = loadConfig();

  assert.equal(cfg.browser.browserEngine, 'playwright');
  assert.equal(cfg.browser.cloakHumanize, false);
  assert.equal(cfg.browser.cloakHumanPreset, 'default');
  assert.equal(cfg.browser.cloakStealthArgs, true);
});
