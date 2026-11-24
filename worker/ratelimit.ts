import { getAppSetting, type User } from './auth.js';
import type { Env } from './env.js';

/**
 * Request limits per person, so one account (or one script) can't use up the Worker's daily allowance or hammer the
 * database. Counts are kept in memory per isolate and cost no request of their own; the hourly limit also reads the
 * hour's total that the usage panel already collects (refreshed about every 30 seconds), so it holds across isolates
 * to within that delay. The instance admin is not limited. Guests are limited by address.
 *
 * Both limits are set by the admin (Admin → Settings): per minute (default 600) and per hour (default none).
 * A value of 0 turns that limit off.
 */
const DEFAULT_PER_MINUTE = 600;
const SETTINGS_TTL = 30_000;

let cached = { perMinute: DEFAULT_PER_MINUTE, perHour: 0 };
let cachedAt = 0;

async function limits(env: Env) {
  if (Date.now() - cachedAt > SETTINGS_TTL) {
    const [m, h] = await Promise.all([getAppSetting(env, 'rate_per_minute'), getAppSetting(env, 'rate_per_hour')]);
    cached = {
      perMinute: m === '' ? DEFAULT_PER_MINUTE : Math.max(0, Math.floor(Number(m)) || 0),
      perHour: Math.max(0, Math.floor(Number(h)) || 0),
    };
    cachedAt = Date.now();
  }
  return cached;
}

/** Forget the cached limits (after the admin changes them). */
export const forgetRateLimits = () => {
  cachedAt = 0;
};

const minutes = new Map<string, { window: number; count: number }>();
const hours = new Map<string, { hour: number; base: number; local: number; at: number }>();

export interface RateVerdict {
  ok: boolean;
  retryAfter: number;
  message: string;
}

const OK: RateVerdict = { ok: true, retryAfter: 0, message: '' };

export async function checkRate(env: Env, user: User | null, req: Request): Promise<RateVerdict> {
  if (user?.role === 'admin') return OK;
  const l = await limits(env);
  const now = Date.now();
  const key = user ? `u:${user.id}` : `ip:${req.headers.get('cf-connecting-ip') ?? 'unknown'}`;

  if (l.perMinute > 0) {
    // guests share an address with others, so they get a fraction of a signed-in person's allowance
    const allowed = user ? l.perMinute : Math.max(60, Math.floor(l.perMinute / 4));
    const window = Math.floor(now / 60_000);
    const e = minutes.get(key);
    const entry = e && e.window === window ? e : { window, count: 0 };
    entry.count++;
    minutes.set(key, entry);
    if (minutes.size > 5000) for (const [k, v] of minutes) if (v.window !== window) minutes.delete(k);
    if (entry.count > allowed) {
      return { ok: false, retryAfter: 60 - Math.floor((now % 60_000) / 1000), message: 'too many requests: slow down and try again in a minute' };
    }
  }

  if (user && l.perHour > 0) {
    const hour = Math.floor(now / 3_600_000);
    let h = hours.get(user.id);
    if (!h || h.hour !== hour || now - h.at > SETTINGS_TTL) {
      const row = await env.DB.prepare('SELECT requests FROM usage_hourly WHERE user_id = ? AND hour = ?').bind(user.id, hour).first<{ requests: number }>();
      h = { hour, base: row?.requests ?? 0, local: 0, at: now };
      hours.set(user.id, h);
      if (hours.size > 5000) for (const [k, v] of hours) if (v.hour !== hour) hours.delete(k);
    }
    h.local++;
    if (h.base + h.local > l.perHour) {
      return { ok: false, retryAfter: 3600 - Math.floor((now % 3_600_000) / 1000), message: `this account has used its ${l.perHour} requests for this hour: try again later` };
    }
  }
  return OK;
}

/** Sign-ups from one address (when registration is open): at most SIGNUPS_PER_HOUR an hour. */
const signups = new Map<string, { hour: number; count: number }>();
const SIGNUPS_PER_HOUR = 5;

export function signupAllowed(req: Request): boolean {
  const key = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const hour = Math.floor(Date.now() / 3_600_000);
  const e = signups.get(key);
  const entry = e && e.hour === hour ? e : { hour, count: 0 };
  entry.count++;
  signups.set(key, entry);
  return entry.count <= SIGNUPS_PER_HOUR;
}
