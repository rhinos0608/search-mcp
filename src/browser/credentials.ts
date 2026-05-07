import type { Page } from 'playwright-core';

/** Credential entry per domain. */
export interface BrowserCredentials {
   username: string;
   password: string;
   totpSecret?: string;
}

/**
 * Resolve credentials for a URL from the configured credentials map.
 * Matches by domain (hostname). Returns null if no match.
 */
export function resolveCredentials(
   url: string,
   credentials: Record<string, { username: string; password: string; totpSecret?: string }>,
): BrowserCredentials | null {
   try {
      const hostname = new URL(url).hostname;

      // Direct match
      if (credentials[hostname]) return credentials[hostname];

      // Subdomain match (e.g., app.example.com matches example.com key).
      // Credentials keyed to a subdomain will NOT match a parent domain (security).
      for (const [domain, creds] of Object.entries(credentials)) {
         if (hostname.endsWith(`.${domain}`)) {
            return creds;
         }
      }

      return null;
   } catch {
      return null;
   }
}

/** Common patterns for detecting login forms. */
const LOGIN_FIELD_PATTERNS = {
   username: [
      'input[type="email"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[name="user"]',
      'input[name="login"]',
      'input[id="email"]',
      'input[id="username"]',
      'input[autocomplete="username"]',
   ],
   password: [
      'input[type="password"]',
      'input[autocomplete="current-password"]',
   ],
   submit: [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Sign in")',
      'button:has-text("Log in")',
      'button:has-text("Login")',
   ],
};

/**
 * Attempt to perform a login on the current page.
 * Detects username/password fields and submits the form.
 * Returns true if the login appears to have succeeded.
 */
export async function performLogin(
   page: Page,
   credentials: BrowserCredentials,
   _domain: string, // reserved for future domain-specific login strategies
): Promise<boolean> {
   try {
      // Find username field
      let usernameField = null;
      for (const selector of LOGIN_FIELD_PATTERNS.username) {
         const field = page.locator(selector);
         if (await field.count() > 0) {
            usernameField = field.first();
            break;
         }
      }

      // Find password field
      let passwordField = null;
      for (const selector of LOGIN_FIELD_PATTERNS.password) {
         const field = page.locator(selector);
         if (await field.count() > 0) {
            passwordField = field.first();
            break;
         }
      }

      if (!usernameField && !passwordField) {
         return false; // No recognizable login form
      }

      // Fill credentials
      if (usernameField) {
         await usernameField.fill(credentials.username);
      }
      if (passwordField) {
         await passwordField.fill(credentials.password);
      }

      // Submit
      let submitted = false;
      for (const selector of LOGIN_FIELD_PATTERNS.submit) {
         const btn = page.locator(selector).first();
         if (await btn.count() > 0) {
            await btn.click();
            submitted = true;
            break;
         }
      }

      if (!submitted && passwordField) {
         await passwordField.press('Enter');
         submitted = true;
      }

      if (!submitted) return false;

      // Wait for post-login navigation
      try {
         await page.waitForLoadState('networkidle', { timeout: 10000 });
      } catch {
         // Timeout is OK — page may still have loaded
      }

      return true;
   } catch {
      return false;
   }
}
