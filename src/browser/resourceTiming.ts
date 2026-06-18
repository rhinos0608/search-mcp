import type { Page } from 'playwright-core';
import type { NavigationTiming, ResourceTimingEntry, ResourceTimingResult } from './types.js';

/**
 * Extract Navigation Timing and Resource Timing data from the current page.
 * Uses the Performance API (performance.getEntriesByType).
 */
export async function getResourceTiming(page: Page): Promise<ResourceTimingResult> {
  const url = page.url();

  const raw = await page.evaluate(() => {
    // Navigation Timing
    const navEntries = performance.getEntriesByType('navigation');
    let navTiming: Record<string, number> | null = null;

    if (navEntries.length > 0) {
      const nav = navEntries[0] as PerformanceNavigationTiming;
      navTiming = {
        ttfb: nav.responseStart - nav.requestStart,
        domContentLoaded: nav.domContentLoadedEventEnd - nav.domContentLoadedEventStart,
        loadComplete: nav.loadEventEnd - nav.loadEventStart,
        domInteractive: nav.domInteractive,
        dnsTime: nav.domainLookupEnd - nav.domainLookupStart,
        tcpTime: nav.connectEnd - nav.connectStart,
        tlsTime: nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : 0,
        requestTime: nav.responseStart - nav.requestStart,
        responseTime: nav.responseEnd - nav.responseStart,
      };
    }

    // First Paint / First Contentful Paint
    const paintEntries = performance.getEntriesByType('paint');
    let firstPaint = 0;
    let firstContentfulPaint = 0;
    for (const entry of paintEntries) {
      const paintEntry = entry as PerformanceEntry & { name: string };
      if (paintEntry.name === 'first-paint') firstPaint = paintEntry.startTime;
      if (paintEntry.name === 'first-contentful-paint') firstContentfulPaint = paintEntry.startTime;
    }

    if (navTiming) {
      navTiming.firstPaint = firstPaint;
      navTiming.firstContentfulPaint = firstContentfulPaint;
    }

    // Resource Timing
    const resourceEntries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const resources: {
      url: string;
      type: string;
      duration: number;
      transferSize: number;
      startTime: number;
      dnsTime: number;
      tcpTime: number;
      requestTime: number;
      responseTime: number;
    }[] = [];

    let totalTransferSize = 0;

    for (const res of resourceEntries) {
      const entry = {
        url: res.name,
        type: res.initiatorType || 'other',
        duration: res.duration,
        transferSize: res.transferSize || 0,
        startTime: res.startTime,
        dnsTime: res.domainLookupEnd - res.domainLookupStart,
        tcpTime: res.connectEnd - res.connectStart,
        requestTime: res.responseStart - res.requestStart,
        responseTime: res.responseEnd - res.responseStart,
      };
      resources.push(entry);
      totalTransferSize += entry.transferSize;
    }

    // Sort by duration descending
    resources.sort((a, b) => b.duration - a.duration);

    return {
      navigation: navTiming,
      resources,
      totalResources: resources.length,
      totalTransferSize,
    };
  });

  // Build typed result
  const nav: NavigationTiming | null = raw.navigation
    ? {
        ttfb: raw.navigation.ttfb ?? 0,
        domContentLoaded: raw.navigation.domContentLoaded ?? 0,
        loadComplete: raw.navigation.loadComplete ?? 0,
        firstPaint: raw.navigation.firstPaint ?? 0,
        firstContentfulPaint: raw.navigation.firstContentfulPaint ?? 0,
        domInteractive: raw.navigation.domInteractive ?? 0,
        dnsTime: raw.navigation.dnsTime ?? 0,
        tcpTime: raw.navigation.tcpTime ?? 0,
        tlsTime: raw.navigation.tlsTime ?? 0,
        requestTime: raw.navigation.requestTime ?? 0,
        responseTime: raw.navigation.responseTime ?? 0,
      }
    : null;

  const resources: ResourceTimingEntry[] = raw.resources.map((r) => ({
    url: r.url,
    type: r.type,
    duration: r.duration,
    transferSize: r.transferSize,
    startTime: r.startTime,
    dnsTime: r.dnsTime,
    tcpTime: r.tcpTime,
    requestTime: r.requestTime,
    responseTime: r.responseTime,
  }));

  const slowResources = resources.filter((r) => r.duration > 200);

  return {
    navigation: nav,
    resources,
    totalResources: raw.totalResources,
    totalTransferSize: raw.totalTransferSize,
    slowResources,
    url,
  };
}
