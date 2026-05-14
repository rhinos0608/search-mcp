/* eslint-disable @typescript-eslint/no-empty-function, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/restrict-template-expressions */
import type {
  BrowserSession,
  BrowserSessionConfig,
  CDPEndpointConfig,
  SessionStatus,
} from './types.js';
import { BrowserError } from './types.js';
import {
  buildLaunchArgs,
  buildInitScripts,
  resolveBrowserModule,
  buildContextOptions,
  getStealthHealth,
} from './stealth.js';
import { launchCloakBrowser, launchCloakPersistentContext } from './cloak.js';
import { assertSafeUrl } from '../httpGuards.js';
import { logger } from '../logger.js';

/** Default CDP ports to probe for user browsers. */
const DEFAULT_CDP_PORTS = [9222, 9223, 9229];

/** Timeout per port probe (ms). */
const PORT_PROBE_TIMEOUT_MS = 2000;

/**
 * Probe a CDP port on localhost and return version + targets info.
 * Returns null if the port is not available or not a Chrome DevTools endpoint.
 */
async function probeCDPPort(port: number): Promise<{
  webSocketDebuggerUrl: string | undefined;
  version: Record<string, string | undefined>;
  targets: { id: string; url: string; title: string; type: string }[];
} | null> {
  try {
    const versionResp = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(PORT_PROBE_TIMEOUT_MS),
    });
    if (!versionResp.ok) return null;

    const raw = (await versionResp.json()) as Record<string, unknown>;
    const version: Record<string, string | undefined> = {
      Browser: typeof raw.Browser === 'string' ? raw.Browser : undefined,
      'Protocol-Version':
        typeof raw['Protocol-Version'] === 'string' ? raw['Protocol-Version'] : undefined,
      'User-Agent': typeof raw['User-Agent'] === 'string' ? raw['User-Agent'] : undefined,
    };

    const targetsResp = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: AbortSignal.timeout(PORT_PROBE_TIMEOUT_MS),
    });
    if (!targetsResp.ok) return null;

    const targets = (await targetsResp.json()) as {
      id: string;
      url: string;
      title: string;
      type: string;
    }[];

    return {
      webSocketDebuggerUrl:
        typeof raw.webSocketDebuggerUrl === 'string' ? raw.webSocketDebuggerUrl : undefined,
      version,
      targets,
    };
  } catch {
    return null;
  }
}

/** Discovered browser target (tab/page) from a CDP endpoint. */
export interface DiscoveredTarget {
  id: string;
  url: string;
  title: string;
  type: 'page' | 'iframe' | 'worker' | 'service_worker';
}

/** Discovered user browser on a given port. */
export interface DiscoveredBrowser {
  port: number;
  browserName: string;
  browserVersion: string;
  userAgent: string;
  targets: DiscoveredTarget[];
}

export class BrowserManager {
  private activeSession: BrowserSession | null = null;
  private activeMode: 'stealth' | 'user' | 'profile' | null = null;

  /**
   * Launch a new Chromium browser instance.
   */
  async launch(config: BrowserSessionConfig): Promise<BrowserSession> {
    if (this.activeSession) {
      throw new BrowserError(
        'A browser session is already active. Close it first.',
        'LAUNCH_FAILED',
      );
    }

    let browser: import('playwright-core').Browser;
    if (config.browserEngine === 'cloak') {
      browser = await launchCloakBrowser(config);
    } else {
      const moduleName = resolveBrowserModule(config);
      let playwrightModule: typeof import('playwright-core');
      try {
        playwrightModule = await import(moduleName);
      } catch {
        throw new BrowserError(
          `Failed to import ${moduleName}. Ensure it is installed: npm install ${moduleName}`,
          'LAUNCH_FAILED',
        );
      }

      const launchArgs = buildLaunchArgs(config);
      const launchOptions: Parameters<typeof playwrightModule.chromium.launch>[0] = {
        headless: config.headless,
        args: launchArgs,
      };
      if (config.executablePath) {
        launchOptions.executablePath = config.executablePath;
      }
      browser = await playwrightModule.chromium.launch(launchOptions);
    }

    const contextOptions = buildContextOptions(config);
    const context = await browser.newContext(contextOptions);

    // Inject init scripts for Playwright stealth. CloakBrowser supplies source-level patches.
    if (config.stealthEnabled && config.browserEngine !== 'cloak') {
      const scripts = buildInitScripts(config);
      for (const script of scripts) {
        await context.addInitScript(script);
      }
    }

    const page = await context.newPage();
    if (config.viewport) {
      await page.setViewportSize(config.viewport);
    }

    const now = new Date().toISOString();
    const session: BrowserSession = {
      id: `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      browser,
      context,
      page,
      pages: [page],
      cdpSession: null,
      createdAt: now,
      lastActivityAt: now,
      profileName: config.profile ?? null,
      timeoutHandle: null,
      source: 'launch',
      browserEngine: config.browserEngine,
    };

    // Set up session timeout
    if (config.maxSessionTimeMs > 0) {
      session.timeoutHandle = setTimeout(() => {
        void this.close(session).catch(() => {});
      }, config.maxSessionTimeMs);
    }

    this.activeSession = session;
    this.activeMode = 'stealth';
    return session;
  }

  /**
   * Connect to an existing browser via CDP endpoint.
   */
  async connect(
    endpoint: CDPEndpointConfig,
    config: Partial<BrowserSessionConfig> = {},
  ): Promise<BrowserSession> {
    if (this.activeSession) {
      throw new BrowserError(
        'A browser session is already active. Close it first.',
        'CONNECT_FAILED',
      );
    }

    // Synthesize a full config for module resolution
    const synthConfig: BrowserSessionConfig = {
      headless: config.headless ?? true,
      viewport: config.viewport ?? { width: 1280, height: 720 },
      userAgent: config.userAgent ?? '',
      proxyServer: config.proxyServer ?? '',
      executablePath: config.executablePath ?? '',
      profile: config.profile ?? null,
      stealthEnabled: config.stealthEnabled ?? true,
      rebrowser: config.rebrowser ?? false,
      maxSessionTimeMs: config.maxSessionTimeMs ?? 0,
      bypassCSP: config.bypassCSP ?? false,
      credentials: config.credentials ?? {},
      browserEngine: config.browserEngine ?? 'playwright',
      cloakHumanize: config.cloakHumanize ?? false,
      cloakHumanPreset: config.cloakHumanPreset ?? 'default',
      cloakLocale: config.cloakLocale ?? '',
      cloakTimezone: config.cloakTimezone ?? '',
      cloakGeoip: config.cloakGeoip ?? false,
      cloakStealthArgs: config.cloakStealthArgs ?? true,
    };

    const moduleName = resolveBrowserModule(synthConfig);
    let playwrightModule: typeof import('playwright-core');
    try {
      playwrightModule = await import(moduleName);
    } catch {
      throw new BrowserError(
        `Failed to import ${moduleName}. Ensure it is installed: npm install ${moduleName}`,
        'CONNECT_FAILED',
      );
    }

    // SSRF guard: validate CDP endpoint hostname
    try {
      assertSafeUrl(endpoint.endpoint);
    } catch (err) {
      if (err instanceof BrowserError) throw err;
      throw new BrowserError(
        `Unsafe CDP endpoint: ${err instanceof Error ? err.message : String(err)}`,
        'SSRF_BLOCKED',
      );
    }

    const connectOpts: { headers?: Record<string, string> } = {};
    if (endpoint.headers) {
      connectOpts.headers = endpoint.headers;
    }
    const browser = await playwrightModule.chromium.connectOverCDP(endpoint.endpoint, connectOpts);

    // Use the default context from the connected browser
    const contexts = browser.contexts();
    const context = contexts[0] ?? (await browser.newContext());
    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());

    if (config.viewport && page) {
      await page.setViewportSize(config.viewport);
    }

    const now = new Date().toISOString();
    const session: BrowserSession = {
      id: `cdp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      browser,
      context,
      page,
      pages: context.pages(),
      cdpSession: null,
      createdAt: now,
      lastActivityAt: now,
      profileName: null,
      timeoutHandle: null,
      source: 'cdp',
      browserEngine: synthConfig.browserEngine,
    };

    this.activeSession = session;
    this.activeMode = 'stealth'; // Legacy CDP connections use manager-controlled browser
    return session;
  }

  /**
   * Discover user browsers running with remote debugging enabled.
   * Probes common CDP ports and returns available targets.
   */
  async discoverUserBrowsers(ports: number[] = DEFAULT_CDP_PORTS): Promise<DiscoveredBrowser[]> {
    const results: DiscoveredBrowser[] = [];

    for (const port of ports) {
      const info = await probeCDPPort(port);
      if (!info) continue;

      results.push({
        port,
        browserName: info.version.Browser ?? 'Chromium',
        browserVersion: info.version['Protocol-Version'] ?? 'unknown',
        userAgent: info.version['User-Agent'] ?? '',
        targets: info.targets
          .filter((t) => t.type === 'page')
          .map((t) => ({
            id: t.id,
            url: t.url,
            title: t.title,
            type: 'page' as const,
          })),
      });
    }

    return results;
  }

  /**
   * Connect to the user's existing Chrome browser via CDP.
   * Auto-discovers the browser on the given port (or common ports if port=0).
   * Uses the existing default context — does not create a new isolated context.
   */
  async connectToUserBrowser(
    port: number | 'auto' = 'auto',
    config: Partial<BrowserSessionConfig> = {},
  ): Promise<BrowserSession> {
    if (this.activeSession) {
      throw new BrowserError(
        'A browser session is already active. Close it first.',
        'CONNECT_FAILED',
      );
    }

    const portsToTry = port === 'auto' ? DEFAULT_CDP_PORTS : [port];
    let wsEndpoint: string | null = null;

    for (const p of portsToTry) {
      const info = await probeCDPPort(p);
      if (info?.webSocketDebuggerUrl) {
        wsEndpoint = info.webSocketDebuggerUrl;
        break;
      }
    }

    if (!wsEndpoint) {
      const tried = portsToTry.join(', ');
      throw new BrowserError(
        `No Chrome instance found with remote debugging enabled on port(s): ${tried}. ` +
          `Start Chrome with: chrome --remote-debugging-port=9222`,
        'CONNECT_FAILED',
      );
    }

    logger.info({ wsEndpoint: wsEndpoint.slice(0, 80) + '...' }, 'Connecting to user browser');

    const synthConfig: BrowserSessionConfig = {
      headless: false,
      viewport: config.viewport ?? { width: 1280, height: 720 },
      userAgent: config.userAgent ?? '',
      proxyServer: config.proxyServer ?? '',
      executablePath: config.executablePath ?? '',
      profile: null,
      stealthEnabled: false, // Not needed — real browser fingerprint
      rebrowser: false,
      maxSessionTimeMs: config.maxSessionTimeMs ?? 0,
      bypassCSP: config.bypassCSP ?? false,
      credentials: config.credentials ?? {},
      browserEngine: config.browserEngine ?? 'playwright',
      cloakHumanize: config.cloakHumanize ?? false,
      cloakHumanPreset: config.cloakHumanPreset ?? 'default',
      cloakLocale: config.cloakLocale ?? '',
      cloakTimezone: config.cloakTimezone ?? '',
      cloakGeoip: config.cloakGeoip ?? false,
      cloakStealthArgs: config.cloakStealthArgs ?? true,
    };

    const moduleName = resolveBrowserModule(synthConfig);
    let playwrightModule: typeof import('playwright-core');
    try {
      playwrightModule = await import(moduleName);
    } catch {
      throw new BrowserError(
        `Failed to import ${moduleName}. Ensure it is installed: npm install ${moduleName}`,
        'CONNECT_FAILED',
      );
    }

    const browser = await playwrightModule.chromium.connectOverCDP(wsEndpoint);

    // Use the default context from the connected browser (preserves user's sessions)
    const contexts = browser.contexts();
    const context = contexts[0];
    if (!context) {
      throw new BrowserError(
        'No browser context available in the connected browser.',
        'CONNECT_FAILED',
      );
    }

    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());

    if (config.viewport && page) {
      await page.setViewportSize(config.viewport);
    }

    const now = new Date().toISOString();
    const session: BrowserSession = {
      id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      browser,
      context,
      page,
      pages: context.pages(),
      cdpSession: null,
      createdAt: now,
      lastActivityAt: now,
      profileName: null,
      timeoutHandle: null,
      source: 'user',
      browserEngine: synthConfig.browserEngine,
    };

    this.activeSession = session;
    this.activeMode = 'user';
    return session;
  }

  /**
   * Launch a Chromium browser with a persistent profile directory.
   * All cookies, localStorage, and extensions survive restarts.
   */
  async launchWithProfile(config: BrowserSessionConfig): Promise<BrowserSession> {
    if (this.activeSession) {
      throw new BrowserError(
        'A browser session is already active. Close it first.',
        'LAUNCH_FAILED',
      );
    }

    const profileDir = config.profile;
    if (!profileDir) {
      throw new BrowserError('Profile name is required for profile mode.', 'LAUNCH_FAILED');
    }

    // Resolve to absolute path: absolute paths used as-is, relative paths resolved under a cache dir
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const profilePath = profileDir.startsWith('/')
      ? profileDir
      : join(homedir(), '.cache', 'search-mcp', 'browser-profiles', profileDir);

    let context: import('playwright-core').BrowserContext;
    if (config.browserEngine === 'cloak') {
      context = await launchCloakPersistentContext(config, profilePath);
    } else {
      const moduleName = resolveBrowserModule(config);
      let playwrightModule: typeof import('playwright-core');
      try {
        playwrightModule = await import(moduleName);
      } catch {
        throw new BrowserError(
          `Failed to import ${moduleName}. Ensure it is installed: npm install ${moduleName}`,
          'LAUNCH_FAILED',
        );
      }

      const launchArgs = buildLaunchArgs(config);
      const launchOptions: Parameters<typeof playwrightModule.chromium.launchPersistentContext>[1] =
        {
          headless: config.headless,
          args: launchArgs,
          viewport: config.viewport || { width: 1280, height: 720 },
          bypassCSP: config.bypassCSP ?? false,
        };

      // Pass proxy through the dedicated option (not just CLI arg)
      if (config.proxyServer) {
        launchOptions.proxy = { server: config.proxyServer };
      }

      if (config.executablePath) {
        launchOptions.executablePath = config.executablePath;
      }
      if (config.userAgent) {
        launchOptions.userAgent = config.userAgent;
      }

      context = await playwrightModule.chromium.launchPersistentContext(profilePath, launchOptions);
    }

    // Inject Playwright stealth init scripts if enabled. CloakBrowser supplies source-level patches.
    if (config.stealthEnabled && config.browserEngine !== 'cloak') {
      const scripts = buildInitScripts(config);
      for (const script of scripts) {
        await context.addInitScript(script);
      }
    }

    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());

    const now = new Date().toISOString();
    const b = context.browser();
    if (!b) {
      throw new BrowserError('Persistent context has no browser instance.', 'LAUNCH_FAILED');
    }
    const session: BrowserSession = {
      id: `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      browser: b,
      context,
      page,
      pages,
      cdpSession: null,
      createdAt: now,
      lastActivityAt: now,
      profileName: profileDir,
      timeoutHandle: null,
      source: 'profile',
      browserEngine: config.browserEngine,
    };

    if (config.maxSessionTimeMs > 0) {
      session.timeoutHandle = setTimeout(() => {
        void this.close(session).catch(() => {});
      }, config.maxSessionTimeMs);
    }

    this.activeSession = session;
    this.activeMode = 'profile';
    return session;
  }

  /** Get current browser mode. */
  getMode(): 'stealth' | 'user' | 'profile' | null {
    return this.activeMode;
  }

  /**
   * Close a browser session and clean up.
   */
  async close(session: BrowserSession): Promise<void> {
    if (session.timeoutHandle) {
      clearTimeout(session.timeoutHandle);
    }
    try {
      await session.context.close();
      if (session.browser) {
        await session.browser.close();
      }
    } finally {
      if (this.activeSession?.id === session.id) {
        this.activeSession = null;
        this.activeMode = null;
      }
    }
  }

  /**
   * Get status of the active session.
   */
  getStatus(session: BrowserSession): SessionStatus {
    const livePages = session.context.pages();
    const tabCount = livePages.length;
    const activeTabIndex = livePages.indexOf(session.page);
    const safeActiveIndex = activeTabIndex >= 0 ? activeTabIndex : 0;
    return {
      id: session.id,
      tabCount,
      activeTabIndex: safeActiveIndex,
      activeUrl: session.page.url(),
      uptimeMs: Date.now() - new Date(session.createdAt).getTime(),
      isCDPEndpoint: session.source === 'cdp',
      profileName: session.profileName,
      mode: this.activeMode ?? 'stealth',
      browserEngine: session.browserEngine,
      stealthHealth: this.activeMode === 'stealth' ? getStealthHealth(session.browserEngine) : null,
    };
  }

  /** Get the currently active session (or null). */
  getActiveSession(): BrowserSession | null {
    return this.activeSession;
  }

  /** Reset session TTL on each action. */
  touchSession(session: BrowserSession, timeoutMs: number): void {
    if (this.activeSession?.id !== session.id) {
      throw new BrowserError('Session is not the active session', 'SESSION_NOT_FOUND');
    }
    session.lastActivityAt = new Date().toISOString();
    if (session.timeoutHandle) {
      clearTimeout(session.timeoutHandle);
    }
    if (timeoutMs > 0) {
      session.timeoutHandle = setTimeout(() => {
        void this.close(session).catch(() => {});
      }, timeoutMs);
    }
  }
}

/** Singleton instance for v1 (single session). */
export const browserManager = new BrowserManager();
