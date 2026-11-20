import { hashPassword, requireAdmin, requireUser, type User, verifyPassword } from './auth.js';
import type { Env } from './env.js';
import { HttpError, json, newId, noContent, randomToken, readJson, str } from './http.js';
import { storageById, usage, WebDav } from './storage.js';

// ---------- storages (owned by a user; managed by them or an admin) ----------

/** `me`, or someone else's id when the caller is an admin. */
function targetUser(user: User | null, uid: string): string {
  const u = requireUser(user);
  if (uid === 'me' || uid === u.id) return u.id;
  requireAdmin(u);
  return uid;
}

async function ownedStorage(env: Env, user: User | null, sid: string) {
  const u = requireUser(user);
  const s = await storageById(env, sid);
  if (!s || (s.user_id !== u.id && u.role !== 'admin')) throw new HttpError(404, 'no such storage');
  return s;
}

function cleanUrl(v: unknown): string {
  const raw = str(v, 'WebDAV URL', 500);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'the WebDAV URL is not valid');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'the WebDAV URL must start with https://');
  if (u.username || u.password) throw new HttpError(400, 'put the username and password in their own fields, not in the URL');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** What clients see: never the password. */
const publicStorage = (s: { id: string; name: string; url: string; username: string; password: string }) => ({
  id: s.id,
  name: s.name,
  url: s.url,
  username: s.username,
  hasPassword: !!s.password,
});

export async function listStorages(env: Env, user: User | null, uid: string): Promise<Response> {
  const owner = targetUser(user, uid);
  const { results } = await env.DB.prepare('SELECT id, name, url, username, password FROM storages WHERE user_id = ? ORDER BY created_at')
    .bind(owner)
    .all<{ id: string; name: string; url: string; username: string; password: string }>();
  return json(results.map(publicStorage));
}

interface StorageInput {
  name?: string;
  url?: string;
  username?: string;
  password?: string;
}

export async function createStorage(req: Request, env: Env, user: User | null, uid: string): Promise<Response> {
  const owner = targetUser(user, uid);
  const b = await readJson<StorageInput>(req);
  const row = {
    id: newId(),
    name: str(b.name, 'name', 80),
    url: cleanUrl(b.url),
    username: typeof b.username === 'string' ? b.username.trim() : '',
    password: typeof b.password === 'string' ? b.password : '',
  };
  await env.DB.prepare('INSERT INTO storages (id, user_id, name, url, username, password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, owner, row.name, row.url, row.username, row.password, Date.now())
    .run();
  // The first storage becomes the default, so uploads work right away.
  await env.DB.prepare('UPDATE users SET default_storage_id = ? WHERE id = ? AND default_storage_id IS NULL').bind(row.id, owner).run();
  return json(publicStorage(row), 201);
}

/** A blank password keeps the stored one. */
export async function updateStorage(req: Request, env: Env, user: User | null, sid: string): Promise<Response> {
  const s = await ownedStorage(env, user, sid);
  const b = await readJson<StorageInput>(req);
  const next = {
    name: b.name !== undefined ? str(b.name, 'name', 80) : s.name,
    url: b.url !== undefined ? cleanUrl(b.url) : s.url,
    username: typeof b.username === 'string' ? b.username.trim() : s.username,
    password: typeof b.password === 'string' && b.password !== '' ? b.password : s.password,
  };
  await env.DB.prepare('UPDATE storages SET name = ?, url = ?, username = ?, password = ? WHERE id = ?')
    .bind(next.name, next.url, next.username, next.password, sid)
    .run();
  return json(publicStorage({ id: sid, ...next }));
}

/** Refused while files or history still live there; they'd become unreadable. */
export async function deleteStorage(env: Env, user: User | null, sid: string): Promise<Response> {
  await ownedStorage(env, user, sid);
  const used = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM files WHERE storage_id = ?) + (SELECT COUNT(*) FROM page_versions WHERE storage_id = ?) AS n`
  )
    .bind(sid, sid)
    .first<{ n: number }>();
  if (used && used.n > 0) {
    throw new HttpError(409, `${used.n} file(s) and version(s) are stored here; delete them first or keep this storage`);
  }
  await env.DB.prepare('DELETE FROM storages WHERE id = ?').bind(sid).run();
  return noContent();
}

/** Tests saved settings, or settings typed in the form (blank password = the saved one). */
export async function testStorage(req: Request, env: Env, user: User | null, sid: string | null): Promise<Response> {
  requireUser(user);
  const b = await readJson<StorageInput>(req);
  const saved = sid ? await ownedStorage(env, user, sid) : null;
  const target = {
    id: saved?.id ?? 'test',
    url: b.url !== undefined ? cleanUrl(b.url) : (saved?.url ?? cleanUrl(undefined)),
    username: typeof b.username === 'string' ? b.username.trim() : (saved?.username ?? ''),
    password: typeof b.password === 'string' && b.password !== '' ? b.password : (saved?.password ?? ''),
  };
  return json(await new WebDav(target).check());
}

async function requireOwnStorage(env: Env, owner: string, storageId: string): Promise<void> {
  const s = await storageById(env, storageId);
  if (!s || s.user_id !== owner) throw new HttpError(400, 'that storage belongs to someone else');
}

export async function setDefaultStorage(req: Request, env: Env, user: User | null, uid: string): Promise<Response> {
  const owner = targetUser(user, uid);
  const { storageId = null } = await readJson<{ storageId?: string | null }>(req);
  if (storageId) await requireOwnStorage(env, owner, storageId);
  await env.DB.prepare('UPDATE users SET default_storage_id = ? WHERE id = ?').bind(storageId, owner).run();
  return noContent();
}

/** A user's storage for one workspace (null = use their default). */
export async function setWorkspaceStorage(req: Request, env: Env, user: User | null, uid: string, wid: string): Promise<Response> {
  const owner = targetUser(user, uid);
  const member = await env.DB.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').bind(wid, owner).first();
  if (!member) throw new HttpError(404, 'not a member of that workspace');
  const { storageId = null } = await readJson<{ storageId?: string | null }>(req);
  if (!storageId) {
    await env.DB.prepare('DELETE FROM workspace_storage WHERE workspace_id = ? AND user_id = ?').bind(wid, owner).run();
    return noContent();
  }
  await requireOwnStorage(env, owner, storageId);
  await env.DB.prepare(
    `INSERT INTO workspace_storage (workspace_id, user_id, storage_id) VALUES (?, ?, ?)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET storage_id = excluded.storage_id`
  )
    .bind(wid, owner, storageId)
    .run();
  return noContent();
}

// ---------- the signed-in user's settings ----------

export async function getSettings(env: Env, user: User | null): Promise<Response> {
  const u = requireUser(user);
  const row = await env.DB.prepare('SELECT storage_limit, default_storage_id FROM users WHERE id = ?')
    .bind(u.id)
    .first<{ storage_limit: number | null; default_storage_id: string | null }>();
  const { results: workspaces } = await env.DB.prepare(
    `SELECT w.id, w.name, ws.storage_id FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     LEFT JOIN workspace_storage ws ON ws.workspace_id = w.id AND ws.user_id = m.user_id
     WHERE m.user_id = ? ORDER BY w.created_at`
  )
    .bind(u.id)
    .all();
  const { results: storages } = await env.DB.prepare(
    'SELECT id, name, url, username, password FROM storages WHERE user_id = ? ORDER BY created_at'
  )
    .bind(u.id)
    .all<{ id: string; name: string; url: string; username: string; password: string }>();
  return json({
    user: u,
    usage: await usage(env, u.id),
    storageLimit: row?.storage_limit ?? null,
    defaultStorageId: row?.default_storage_id ?? null,
    storages: storages.map(publicStorage),
    workspaces,
  });
}

export async function updateProfile(req: Request, env: Env, user: User | null): Promise<Response> {
  const u = requireUser(user);
  const b = await readJson<{ name?: string; currentPassword?: string; newPassword?: string }>(req);
  if (b.name !== undefined) await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(str(b.name, 'name', 80), u.id).run();
  if (b.newPassword !== undefined) {
    if (b.newPassword.length < 8) throw new HttpError(400, 'password must be at least 8 characters');
    const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(u.id).first<{ password_hash: string }>();
    if (!row || !(await verifyPassword(row.password_hash, b.currentPassword ?? ''))) {
      throw new HttpError(403, 'current password is wrong');
    }
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(env, b.newPassword), u.id).run();
  }
  return noContent();
}

// ---------- admin: users and registration links ----------

export async function adminListUsers(env: Env, user: User | null): Promise<Response> {
  requireAdmin(user);
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.can_create_workspaces, u.storage_limit, u.disabled, u.created_at,
            u.default_storage_id, s.name AS default_storage_name,
            (SELECT COALESCE(SUM(size), 0) FROM files WHERE owner_id = u.id)
              + (SELECT COALESCE(SUM(size), 0) FROM page_versions WHERE owner_id = u.id) AS usage
     FROM users u LEFT JOIN storages s ON s.id = u.default_storage_id
     ORDER BY u.created_at`
  ).all();
  return json(results);
}

interface UserInput {
  email?: string;
  name?: string;
  password?: string;
  role?: string;
  canCreateWorkspaces?: boolean;
  storageLimit?: number | null;
  disabled?: boolean;
}

const roleOf = (v: unknown): 'admin' | 'member' => (v === 'admin' ? 'admin' : 'member');
function limitOf(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'storage limit must be a positive number of bytes');
  return n;
}

export async function adminCreateUser(req: Request, env: Env, user: User | null): Promise<Response> {
  requireAdmin(user);
  const b = await readJson<UserInput>(req);
  const email = str(b.email, 'email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'invalid email');
  const name = str(b.name, 'name', 80);
  const password = typeof b.password === 'string' ? b.password : '';
  if (password.length < 8) throw new HttpError(400, 'password must be at least 8 characters');
  if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) {
    throw new HttpError(409, 'an account with this email already exists');
  }
  const id = newId();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, name, password_hash, role, can_create_workspaces, storage_limit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, email, name, await hashPassword(env, password), roleOf(b.role), b.canCreateWorkspaces === false ? 0 : 1, limitOf(b.storageLimit), Date.now()),
    // Workspaces that invited this email before the account existed.
    env.DB.prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, role) SELECT workspace_id, ?, role FROM workspace_invites WHERE email = ?'
    ).bind(id, email),
    env.DB.prepare('DELETE FROM workspace_invites WHERE email = ?').bind(email),
  ]);
  return json({ id }, 201);
}

async function otherAdmins(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function adminUpdateUser(req: Request, env: Env, user: User | null, uid: string): Promise<Response> {
  const admin = requireAdmin(user);
  const target = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(uid).first<{ id: string; role: string }>();
  if (!target) throw new HttpError(404, 'no such user');
  const b = await readJson<UserInput>(req);
  const losesAdmin = (b.role !== undefined && roleOf(b.role) !== 'admin') || b.disabled === true;
  if (target.role === 'admin' && losesAdmin && (await otherAdmins(env, uid)) === 0) {
    throw new HttpError(409, 'there must be at least one active admin');
  }
  if (uid === admin.id && b.disabled === true) throw new HttpError(409, "you can't disable your own account");
  const sets: string[] = [];
  const args: unknown[] = [];
  if (b.name !== undefined) sets.push('name = ?'), args.push(str(b.name, 'name', 80));
  if (b.role !== undefined) sets.push('role = ?'), args.push(roleOf(b.role));
  if (b.canCreateWorkspaces !== undefined) sets.push('can_create_workspaces = ?'), args.push(b.canCreateWorkspaces ? 1 : 0);
  if ('storageLimit' in b) sets.push('storage_limit = ?'), args.push(limitOf(b.storageLimit));
  if (b.disabled !== undefined) sets.push('disabled = ?'), args.push(b.disabled ? 1 : 0);
  if (b.password !== undefined) {
    if (b.password.length < 8) throw new HttpError(400, 'password must be at least 8 characters');
    sets.push('password_hash = ?'), args.push(await hashPassword(env, b.password));
  }
  if (sets.length) await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...args, uid).run();
  // Signing out a disabled user, or anyone whose password was reset.
  if (b.disabled === true || b.password !== undefined) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(uid).run();
  return noContent();
}

/**
 * Deletes an account that owns nothing. Someone who owns workspaces or has
 * files in their storages should be disabled instead, which keeps it all readable.
 */
export async function adminDeleteUser(env: Env, user: User | null, uid: string): Promise<Response> {
  const admin = requireAdmin(user);
  if (uid === admin.id) throw new HttpError(409, "you can't delete your own account");
  const owns = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM workspace_members WHERE user_id = ? AND role = 'owner')
          + (SELECT COUNT(*) FROM files WHERE owner_id = ?) + (SELECT COUNT(*) FROM page_versions WHERE owner_id = ?) AS n`
  )
    .bind(uid, uid, uid)
    .first<{ n: number }>();
  if (owns && owns.n > 0) throw new HttpError(409, 'this user owns workspaces or stored files; disable the account instead');
  const target = await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(uid).first<{ role: string }>();
  if (!target) throw new HttpError(404, 'no such user');
  if (target.role === 'admin' && (await otherAdmins(env, uid)) === 0) throw new HttpError(409, 'there must be at least one active admin');
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(uid).run();
  return noContent();
}

export async function adminListLinks(env: Env, user: User | null): Promise<Response> {
  requireAdmin(user);
  const { results } = await env.DB.prepare(
    `SELECT l.token, l.email, l.role, l.created_at, l.expires_at, l.used_at, u.name AS used_by_name
     FROM registration_links l LEFT JOIN users u ON u.id = l.used_by ORDER BY l.created_at DESC LIMIT 100`
  ).all();
  return json(results);
}

export async function adminCreateLink(req: Request, env: Env, user: User | null): Promise<Response> {
  const admin = requireAdmin(user);
  const b = await readJson<{ email?: string; role?: string; expiresInDays?: number | null }>(req);
  const email = typeof b.email === 'string' && b.email.trim() ? b.email.trim().toLowerCase() : null;
  const days = Number(b.expiresInDays);
  const expiresAt = days > 0 ? Date.now() + Math.min(days, 365) * 86_400_000 : null;
  const token = randomToken(24);
  await env.DB.prepare(
    'INSERT INTO registration_links (token, email, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(token, email, roleOf(b.role), admin.id, Date.now(), expiresAt)
    .run();
  return json({ token, email, role: roleOf(b.role), expires_at: expiresAt }, 201);
}

export async function adminDeleteLink(env: Env, user: User | null, token: string): Promise<Response> {
  requireAdmin(user);
  await env.DB.prepare('DELETE FROM registration_links WHERE token = ?').bind(token).run();
  return noContent();
}
