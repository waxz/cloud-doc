import { requireAdmin, type User } from './auth.js';
import type { Env } from './env.js';
import { json } from './http.js';
import { sharedUsage } from './storage.js';

/**
 * Request counting for the admin's usage panel.
 *
 * Writing a row per request would double the D1 writes (the free plan allows 100k a
 * day), so counts are gathered in memory per isolate and written in one batch at most
 * every FLUSH_MS, riding on a request that is happening anyway. An isolate that is
 * evicted before its next flush loses its last few seconds of counts: the figures are
 * a close estimate, not an audit trail.
 */
const FLUSH_MS = 60_000;
const KEEP_HOURS = 24 * 31;
const HOUR = 3_600_000;

interface Bucket {
  requests: number;
  errors: number;
  bytesIn: number;
  bytesOut: number;
}

const pending = new Map<string, Bucket>(); // `${userId}|${hour}`
let lastFlush = Date.now();

export function recordUsage(user: User | null, req: Request, res: Response): void {
  if (!user) return;
  const hour = Math.floor(Date.now() / HOUR);
  const key = `${user.id}|${hour}`;
  const bucket = pending.get(key) ?? { requests: 0, errors: 0, bytesIn: 0, bytesOut: 0 };
  bucket.requests++;
  if (res.status >= 400) bucket.errors++;
  bucket.bytesIn += Number(req.headers.get('content-length')) || 0;
  bucket.bytesOut += Number(res.headers.get('content-length')) || 0;
  pending.set(key, bucket);
}

/** Writes the gathered counts if it's been a while. Call with ctx.waitUntil. */
export async function flushUsage(env: Env, force = false): Promise<void> {
  if (!pending.size || (!force && Date.now() - lastFlush < FLUSH_MS)) return;
  lastFlush = Date.now();
  const rows = [...pending];
  pending.clear();
  try {
    const stmt = env.DB.prepare(
      `INSERT INTO usage_hourly (user_id, hour, requests, errors, bytes_in, bytes_out) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, hour) DO UPDATE SET requests = requests + excluded.requests, errors = errors + excluded.errors,
         bytes_in = bytes_in + excluded.bytes_in, bytes_out = bytes_out + excluded.bytes_out`
    );
    const batch = rows.map(([key, b]) => {
      const [userId, hour] = key.split('|');
      return stmt.bind(userId, Number(hour), b.requests, b.errors, b.bytesIn, b.bytesOut);
    });
    if (Math.random() < 0.02) batch.push(env.DB.prepare('DELETE FROM usage_hourly WHERE hour < ?').bind(Math.floor(Date.now() / HOUR) - KEEP_HOURS));
    await env.DB.batch(batch);
  } catch (err) {
    console.error('usage flush failed', err);
    for (const [key, b] of rows) {
      const cur = pending.get(key);
      if (cur) {
        cur.requests += b.requests;
        cur.errors += b.errors;
        cur.bytesIn += b.bytesIn;
        cur.bytesOut += b.bytesOut;
      } else pending.set(key, b);
    }
  }
}

export interface UserUsage {
  id: string;
  name: string;
  email: string;
  role: string;
  disabled: number;
  storage_used: number;
  /** Shared storages allocated to the user: what their workspaces keep there, against the limit. */
  grants: { storage_name: string; limit_bytes: number | null; used: number }[];
  files: number;
  pages_created: number;
  comments: number;
  requests_24h: number;
  requests_7d: number;
  requests_30d: number;
  errors_24h: number;
  bytes_in_24h: number;
  bytes_out_24h: number;
  peak_hour: number;
  last_active: number | null;
}

/** Admin: storage, requests and request rate per user, plus an hourly total for the last 24 h. */
export async function adminStats(env: Env, user: User | null): Promise<Response> {
  requireAdmin(user);
  await flushUsage(env, true); // include this isolate's latest counts
  const now = Date.now();
  const hour = Math.floor(now / HOUR);
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.disabled,
       (SELECT COALESCE(SUM(size), 0) FROM files WHERE owner_id = u.id)
         + (SELECT COALESCE(SUM(size), 0) FROM page_versions WHERE owner_id = u.id) AS storage_used,
       (SELECT COUNT(*) FROM files WHERE owner_id = u.id) AS files,
       (SELECT COUNT(*) FROM comments WHERE author_id = u.id) AS comments,
       (SELECT COALESCE(SUM(requests), 0) FROM usage_hourly WHERE user_id = u.id AND hour > ?1 - 24) AS requests_24h,
       (SELECT COALESCE(SUM(requests), 0) FROM usage_hourly WHERE user_id = u.id AND hour > ?1 - 24 * 7) AS requests_7d,
       (SELECT COALESCE(SUM(requests), 0) FROM usage_hourly WHERE user_id = u.id AND hour > ?1 - 24 * 30) AS requests_30d,
       (SELECT COALESCE(SUM(errors), 0) FROM usage_hourly WHERE user_id = u.id AND hour > ?1 - 24) AS errors_24h,
       (SELECT COALESCE(SUM(bytes_in), 0) FROM usage_hourly WHERE user_id = u.id AND hour > ?1 - 24) AS bytes_in_24h,
       (SELECT COALESCE(SUM(bytes_out), 0) FROM usage_hourly WHERE user_id = u.id AND hour > ?1 - 24) AS bytes_out_24h,
       (SELECT COALESCE(MAX(requests), 0) FROM usage_hourly WHERE user_id = u.id AND hour > ?1 - 24) AS peak_hour,
       (SELECT MAX(hour) FROM usage_hourly WHERE user_id = u.id) AS last_hour
     FROM users u ORDER BY requests_24h DESC, u.created_at`
  )
    .bind(hour)
    .all<Omit<UserUsage, 'grants' | 'last_active'> & { last_hour: number | null }>();
  const { results: grantRows } = await env.DB.prepare(
    `SELECT g.user_id, g.storage_id, s.name AS storage_name, g.limit_bytes FROM storage_grants g JOIN storages s ON s.id = g.storage_id ORDER BY s.name`
  ).all<{ user_id: string; storage_id: string; storage_name: string; limit_bytes: number | null }>();
  const users = [];
  for (const { last_hour, ...rest } of results) {
    const grants = [];
    for (const g of grantRows.filter((r) => r.user_id === rest.id)) {
      grants.push({ storage_name: g.storage_name, limit_bytes: g.limit_bytes, used: await sharedUsage(env, g.storage_id, rest.id) });
    }
    users.push({ ...rest, grants, last_active: last_hour == null ? null : Math.min(now, (last_hour + 1) * HOUR) });
  }
  const series = await env.DB.prepare(
    `SELECT hour, SUM(requests) AS requests, SUM(errors) AS errors FROM usage_hourly WHERE hour > ? - 24 GROUP BY hour ORDER BY hour`
  )
    .bind(hour)
    .all<{ hour: number; requests: number; errors: number }>();
  return json({
    now,
    hour,
    users,
    series: series.results,
    // Cloudflare's free plan: 100,000 Worker requests per day. Only signed-in API calls are counted here.
    dailyLimit: 100_000,
  });
}
