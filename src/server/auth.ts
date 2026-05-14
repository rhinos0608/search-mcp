import { randomUUID } from 'node:crypto';

export interface Session {
  id: string;
  createdAt: number;
  expiresAt: number;
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  private timer: ReturnType<typeof setInterval>;

  constructor(private readonly ttlMs: number) {
    this.timer = setInterval(() => { this.pruneExpired(); }, 5 * 60 * 1000);
    this.timer.unref();
  }

  create(): Session {
    const now = Date.now();
    const session: Session = { id: randomUUID(), createdAt: now, expiresAt: now + this.ttlMs };
    this.sessions.set(session.id, session);
    return session;
  }

  validate(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (Date.now() > s.expiresAt) { this.sessions.delete(id); return false; }
    return true;
  }

  revoke(id: string): void { this.sessions.delete(id); }
  revokeAll(): void { this.sessions.clear(); }
  get size(): number { return this.sessions.size; }

  pruneExpired(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now > s.expiresAt) this.sessions.delete(id);
  }

  destroy(): void { clearInterval(this.timer); this.sessions.clear(); }
}

interface RateLimitEntry { failures: number; lockedUntil?: number }

export class LoginRateLimiter {
  private entries = new Map<string, RateLimitEntry>();
  constructor(
    private readonly maxFailures = 10,
    private readonly lockoutMs = 15 * 60 * 1000,
  ) {}

  check(ip: string): { allowed: boolean; retryAfter?: number } {
    const e = this.entries.get(ip);
    if (!e) return { allowed: true };
    if (e.lockedUntil !== undefined && Date.now() < e.lockedUntil) {
      return { allowed: false, retryAfter: Math.ceil((e.lockedUntil - Date.now()) / 1000) };
    }
    return { allowed: true };
  }

  recordFailure(ip: string): void {
    const e = this.entries.get(ip) ?? { failures: 0 };
    e.failures++;
    if (e.failures >= this.maxFailures) e.lockedUntil = Date.now() + this.lockoutMs;
    this.entries.set(ip, e);
  }

  recordSuccess(ip: string): void { this.entries.delete(ip); }
}

export function getCookieName(https: boolean): string {
  return https ? '__Host-smcp-session' : 'smcp-session';
}

export function parseCookieHeader(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k?.trim() === name) return v?.trim();
  }
  return undefined;
}

export function buildSetCookieHeader(id: string, ttlMs: number, https: boolean): string {
  const name = getCookieName(https);
  const maxAge = Math.floor(ttlMs / 1000);
  const base = `${name}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${String(maxAge)}`;
  return https ? `${base}; Secure` : base;
}

export function buildClearCookieHeader(https: boolean): string {
  const name = getCookieName(https);
  return `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${https ? '; Secure' : ''}`;
}
