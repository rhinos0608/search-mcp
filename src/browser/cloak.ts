import type { Browser, BrowserContext } from 'playwright-core';
import type { BrowserSessionConfig } from './types.js';
import { BrowserError } from './types.js';

export interface CloakLaunchOptions {
  headless: boolean;
  proxy?: string;
  args?: string[];
  stealthArgs?: boolean;
  timezone?: string;
  locale?: string;
  geoip?: boolean;
  launchOptions?: Record<string, unknown>;
  humanize?: boolean;
  humanPreset?: 'default' | 'careful';
  contextOptions?: Record<string, unknown>;
  userAgent?: string;
  viewport?: { width: number; height: number } | null;
  userDataDir?: string;
}

interface CloakBrowserModule {
  launch?: (options?: CloakLaunchOptions) => Promise<Browser>;
  launchPersistentContext?: (options: CloakLaunchOptions & { userDataDir: string }) => Promise<BrowserContext>;
}

function hasCloakLaunchers(value: unknown): value is CloakBrowserModule {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CloakBrowserModule>;
  return typeof candidate.launch === 'function' || typeof candidate.launchPersistentContext === 'function';
}

export function buildCloakLaunchOptions(config: BrowserSessionConfig): CloakLaunchOptions {
  const options: CloakLaunchOptions = {
    headless: config.headless,
    stealthArgs: config.cloakStealthArgs,
    geoip: config.cloakGeoip,
    humanize: config.cloakHumanize,
    humanPreset: config.cloakHumanPreset,
    viewport: config.viewport,
  };

  if (config.proxyServer) options.proxy = config.proxyServer;
  if (config.cloakLocale) options.locale = config.cloakLocale;
  if (config.cloakTimezone) options.timezone = config.cloakTimezone;
  if (config.userAgent) options.userAgent = config.userAgent;
  if (config.executablePath) {
    options.launchOptions = { executablePath: config.executablePath };
  }

  return options;
}

async function importCloakBrowser(): Promise<CloakBrowserModule> {
  try {
    // CloakBrowser is an optional runtime integration. Do not make startup depend on it.
    // @ts-ignore optional dependency; resolved only when BROWSER_ENGINE=cloak is used.
    const mod: unknown = await import('cloakbrowser');
    if (!hasCloakLaunchers(mod)) {
      throw new BrowserError('cloakbrowser module did not export launch functions.', 'LAUNCH_FAILED');
    }
    return mod;
  } catch (err) {
    if (err instanceof BrowserError) throw err;
    throw new BrowserError(
      `Failed to import optional cloakbrowser package. Install it with: npm install cloakbrowser playwright-core. ${err instanceof Error ? err.message : String(err)}`,
      'LAUNCH_FAILED',
    );
  }
}

export async function launchCloakBrowser(config: BrowserSessionConfig): Promise<Browser> {
  const cloak = await importCloakBrowser();
  if (!cloak.launch) {
    throw new BrowserError('cloakbrowser launch() export is unavailable.', 'LAUNCH_FAILED');
  }
  return cloak.launch(buildCloakLaunchOptions(config));
}

export async function launchCloakPersistentContext(
  config: BrowserSessionConfig,
  userDataDir: string,
): Promise<BrowserContext> {
  const cloak = await importCloakBrowser();
  if (!cloak.launchPersistentContext) {
    throw new BrowserError(
      'cloakbrowser launchPersistentContext() export is unavailable.',
      'LAUNCH_FAILED',
    );
  }
  return cloak.launchPersistentContext({
    ...buildCloakLaunchOptions(config),
    userDataDir,
  });
}
