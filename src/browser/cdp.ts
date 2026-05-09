import type { Page, CDPSession } from 'playwright-core';
import { BrowserError } from './types.js';

/** Cache of CDP sessions, keyed by Page. */
const cdpSessionCache = new WeakMap<Page, CDPSession>();

/** Remove a Page from the cache when its CDP session is closed/disconnected. */
function onCdpSessionDisconnected(page: Page): void {
  cdpSessionCache.delete(page);
}

/**
 * Create or retrieve a CDP session for the given page.
 * Lazy: caches sessions per Page to avoid redundant CDP connections.
 */
export async function createCDPSession(page: Page): Promise<CDPSession> {
  const cached = cdpSessionCache.get(page);
  if (cached) return cached;

  try {
    const session = await page.context().newCDPSession(page);
    cdpSessionCache.set(page, session);
    // Clean up cache entry when session disconnects
    session.on('close', () => {
      onCdpSessionDisconnected(page);
    });
    return session;
  } catch (err) {
    throw new BrowserError(
      `Failed to create CDP session: ${err instanceof Error ? err.message : String(err)}`,
      'CONNECT_FAILED',
    );
  }
}

/**
 * Send a raw CDP command and return the result.
 */
export async function sendCommand(
  session: CDPSession,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await (session.send as (m: string, p?: Record<string, unknown>) => Promise<unknown>)(
      method,
      params,
    );
  } catch (err) {
    throw new BrowserError(
      `CDP command ${method} failed: ${err instanceof Error ? err.message : String(err)}`,
      'ACTION_FAILED',
    );
  }
}

/**
 * Enable network tracking (Network.enable).
 * Call this before navigating to capture full request/response bodies.
 */
export async function enableNetworkTracking(session: CDPSession): Promise<void> {
  try {
    await session.send('Network.enable');
  } catch (err) {
    throw new BrowserError(
      `Network.enable failed: ${err instanceof Error ? err.message : String(err)}`,
      'ACTION_FAILED',
    );
  }
}

/**
 * Enable performance metrics (Performance.enable).
 * Call this to start collecting Core Web Vitals and JS coverage.
 */
export async function enablePerformanceMetrics(session: CDPSession): Promise<void> {
  try {
    await session.send('Performance.enable');
  } catch (err) {
    throw new BrowserError(
      `Performance.enable failed: ${err instanceof Error ? err.message : String(err)}`,
      'ACTION_FAILED',
    );
  }
}
