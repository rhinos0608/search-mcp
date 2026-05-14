/**
 * CDP Browser — Stealth / Anti-detection Module
 *
 * Three-layer approach:
 *   Layer 1: Chromium launch flags that disable automation indicators
 *   Layer 2: Init-script patches (fingerprint masking) injected via addInitScript
 *   Layer 3: Rebrowser-playwright resolution to patch CDP-level leaks (Runtime.enable)
 */

/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import type { BrowserContextOptions } from 'playwright-core';
import type { BrowserSessionConfig, StealthHealthReport } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: Launch args
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build Chromium launch arguments for anti-detection.
 * Always applied when stealth is enabled.
 */
export function buildLaunchArgs(config: BrowserSessionConfig): string[] {
  if (config.browserEngine === 'cloak') {
    return [];
  }

  const args: string[] = [];
  if (config.stealthEnabled) {
    args.push('--disable-blink-features=AutomationControlled');
    args.push('--disable-dev-shm-usage');
  }
  if (config.proxyServer) {
    args.push(`--proxy-server=${config.proxyServer}`);
  }
  return args;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2: Init-script patches
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build init-script patches for fingerprint masking.
 * Injected before page scripts execute via context.addInitScript().
 * Returns an array of JavaScript code strings.
 */
export function buildInitScripts(_config: BrowserSessionConfig): string[] {
  return [stealthInitScript];
}

const stealthInitScript = `
// -- Playwright Stealth Patches (adapted from ManagedCode research) --
(function() {
  // 1. navigator.webdriver → false
  Object.defineProperty(navigator, 'webdriver', { get: () => false });

  // 2. navigator.languages → configured (navigator.plugins spoofing removed — incomplete)

  // 3. navigator.languages → configured
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

  // 4. chrome.runtime → defined (headless returns undefined)
  if (typeof window.chrome === 'undefined') {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {};
  }

  // 5. Permissions API → realistic
  var originalQuery = window.navigator.permissions.query;
  if (originalQuery) {
    window.navigator.permissions.query = function(parameters) {
      if (parameters.name === 'notifications') {
        return Promise.resolve({ state: 'prompt', onchange: null });
      }
      return originalQuery.call(this, parameters);
    };
  }

  // 6. window.outerWidth/outerHeight → match viewport
  if (window.outerWidth === 0) {
    Object.defineProperty(window, 'outerWidth', { get: function() { return window.innerWidth; } });
    Object.defineProperty(window, 'outerHeight', { get: function() { return window.innerHeight; } });
  }

  // 7. Canvas fingerprinting → subtle noise
  var originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function() {
    var ctx = this.getContext('2d');
    if (ctx) {
      // Add subtle per-session noise (1-2 random transparent pixels)
      var imageData = ctx.getImageData(0, 0, 1, 1);
      imageData.data[0] ^= Math.floor(Math.random() * 2);
      ctx.putImageData(imageData, 0, 0);
    }
    return originalToDataURL.apply(this, arguments);
  };

  // 8. Audio fingerprinting → subtle noise
  var originalGetChannelData = AudioBuffer.prototype.getChannelData;
  AudioBuffer.prototype.getChannelData = function(channel) {
    var result = originalGetChannelData.call(this, channel);
    var noise = (Math.random() - 0.5) * 1e-7;
    for (var i = 0; i < result.length; i++) {
      result[i] += noise;
    }
    return result;
  };
})();
`;

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3: Browser module resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve which playwright module to use.
 * If rebrowser is enabled, use rebrowser-playwright (patches Runtime.enable CDP leak).
 * Otherwise, use standard playwright-core.
 */
export function resolveBrowserModule(config: BrowserSessionConfig): string {
  if (config.rebrowser && config.browserEngine !== 'cloak') {
    return 'rebrowser-playwright';
  }
  return 'playwright-core';
}

// ─────────────────────────────────────────────────────────────────────────────
// Context options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build BrowserContext options (user agent, viewport, locale, timezone, bypassCSP).
 */
export function buildContextOptions(config: BrowserSessionConfig): BrowserContextOptions {
  const opts: BrowserContextOptions = {
    viewport: config.viewport || { width: 1280, height: 720 },
    bypassCSP: config.bypassCSP ?? false,
  };

  if (config.userAgent) {
    opts.userAgent = config.userAgent;
  }

  if (config.proxyServer) {
    opts.proxy = { server: config.proxyServer };
  }

  return opts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stealth Health Reporting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a report on the current state of stealth anti-detection measures.
 * This is advisory — it reports known gaps in the stealth stack so users
 * can make informed tradeoffs between stealth mode and user-browser mode.
 */
export function getStealthHealth(
  engine: BrowserSessionConfig['browserEngine'] = 'playwright',
): StealthHealthReport {
  if (engine === 'cloak') {
    return {
      status: 'pass',
      checks: [
        {
          name: 'cloakbrowser.binary',
          passed: true,
          detail:
            'CloakBrowser selected: source-level Chromium fingerprint patches are provided by the optional cloakbrowser runtime.',
        },
      ],
      summary:
        'CloakBrowser backend selected. Stealth depends on the installed cloakbrowser package and verified binary release.',
    };
  }

  const checks: StealthHealthReport['checks'] = [];
  // Check 1: navigator.webdriver patch present
  checks.push({
    name: 'navigator.webdriver',
    passed: true, // Our init script always patches this
    detail: 'Patched via init script (Object.defineProperty). Effective against naive checks.',
  });

  // Check 2: chrome.runtime defined
  checks.push({
    name: 'chrome.runtime',
    passed: true, // Our init script always patches this
    detail: 'Spoofed via init script. Some advanced checks may still detect the stub.',
  });

  // Check 3: WebGL fingerprinting
  checks.push({
    name: 'webgl.fingerprint',
    passed: false,
    detail:
      'NOT PATCHED. WebGL vendor/renderer strings may reveal headless Chromium. Use user-browser mode for real fingerprint.',
  });

  // Check 4: Font enumeration
  checks.push({
    name: 'font.enumeration',
    passed: false,
    detail: 'NOT PATCHED. Headless font set differs from real browser. Use user-browser mode.',
  });

  // Check 5: TLS/JA3 fingerprint
  checks.push({
    name: 'tls.ja3',
    passed: false,
    detail:
      'NOT PATCHED. JA3 TLS fingerprint differs from real Chrome. Cannot be masked from JavaScript. Use user-browser mode or proxy rotation.',
  });

  // Check 6: CDP Runtime.enable leak
  checks.push({
    name: 'cdp.runtime_leak',
    passed: false,
    detail:
      'Partially patched by rebrowser-playwright (when enabled). Standard playwright-core still leaks Runtime.enable detection.',
  });

  // Check 7: navigator.plugins
  checks.push({
    name: 'navigator.plugins',
    passed: false,
    detail:
      'NOT PATCHED. Headless Chromium has empty/near-empty plugins array. Real Chrome shows PDF Viewer, Chrome PDF Plugin, etc.',
  });

  const passedCount = checks.filter((c) => c.passed).length;
  const status: StealthHealthReport['status'] =
    passedCount === checks.length ? 'pass' : passedCount >= 4 ? 'degraded' : 'fail';

  return {
    status,
    checks,
    summary:
      status === 'pass'
        ? 'All stealth checks pass. Anti-bot detection is unlikely.'
        : status === 'degraded'
          ? `${String(passedCount)}/${String(checks.length)} checks pass. Advanced bot detection (Cloudflare, DataDome) may detect headless mode. Consider using user-browser mode for sites behind anti-bot protection.`
          : `${String(passedCount)}/${String(checks.length)} checks pass. Headless Chromium is easily detectable. Strongly recommend user-browser or profile mode for production use.`,
  };
}
