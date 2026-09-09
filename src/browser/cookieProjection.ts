/**
 * Cookie projection: strip values by default, expose only behind explicit opt-in.
 *
 * `storage.list-cookies` must not return cookie values unless the caller
 * explicitly passes `includeValues: true`. This pure module keeps the
 * redaction rules testable without Playwright.
 */

import type { Cookie } from 'playwright-core';

/** Cookie metadata safe to expose by default (no value). */
export interface ProjectedCookie {
  name: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
  /** Actual value — present only when the caller opted in via includeValues. */
  value?: string;
  /** Marker set (instead of `value`) when the value was withheld. */
  valueRedacted?: boolean;
}

/**
 * Project Playwright cookies for a tool response.
 *
 * @param cookies - Raw Playwright cookies from `context.cookies()`.
 * @param includeValues - Explicit opt-in; when false, values are omitted and
 *   `valueRedacted: true` is set. Never pass anything else for defaults.
 */
export function projectCookies(
  cookies: readonly Cookie[],
  includeValues: boolean,
): ProjectedCookie[] {
  return cookies.map((cookie) => {
    const base = {
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    };
    if (includeValues) {
      return { ...base, value: cookie.value };
    }
    return { ...base, valueRedacted: true };
  });
}
