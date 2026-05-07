/* eslint-disable @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unsafe-assignment */
import { mkdir, readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { BrowserContext } from 'playwright-core';
import type { ProfileStorage } from './types.js';

/** Default profile directory if not configured. */
const DEFAULT_PROFILE_DIR = join(
   process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
   '.cache',
   'search-mcp',
   'browser-profiles',
);

export class SessionStore {
   constructor(private readonly profileDir: string = DEFAULT_PROFILE_DIR) { }

   /** Ensure profile directory exists. */
   private async ensureDir(): Promise<void> {
      if (!existsSync(this.profileDir)) {
         await mkdir(this.profileDir, { recursive: true });
      }
   }

   /** Sanitize profile name to prevent path traversal. Rejects blank/whitespace-only names. */
   private sanitizeProfileName(name: string): string {
      const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
      if (safe.length === 0) {
         throw new Error(
            `Profile name must contain at least one alphanumeric, underscore, dot, or hyphen character. Got: "${name}"`,
         );
      }
      return safe;
   }

   /** Get profile file path. */
   private profilePath(name: string): string {
      const safeName = this.sanitizeProfileName(name);
      return join(this.profileDir, `${safeName}.json`);
   }

   /**
    * Save current browser storage state to a named profile.
    * Rejects with an error if the sanitized name collides with an existing
    * profile that was saved under a different original name.
    */
   async saveProfile(name: string, context: BrowserContext): Promise<void> {
      await this.ensureDir();
      const safeName = this.sanitizeProfileName(name);

      // Check for collision: another original name that sanitizes to the same file
      const collisionTarget = await this.findProfileBySanitizedName(safeName);
      if (collisionTarget !== null && collisionTarget !== name) {
         throw new Error(
            `Profile name "${name}" (sanitized: "${safeName}") collides with existing profile "${collisionTarget}". ` +
            `Choose a different name or delete the existing profile first.`,
         );
      }

      const storageState = await context.storageState();
      const profile: ProfileStorage = {
         name,
         savedAt: new Date().toISOString(),
         storageState,
      };
      await writeFile(this.profilePath(name), JSON.stringify(profile, null, 2), 'utf8');
   }

   /**
    * Look up the original name stored in the profile file matching a sanitized
    * name. Returns null if no profile exists at that path.
    */
   private async findProfileBySanitizedName(safeName: string): Promise<string | null> {
      const path = join(this.profileDir, `${safeName}.json`);
      if (!existsSync(path)) return null;
      try {
         const raw = await readFile(path, 'utf8');
         const profile: ProfileStorage = JSON.parse(raw);
         return profile.name;
      } catch {
         return null;
      }
   }

   /**
    * Load a previously saved profile.
    * Returns the storageState (cookies, localStorage) or null if not found.
    */
   async loadProfile(name: string): Promise<unknown | null> {
      const path = this.profilePath(name);
      if (!existsSync(path)) return null;
      try {
         const raw = await readFile(path, 'utf8');
         const profile: ProfileStorage = JSON.parse(raw);
         return profile.storageState;
      } catch {
         return null;
      }
   }

   /**
    * List all saved profile names.
    */
   async listProfiles(): Promise<string[]> {
      if (!existsSync(this.profileDir)) return [];
      const entries = await readdir(this.profileDir);
      return entries
         .filter((f) => f.endsWith('.json'))
         .map((f) => f.slice(0, -5)); // remove .json extension
   }

   /**
    * Delete a saved profile.
    */
   async deleteProfile(name: string): Promise<void> {
      const path = this.profilePath(name);
      if (existsSync(path)) {
         await unlink(path);
      }
   }
}

/** Shared singleton. */
export const sessionStore = new SessionStore();
