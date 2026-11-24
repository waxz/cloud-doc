import type { Env } from './env.js';
import { cookie, getCookie, HttpError, json, newId, randomToken, readJson, sha256Hex, str } from './http.js';
import { signupAllowed } from './ratelimit.js';

export interface User {
  id: string;
  email: string;
  name: string;
  /** Instance role: the first account is the admin; admins manage users. */
  role: 'admin' | 'member';
}

const SESSION_COOKIE = 'wiki_session';
const SESSION_TTL = 30 * 24 * 3600; // seconds
const MAX_FAILURES = 10;
const FAILURE_WINDOW = 15 * 60 * 1000;
const DEFAULT_ITERATIONS = 50_000; // ~5 ms of CPU: fits the Free plan's 10 ms per request
const MAX_ITERATIONS = 100_000; // the most Workers' PBKDF2 accepts

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** `pbkdf2-sha256$<iterations>$<salt>$<hash>`: the count is stored so it can be raised later. */
export async function hashPassword(env: Env, password: string): Promise<string> {
  const iterations = Math.min(MAX_ITERATIONS, Number(env.PASSWORD_ITERATIONS) || DEFAULT_ITERATIONS);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(await pbkdf2(password, salt, iterations))}`;
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2-sha256' || !iter || !salt || !hash) return false;
  const got = await pbkdf2(password, unb64(salt), Number(iter));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i]! ^ want[i]!;
  return diff === 0;
}

// Hash checked for unknown emails, so a miss costs the same as a wrong password.
const DUMMY_HASH = `pbkdf2-sha256$${DEFAULT_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;

async function startSession(env: Env, userId: string): Promise<string> {
  const token = randomToken(32);
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), userId, Date.now() + SESSION_TTL * 1000)
    .run();
  return cookie(SESSION_COOKIE, token, SESSION_TTL);
}

export async function currentUser(req: Request, env: Env): Promise<User | null> {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;
  return env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ? AND u.disabled = 0`
  )
    .bind(await sha256Hex(token), Date.now())
    .first<User>();
}

export function requireUser(user: User | null): User {
  if (!user) throw new HttpError(401, 'sign in required');
  return user;
}

export function requireAdmin(user: User | null): User {
  const u = requireUser(user);
  if (u.role !== 'admin') throw new HttpError(403, 'admins only');
  return u;
}

async function me(env: Env, user: User): Promise<Response> {
  const flags = await env.DB.prepare('SELECT can_create_workspaces FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ can_create_workspaces: number }>();
  const { results } = await env.DB.prepare(
    `SELECT w.id, w.name, m.role,
            (SELECT u.name FROM workspace_members om JOIN users u ON u.id = om.user_id
             WHERE om.workspace_id = w.id AND om.role = 'owner' LIMIT 1) AS owner_name
     FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = ? ORDER BY w.created_at`
  )
    .bind(user.id)
    .all<{ id: string; name: string; role: 'owner' | 'admin' | 'member'; owner_name: string | null }>();
  const workspaces = results.map((w) => ({
    id: w.id,
    name: w.name,
    displayName: `${w.owner_name ?? 'User'}'s ${w.name}`,
    ownerName: w.owner_name ?? '',
    role: w.role,
  }));
  return json({ user, canCreateWorkspaces: !!flags?.can_create_workspaces, workspaces });
}

/** Whether the instance still needs its first (admin) account. */
async function needsSetup(env: Env): Promise<boolean> {
  return !(await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first());
}

/** Recovery mode needs a long secret; anything shorter counts as not set. */
export const recoveryEnabled = (env: Env) => (env.RECOVERY_SECRET ?? '').length >= 16;

export async function getAppSetting(env: Env, key: string): Promise<string> {
  return (await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? '';
}

/**
 * Open registration (a limited playground): on when the admin has switched it on, picked the workspace new accounts
 * join, and the optional cap on accounts is not reached. Returns that workspace's id.
 */
async function openSignupWorkspace(env: Env): Promise<string | null> {
  if ((await getAppSetting(env, 'open_registration')) !== '1') return null;
  const wid = await getAppSetting(env, 'playground_workspace');
  if (!wid || !(await env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(wid).first())) return null;
  const cap = Number(await getAppSetting(env, 'playground_max_users'));
  if (cap > 0 && ((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n ?? 0) >= cap) return null;
  return wid;
}

/** What the sign-in page needs before anyone is signed in: the admin's contact email, recovery mode, and open registration. */
export async function authStatus(env: Env): Promise<Response> {
  return json({
    setup: await needsSetup(env),
    adminEmail: await getAppSetting(env, 'admin_email'),
    recovery: recoveryEnabled(env),
    openSignup: !!(await openSignupWorkspace(env)),
  });
}

/** Constant-time comparison of two secrets (both are hashed first, so length doesn't leak either). */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

const RECOVERY_KEY = '__recovery__';

/**
 * Recovery mode: with the RECOVERY_SECRET of the Worker, set a new password for an admin account and sign in as it.
 * For when the admin has forgotten their password and nobody else can reset it. Tries are limited (5 wrong secrets, then
 * 15 minutes' wait), all sessions of the account are ended, and the use is written to the log.
 */
export async function recover(req: Request, env: Env): Promise<Response> {
  if (!recoveryEnabled(env)) throw new HttpError(404, 'recovery mode is not enabled: set a RECOVERY_SECRET of at least 16 characters in the Cloudflare dashboard');
  const body = await readJson<{ secret?: string; email?: string; newPassword?: string }>(req);
  const now = Date.now();
  const fails = await env.DB.prepare('SELECT count, window_start FROM login_failures WHERE email = ?')
    .bind(RECOVERY_KEY)
    .first<{ count: number; window_start: number }>();
  if (fails && now - fails.window_start < FAILURE_WINDOW && fails.count >= 5) {
    throw new HttpError(429, 'too many wrong recovery secrets; try again in 15 minutes');
  }
  if (!(await sameSecret(typeof body.secret === 'string' ? body.secret : '', env.RECOVERY_SECRET!))) {
    await env.DB.prepare(
      `INSERT INTO login_failures (email, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT (email) DO UPDATE SET
         count = CASE WHEN ? - window_start < ? THEN count + 1 ELSE 1 END,
         window_start = CASE WHEN ? - window_start < ? THEN window_start ELSE excluded.window_start END`
    )
      .bind(RECOVERY_KEY, now, now, FAILURE_WINDOW, now, FAILURE_WINDOW)
      .run();
    throw new HttpError(401, 'wrong recovery secret');
  }
  const password = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (password.length < 8) throw new HttpError(400, 'the new password must be at least 8 characters');
  const wanted = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const { results: admins } = await env.DB.prepare("SELECT id, email, name, role FROM users WHERE role = 'admin' ORDER BY created_at").all<User>();
  const target = wanted ? admins.find((a) => a.email.toLowerCase() === wanted) : admins.length === 1 ? admins[0] : undefined;
  if (!target) {
    throw new HttpError(wanted ? 404 : 400, wanted ? 'no admin account has that email' : admins.length ? 'there are several admins: enter the email of the one to recover' : 'there is no admin account');
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, disabled = 0 WHERE id = ?').bind(await hashPassword(env, password), target.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id),
    env.DB.prepare('DELETE FROM login_failures WHERE email IN (?, ?)').bind(RECOVERY_KEY, target.email.toLowerCase()),
  ]);
  console.warn(`recovery mode used: password reset for admin ${target.id}`);
  const res = await me(env, target);
  res.headers.append('set-cookie', await startSession(env, target.id));
  return res;
}

interface RegistrationLink {
  token: string;
  email: string | null;
  role: 'admin' | 'member';
  workspace_id: string | null;
  workspace_role: string;
  storage_id: string | null;
  limit_bytes: number | null;
  workspace_name?: string | null;
  storage_name?: string | null;
}

async function validLink(env: Env, token: string): Promise<RegistrationLink | null> {
  return env.DB.prepare(
    `SELECT l.token, l.email, l.role, l.workspace_id, l.workspace_role, l.storage_id, l.limit_bytes,
            w.name AS workspace_name, s.name AS storage_name
     FROM registration_links l
     LEFT JOIN workspaces w ON w.id = l.workspace_id
     LEFT JOIN storages s ON s.id = l.storage_id AND s.shared = 1
     WHERE l.token = ? AND l.used_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > ?)`
  )
    .bind(token, Date.now())
    .first<RegistrationLink>();
}

/** What a registration link page needs to show (no secrets). */
export async function registrationInfo(env: Env, token: string): Promise<Response> {
  const link = await validLink(env, token);
  if (!link) throw new HttpError(404, 'this registration link has expired or was already used');
  return json({ email: link.email, workspace: link.workspace_name ?? null, storage: link.storage_name ?? null });
}

/**
 * Sign-up is open only for the very first account (which becomes the
 * admin). After that it needs a registration link from an admin.
 */
export async function signup(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ email?: string; name?: string; password?: string; token?: string }>(req);
  const first = await needsSetup(env);
  const link = first ? null : body.token ? await validLink(env, body.token) : null;
  // No link: open registration, if the admin switched it on for a playground.
  const playground = !first && !link ? await openSignupWorkspace(env) : null;
  if (!first && !link && !playground) {
    throw new HttpError(403, (await getAppSetting(env, 'open_registration')) === '1' ? 'the playground is full or closed for now' : 'sign-up needs a registration link from an admin');
  }
  if (playground && !signupAllowed(req)) throw new HttpError(429, 'too many accounts were created from your address: try again later');
  const email = str(body.email, 'email').toLowerCase();
  if (link?.email && link.email.toLowerCase() !== email) throw new HttpError(400, `this link is for ${link.email}`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'invalid email');
  const name = str(body.name, 'name', 80);
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 8) throw new HttpError(400, 'password must be at least 8 characters');
  if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) {
    throw new HttpError(409, 'an account with this email already exists');
  }
  const user: User = { id: newId(), email, name, role: first ? 'admin' : (link?.role ?? 'member') };
  // A link works once: claim it atomically before creating the account.
  if (link) {
    const claimed = await env.DB.prepare(
      'UPDATE registration_links SET used_at = ? WHERE token = ? AND used_at IS NULL RETURNING token'
    )
      .bind(Date.now(), link.token)
      .first();
    if (!claimed) throw new HttpError(409, 'this registration link was just used');
  }
  try {
    await env.DB.batch([
      // Playground accounts are plain members who can't make workspaces of their own: they use the one they joined.
      env.DB.prepare('INSERT INTO users (id, email, name, password_hash, role, can_create_workspaces, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
        user.id,
        email,
        name,
        await hashPassword(env, password),
        user.role,
        playground ? 0 : 1,
        Date.now()
      ),
      ...(playground
        ? [env.DB.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')").bind(playground, user.id)]
        : []),
      // Workspaces that invited this email before the account existed.
      env.DB.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
         SELECT workspace_id, ?, role FROM workspace_invites WHERE email = ?`
      ).bind(user.id, email),
      env.DB.prepare('DELETE FROM workspace_invites WHERE email = ?').bind(email),
      ...(link ? [env.DB.prepare('UPDATE registration_links SET used_by = ? WHERE token = ?').bind(user.id, link.token)] : []),
      // What the link allocates: a place in a workspace, and a shared storage with a limit.
      ...(link?.workspace_id
        ? [
            env.DB.prepare(
              `INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role)
               SELECT id, ?, ? FROM workspaces WHERE id = ?`
            ).bind(user.id, link.workspace_role === 'admin' ? 'admin' : 'member', link.workspace_id),
          ]
        : []),
      ...(link?.storage_id
        ? [
            env.DB.prepare(
              `INSERT OR IGNORE INTO storage_grants (storage_id, user_id, limit_bytes, created_at)
               SELECT id, ?, ?, ? FROM storages WHERE id = ? AND shared = 1`
            ).bind(user.id, link.limit_bytes, Date.now(), link.storage_id),
          ]
        : []),
    ]);
  } catch (err) {
    // Give the link back if the account couldn't be created.
    if (link) await env.DB.prepare('UPDATE registration_links SET used_at = NULL WHERE token = ?').bind(link.token).run();
    throw err;
  }
  const res = await me(env, user);
  res.headers.append('set-cookie', await startSession(env, user.id));
  return new Response(res.body, { status: 201, headers: res.headers });
}

export async function login(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ email?: string; password?: string }>(req);
  const email = str(body.email, 'email').toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const now = Date.now();
  const fails = await env.DB.prepare('SELECT count, window_start FROM login_failures WHERE email = ?')
    .bind(email)
    .first<{ count: number; window_start: number }>();
  if (fails && now - fails.window_start < FAILURE_WINDOW && fails.count >= MAX_FAILURES) {
    throw new HttpError(429, 'too many failed sign-ins; try again in 15 minutes');
  }
  const row = await env.DB.prepare('SELECT id, email, name, role, password_hash, disabled FROM users WHERE email = ?')
    .bind(email)
    .first<User & { password_hash: string; disabled: number }>();
  const ok = await verifyPassword(row?.password_hash ?? DUMMY_HASH, password);
  if (!row || !ok) {
    await env.DB.prepare(
      `INSERT INTO login_failures (email, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT (email) DO UPDATE SET
         count = CASE WHEN ? - window_start < ? THEN count + 1 ELSE 1 END,
         window_start = CASE WHEN ? - window_start < ? THEN window_start ELSE excluded.window_start END`
    )
      .bind(email, now, now, FAILURE_WINDOW, now, FAILURE_WINDOW)
      .run();
    throw new HttpError(401, 'wrong email or password');
  }
  await env.DB.prepare('DELETE FROM login_failures WHERE email = ?').bind(email).run();
  if (row.disabled) throw new HttpError(403, 'this account is disabled');
  const user: User = { id: row.id, email: row.email, name: row.name, role: row.role };
  const res = await me(env, user);
  res.headers.append('set-cookie', await startSession(env, user.id));
  return res;
}

export async function logout(req: Request, env: Env): Promise<Response> {
  const token = getCookie(req, SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token)).run();
  return new Response(null, { status: 204, headers: { 'set-cookie': cookie(SESSION_COOKIE, '', 0) } });
}

export async function getMe(env: Env, user: User | null): Promise<Response> {
  return me(env, requireUser(user));
}
