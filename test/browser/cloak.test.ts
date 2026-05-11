import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCloakLaunchOptions } from '../../src/browser/cloak.js';
import type { BrowserSessionConfig } from '../../src/browser/types.js';

const baseConfig: BrowserSessionConfig = {
   headless: true,
   viewport: { width: 1280, height: 720 },
   userAgent: '',
   proxyServer: '',
   executablePath: '',
   profile: null,
   stealthEnabled: true,
   rebrowser: false,
   maxSessionTimeMs: 0,
   bypassCSP: false,
   credentials: {},
   browserEngine: 'cloak',
   cloakHumanize: false,
   cloakHumanPreset: 'default',
   cloakLocale: '',
   cloakTimezone: '',
   cloakGeoip: false,
   cloakStealthArgs: true,
};

test('buildCloakLaunchOptions maps shared browser settings to CloakBrowser options', () => {
   const options = buildCloakLaunchOptions({
      ...baseConfig,
      proxyServer: 'http://proxy.example:8080',
      cloakHumanize: true,
      cloakHumanPreset: 'careful',
      cloakLocale: 'en-AU',
      cloakTimezone: 'Australia/Melbourne',
      cloakGeoip: true,
      cloakStealthArgs: false,
   });

   assert.equal(options.headless, true);
   assert.equal(options.proxy, 'http://proxy.example:8080');
   assert.equal(options.humanize, true);
   assert.equal(options.humanPreset, 'careful');
   assert.equal(options.locale, 'en-AU');
   assert.equal(options.timezone, 'Australia/Melbourne');
   assert.equal(options.geoip, true);
   assert.equal(options.stealthArgs, false);
});

test('buildCloakLaunchOptions omits empty optional values', () => {
   const options = buildCloakLaunchOptions(baseConfig);

   assert.equal('proxy' in options, false);
   assert.equal('locale' in options, false);
   assert.equal('timezone' in options, false);
});
