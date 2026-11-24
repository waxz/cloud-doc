import { sealPassword } from './secret.js';
import { getAppSetting, hashPassword, recoveryEnabled, requireAdmin, requireUser, type User, verifyPassword } from './auth.js';
import { forgetRateLimits } from './ratelimit.js';
import type { Env } from './env.js';
import { HttpError, json, newId, noContent, randomToken, readJson, str } from './http.js';
import { cleanPath, joinUrl, probeStorage, sharedUsage, splitUrl, storageById, usage, WebDav } from './storage.js';

// ---------- storages ----------
// A user manages only their own storages. The admin shares storages of their own with chosen users, each
// with a limit (see "shared storages" below); a user can build workspaces on those without owning them.

/** Only the signed-in user's own storages. (Nobody sets up another person's storage, admins included.) */
function ownerOnly(user: User | null, uid: string): string {
  const u = requireUser(user);
  if (uid === 'me' || uid === u.id) return u.id;
  throw new HttpError(403, 'storages are set up by their owners; an admin can share a storage of their own instead');
}

async function ownedStorage(env: Env, user: User | null, sid: string) {
  const u = requireUser(user);
  const s = await storageById(env, sid);
  if (!s || s.user_id !== u.id || s.shared) throw new HttpError(404, 'no such storage');
  return s;
}

/** A storage the user can build or use workspaces on: one of their own, or a shared one allocated to them. */
export async function usableStorage(env: Env, userId: string, storageId: string) {
  const s = await storageById(env, storageId);
  if (!s) return null;
  if (s.user_id === userId && !s.shared) return s;
  if (s.shared && (await env.DB.prepare('SELECT 1 FROM storage_grants WHERE storage_id = ? AND user_id = ?').bind(storageId, userId).first())) return s;
  return null;
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
const publicStorage = (s: { id: string; name: string; url: string; username: string; password: string; root_path?: string }) => ({
  id: s.id,
  name: s.name,
  url: s.url,
  ...splitUrl(s.url, s.root_path ?? ''),
  username: s.username,
  hasPassword: !!s.password,
});

export async function listStorages(env: Env, user: User | null, uid: string): Promise<Response> {
  const owner = ownerOnly(user, uid);
  const { results } = await env.DB.prepare('SELECT id, name, url, username, password, root_path FROM storages WHERE user_id = ? AND shared = 0 ORDER BY created_at')
    .bind(owner)
    .all<{ id: string; name: string; url: string; username: string; password: string; root_path: string }>();
  return json(results.map(publicStorage));
}

interface StorageInput {
  name?: string;
  /** The whole address as one piece (older clients); `baseUrl` + `path` is the way to also have the folder created. */
  url?: string;
  baseUrl?: string;
  path?: string;
  /** With a test: make the folder if it doesn't exist. */
  create?: boolean;
  username?: string;
  password?: string;
}

/** Where a storage points: server URL + folder path (or one whole URL), falling back to what's saved. */
function addressOf(b: StorageInput, saved?: { url: string; root_path?: string }): { url: string; rootPath: string; split: boolean } {
  if (b.baseUrl !== undefined || b.path !== undefined) {
    const cur = saved ? splitUrl(saved.url, saved.root_path ?? '') : { baseUrl: '', path: '' };
    const parts = cleanPath(b.path ?? cur.path);
    return { url: joinUrl(cleanUrl(b.baseUrl ?? cur.baseUrl), parts), rootPath: parts.join('/'), split: true };
  }
  if (b.url !== undefined) return { url: cleanUrl(b.url), rootPath: '', split: false };
  if (saved) return { url: saved.url, rootPath: saved.root_path ?? '', split: false };
  return { url: cleanUrl(undefined), rootPath: '', split: false };
}

/** Before saving an address that has a folder path: the server must answer and the folder is created if missing. */
async function prepareFolder(a: { url: string; rootPath: string; split: boolean }, username: string, password: string): Promise<void> {
  if (!a.split || !a.rootPath) return;
  const r = await probeStorage({ id: 'new', url: a.url, username, password }, a.rootPath, true);
  if (!r.ok) throw new HttpError(400, `can't use this storage: ${r.message}`);
}

export async function createStorage(req: Request, env: Env, user: User | null, uid: string): Promise<Response> {
  const owner = ownerOnly(user, uid);
  const b = await readJson<StorageInput>(req);
  const addr = addressOf(b);
  const row = {
    id: newId(),
    name: str(b.name, 'name', 80),
    url: addr.url,
    root_path: addr.rootPath,
    username: typeof b.username === 'string' ? b.username.trim() : '',
    password: typeof b.password === 'string' ? b.password : '',
  };
  await prepareFolder(addr, row.username, row.password);
  await env.DB.prepare('INSERT INTO storages (id, user_id, name, url, root_path, username, password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, owner, row.name, row.url, row.root_path, row.username, await sealPassword(row.password), Date.now())
    .run();
  // The first storage becomes the default, so uploads work right away.
  await env.DB.prepare('UPDATE users SET default_storage_id = ? WHERE id = ? AND default_storage_id IS NULL').bind(row.id, owner).run();
  return json(publicStorage(row), 201);
}

/** A blank password keeps the stored one. */
export async function updateStorage(req: Request, env: Env, user: User | null, sid: string): Promise<Response> {
  const s = await ownedStorage(env, user, sid);
  const b = await readJson<StorageInput>(req);
  const addr = addressOf(b, s);
  const next = {
    name: b.name !== undefined ? str(b.name, 'name', 80) : s.name,
    url: addr.url,
    root_path: addr.rootPath,
    username: typeof b.username === 'string' ? b.username.trim() : s.username,
    password: typeof b.password === 'string' && b.password !== '' ? await sealPassword(b.password) : s.password,
  };
  await prepareFolder(addr, next.username, typeof b.password === 'string' && b.password !== '' ? b.password : s.password);
  await env.DB.prepare('UPDATE storages SET name = ?, url = ?, root_path = ?, username = ?, password = ? WHERE id = ?')
    .bind(next.name, next.url, next.root_path, next.username, next.password, sid)
    .run();
  return json(publicStorage({ id: sid, ...next }));
}

/** Refused while files or history still live there; they'd become unreadable. */
export async function deleteStorage(env: Env, user: User | null, sid: string): Promise<Response> {
  await ownedStorage(env, user, sid);
  return deleteStorageRow(env, sid);
}

async function deleteStorageRow(env: Env, sid: string): Promise<Response> {
  const bindings = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM workspace_storage_bindings WHERE storage_id = ?'
  ).bind(sid).first<{ n: number }>();
  if (bindings && bindings.n > 0) {
    throw new HttpError(409, `this storage is bound to ${bindings.n} workspace(s); unbind it first`);
  }
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
  const addr = addressOf(b, saved ?? undefined);
  const target = {
    id: saved?.id ?? 'test',
    url: addr.url,
    username: typeof b.username === 'string' ? b.username.trim() : (saved?.username ?? ''),
    password: typeof b.password === 'string' && b.password !== '' ? b.password : (saved?.password ?? ''),
  };
  return json(await probeStorage(target, addr.rootPath, b.create === true));
}

async function requireOwnStorage(env: Env, owner: string, storageId: string): Promise<void> {
  if (!(await usableStorage(env, owner, storageId))) throw new HttpError(400, 'that storage is not yours and was not shared with you');
}

export async function setDefaultStorage(req: Request, env: Env, user: User | null, uid: string): Promise<Response> {
  const owner = ownerOnly(user, uid);
  const { storageId = null } = await readJson<{ storageId?: string | null }>(req);
  if (storageId) await requireOwnStorage(env, owner, storageId);
  await env.DB.prepare('UPDATE users SET default_storage_id = ? WHERE id = ?').bind(storageId, owner).run();
  return noContent();
}

/** A user's storage for one workspace (null = use their default). */
export async function setWorkspaceStorage(req: Request, env: Env, user: User | null, uid: string, wid: string): Promise<Response> {
  const owner = ownerOnly(user, uid);
  const member = await env.DB.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').bind(wid, owner).first();
  if (!member) throw new HttpError(404, 'not a member of that workspace');
  const { storageId = null } = await readJson<{ storageId?: string | null }>(req);
  if (!storageId) {
    await env.DB.prepare('DELETE FROM workspace_storage WHERE workspace_id = ? AND user_id = ?').bind(wid, owner).run();
    return noContent();
  }
  const bound = await env.DB.prepare(
    'SELECT 1 FROM workspace_storage_bindings WHERE workspace_id = ? AND storage_id = ?'
  ).bind(wid, storageId).first();
  if (!bound) {
    await requireOwnStorage(env, owner, storageId);
  }
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
  const row = await env.DB.prepare('SELECT default_storage_id, can_create_workspaces FROM users WHERE id = ?')
    .bind(u.id)
    .first<{ default_storage_id: string | null; can_create_workspaces: number }>();
  const { results: workspaces } = await env.DB.prepare(
    `SELECT w.id, w.name, ws.storage_id,
            (SELECT u.name FROM workspace_members om JOIN users u ON u.id = om.user_id
             WHERE om.workspace_id = w.id AND om.role = 'owner' LIMIT 1) AS owner_name
     FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     LEFT JOIN workspace_storage ws ON ws.workspace_id = w.id AND ws.user_id = m.user_id
     WHERE m.user_id = ? ORDER BY w.created_at`
  )
    .bind(u.id)
    .all<{ id: string; name: string; owner_name: string | null; storage_id: string | null }>();
  for (const workspace of workspaces) {
    const { results: bound } = await env.DB.prepare(
      `SELECT s.id, s.name FROM workspace_storage_bindings b JOIN storages s ON s.id = b.storage_id
       WHERE b.workspace_id = ? ORDER BY b.created_at`
    ).bind(workspace.id).all<{ id: string; name: string }>();
    Object.assign(workspace, {
      displayName: `${workspace.owner_name ?? 'User'}'s ${workspace.name}`,
      storage_ids: bound,
    });
  }
  const { results: storages } = await env.DB.prepare(
    'SELECT id, name, url, username, password, root_path FROM storages WHERE user_id = ? AND shared = 0 ORDER BY created_at'
  )
    .bind(u.id)
    .all<{ id: string; name: string; url: string; username: string; password: string; root_path: string }>();
  // Storages the admin allocated to this user: name, limit and use, never the address or credentials.
  const { results: grants } = await env.DB.prepare(
    `SELECT s.id, s.name, g.limit_bytes FROM storage_grants g JOIN storages s ON s.id = g.storage_id
     WHERE g.user_id = ? AND s.shared = 1 ORDER BY s.name`
  )
    .bind(u.id)
    .all<{ id: string; name: string; limit_bytes: number | null }>();
  const sharedStorages = [];
  for (const g of grants) sharedStorages.push({ id: g.id, name: g.name, limit_bytes: g.limit_bytes, used: await sharedUsage(env, g.id, u.id) });
  return json({
    user: u,
    usage: await usage(env, u.id),
    defaultStorageId: row?.default_storage_id ?? null,
    canCreateWorkspaces: u.role === 'admin' || !!row?.can_create_workspaces,
    storages: storages.map(publicStorage),
    sharedStorages,
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
    `SELECT u.id, u.email, u.name, u.role, u.can_create_workspaces, u.disabled, u.created_at,
            (SELECT COUNT(*) FROM storages s WHERE s.user_id = u.id AND s.shared = 0) AS own_storages,
            (SELECT COUNT(*) FROM storage_grants g WHERE g.user_id = u.id) AS shared_storages,
            (SELECT COALESCE(SUM(size), 0) FROM files WHERE owner_id = u.id)
              + (SELECT COALESCE(SUM(size), 0) FROM page_versions WHERE owner_id = u.id) AS usage
     FROM users u ORDER BY u.created_at`
  ).all();
  return json(results);
}

interface UserInput {
  email?: string;
  name?: string;
  password?: string;
  role?: string;
  canCreateWorkspaces?: boolean;
  disabled?: boolean;
}

const roleOf = (v: unknown): 'admin' | 'member' => (v === 'admin' ? 'admin' : 'member');
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
      `INSERT INTO users (id, email, name, password_hash, role, can_create_workspaces, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, email, name, await hashPassword(env, password), roleOf(b.role), b.canCreateWorkspaces === false ? 0 : 1, Date.now()),
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
    `SELECT l.token, l.email, l.role, l.created_at, l.expires_at, l.used_at, u.name AS used_by_name,
            l.workspace_id, l.workspace_role, w.name AS workspace_name,
            l.storage_id, l.limit_bytes, s.name AS storage_name
     FROM registration_links l
     LEFT JOIN users u ON u.id = l.used_by
     LEFT JOIN workspaces w ON w.id = l.workspace_id
     LEFT JOIN storages s ON s.id = l.storage_id
     ORDER BY l.created_at DESC LIMIT 100`
  ).all();
  return json(results);
}

export async function adminCreateLink(req: Request, env: Env, user: User | null): Promise<Response> {
  const admin = requireAdmin(user);
  const b = await readJson<{ email?: string; role?: string; expiresInDays?: number | null; workspaceId?: string | null; workspaceRole?: string; storageId?: string | null; limitBytes?: unknown }>(req);
  const workspaceId = typeof b.workspaceId === 'string' && b.workspaceId ? b.workspaceId : null;
  if (workspaceId && !(await env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(workspaceId).first())) throw new HttpError(404, 'no such workspace');
  const storageId = typeof b.storageId === 'string' && b.storageId ? b.storageId : null;
  if (storageId) await sharedStorageOrThrow(env, storageId);
  const limit = storageId ? limitBytes(b.limitBytes) : null;
  const workspaceRole = b.workspaceRole === 'admin' ? 'admin' : 'member';
  const email = typeof b.email === 'string' && b.email.trim() ? b.email.trim().toLowerCase() : null;
  const days = Number(b.expiresInDays);
  const expiresAt = days > 0 ? Date.now() + Math.min(days, 365) * 86_400_000 : null;
  const token = randomToken(24);
  await env.DB.prepare(
    `INSERT INTO registration_links (token, email, role, created_by, created_at, expires_at, workspace_id, workspace_role, storage_id, limit_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(token, email, roleOf(b.role), admin.id, Date.now(), expiresAt, workspaceId, workspaceRole, storageId, limit)
    .run();
  return json({ token, email, role: roleOf(b.role), expires_at: expiresAt }, 201);
}

/** Workspaces a registration link can put people into. */
export async function adminListWorkspaces(env: Env, user: User | null): Promise<Response> {
  requireAdmin(user);
  const { results } = await env.DB.prepare('SELECT id, name FROM workspaces ORDER BY name').all();
  return json(results);
}

export async function adminDeleteLink(env: Env, user: User | null, token: string): Promise<Response> {
  requireAdmin(user);
  await env.DB.prepare('DELETE FROM registration_links WHERE token = ?').bind(token).run();
  return noContent();
}

// ---------- admin: shared storages ----------
// The admin's own WebDAV storages, shared with chosen users. Each user gets a limit (bytes, or none) for
// the workspaces they build on it; members of those workspaces use it without their own storage.

async function sharedStorageOrThrow(env: Env, sid: string) {
  const s = await storageById(env, sid);
  if (!s || !s.shared) throw new HttpError(404, 'no such shared storage');
  return s;
}

function limitBytes(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'the limit must be a number of bytes, or empty for no limit');
  return n;
}

export async function adminListSharedStorages(env: Env, user: User | null): Promise<Response> {
  requireAdmin(user);
  const { results } = await env.DB.prepare('SELECT id, name, url, username, password, root_path FROM storages WHERE shared = 1 ORDER BY created_at')
    .all<{ id: string; name: string; url: string; username: string; password: string; root_path: string }>();
  const out = [];
  for (const s of results) {
    const { results: grants } = await env.DB.prepare(
      `SELECT g.user_id, u.name, u.email, g.limit_bytes FROM storage_grants g JOIN users u ON u.id = g.user_id
       WHERE g.storage_id = ? ORDER BY u.name`
    ).bind(s.id).all<{ user_id: string; name: string; email: string; limit_bytes: number | null }>();
    const withUse = [];
    for (const g of grants) withUse.push({ ...g, used: await sharedUsage(env, s.id, g.user_id) });
    out.push({ ...publicStorage(s), grants: withUse });
  }
  return json(out);
}

export async function adminCreateSharedStorage(req: Request, env: Env, user: User | null): Promise<Response> {
  const admin = requireAdmin(user);
  const b = await readJson<StorageInput>(req);
  const addr = addressOf(b);
  const row = {
    id: newId(),
    name: str(b.name, 'name', 80),
    url: addr.url,
    root_path: addr.rootPath,
    username: typeof b.username === 'string' ? b.username.trim() : '',
    password: typeof b.password === 'string' ? b.password : '',
  };
  await prepareFolder(addr, row.username, row.password);
  await env.DB.prepare('INSERT INTO storages (id, user_id, name, url, root_path, username, password, shared, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)')
    .bind(row.id, admin.id, row.name, row.url, row.root_path, row.username, await sealPassword(row.password), Date.now())
    .run();
  return json({ ...publicStorage(row), grants: [] }, 201);
}

export async function adminUpdateSharedStorage(req: Request, env: Env, user: User | null, sid: string): Promise<Response> {
  requireAdmin(user);
  const s = await sharedStorageOrThrow(env, sid);
  const b = await readJson<StorageInput>(req);
  const addr = addressOf(b, s);
  const next = {
    name: b.name !== undefined ? str(b.name, 'name', 80) : s.name,
    url: addr.url,
    root_path: addr.rootPath,
    username: typeof b.username === 'string' ? b.username.trim() : s.username,
    password: typeof b.password === 'string' && b.password !== '' ? await sealPassword(b.password) : s.password,
  };
  await prepareFolder(addr, next.username, typeof b.password === 'string' && b.password !== '' ? b.password : s.password);
  await env.DB.prepare('UPDATE storages SET name = ?, url = ?, root_path = ?, username = ?, password = ? WHERE id = ?')
    .bind(next.name, next.url, next.root_path, next.username, next.password, sid)
    .run();
  return json(publicStorage({ id: sid, ...next }));
}

export async function adminDeleteSharedStorage(env: Env, user: User | null, sid: string): Promise<Response> {
  requireAdmin(user);
  await sharedStorageOrThrow(env, sid);
  return deleteStorageRow(env, sid);
}

/** Tests a shared storage's saved settings, or ones typed in the form. */
export async function adminTestSharedStorage(req: Request, env: Env, user: User | null, sid: string | null): Promise<Response> {
  requireAdmin(user);
  const saved = sid ? await sharedStorageOrThrow(env, sid) : null;
  const b = await readJson<StorageInput>(req);
  const addr = addressOf(b, saved ?? undefined);
  return json(
    await probeStorage(
      {
        id: saved?.id ?? 'test',
        url: addr.url,
        username: typeof b.username === 'string' ? b.username.trim() : (saved?.username ?? ''),
        password: typeof b.password === 'string' && b.password !== '' ? b.password : (saved?.password ?? ''),
      },
      addr.rootPath,
      b.create === true
    )
  );
}

/** Allocates a shared storage to a user with a limit (or changes it). `{ limitBytes: null }` = no limit. */
export async function adminSetGrant(req: Request, env: Env, user: User | null, sid: string, uid: string): Promise<Response> {
  requireAdmin(user);
  await sharedStorageOrThrow(env, sid);
  if (!(await env.DB.prepare('SELECT 1 FROM users WHERE id = ? AND disabled = 0').bind(uid).first())) throw new HttpError(404, 'no such user');
  const b = await readJson<{ limitBytes?: unknown }>(req);
  await env.DB.prepare(
    `INSERT INTO storage_grants (storage_id, user_id, limit_bytes, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (storage_id, user_id) DO UPDATE SET limit_bytes = excluded.limit_bytes`
  )
    .bind(sid, uid, limitBytes(b.limitBytes), Date.now())
    .run();
  return noContent();
}

/** Takes a shared storage back from a user. Refused while one of their workspaces is built on it. */
export async function adminRemoveGrant(env: Env, user: User | null, sid: string, uid: string): Promise<Response> {
  requireAdmin(user);
  await sharedStorageOrThrow(env, sid);
  const inUse = await env.DB.prepare('SELECT COUNT(*) AS n FROM workspace_storage_bindings WHERE storage_id = ? AND granted_user_id = ?')
    .bind(sid, uid)
    .first<{ n: number }>();
  if (inUse && inUse.n > 0) throw new HttpError(409, `${inUse.n} workspace(s) of this user are built on this storage; remove or move them first`);
  await env.DB.prepare('DELETE FROM storage_grants WHERE storage_id = ? AND user_id = ?').bind(sid, uid).run();
  return noContent();
}


// ---------- admin: instance settings ----------

/** The sign-in contact email, whether recovery mode is on, and the limits for a playground. */
async function instanceSettings(env: Env) {
  const num = async (key: string) => {
    const n = Number(await getAppSetting(env, key));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  };
  return {
    adminEmail: await getAppSetting(env, 'admin_email'),
    recoveryEnabled: recoveryEnabled(env),
    /** Limits every NEW workspace starts with (existing ones keep theirs; change those in Workspace settings). */
    defaultStorageLimit: await num('default_storage_limit'),
    defaultMaxPages: await num('default_max_pages'),
    /** The most one uploaded file may weigh, anywhere on this instance. */
    maxFileBytes: await num('max_file_bytes'),
    /** Requests one person may make per minute (default 600; 0 = no limit) and per hour (0 = no limit). The admin is exempt. */
    ratePerMinute: (await getAppSetting(env, 'rate_per_minute')) === '' ? 600 : Number(await getAppSetting(env, 'rate_per_minute')),
    ratePerHour: Number((await getAppSetting(env, 'rate_per_hour')) || 0),
    /** Open registration for a playground: anyone may create an account, which joins `playgroundWorkspace` as a member. */
    openRegistration: (await getAppSetting(env, 'open_registration')) === '1',
    playgroundWorkspace: (await getAppSetting(env, 'playground_workspace')) || null,
    playgroundMaxUsers: await num('playground_max_users'),
    accounts: (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n ?? 0,
  };
}

export async function adminGetSettings(env: Env, user: User | null): Promise<Response> {
  requireAdmin(user);
  return json(await instanceSettings(env));
}

const setting = async (env: Env, key: string, value: string | null) => {
  if (value) await env.DB.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, value).run();
  else await env.DB.prepare('DELETE FROM app_settings WHERE key = ?').bind(key).run();
};

const limitSetting = (v: unknown, what: string): string | null => {
  if (v === null || v === '' || v === undefined || v === 0) return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${what} must be a number, or empty for no limit`);
  return n ? String(n) : null;
};

export async function adminSetSettings(req: Request, env: Env, user: User | null): Promise<Response> {
  requireAdmin(user);
  const b = await readJson<{
    adminEmail?: string;
    defaultStorageLimit?: unknown;
    defaultMaxPages?: unknown;
    maxFileBytes?: unknown;
    ratePerMinute?: unknown;
    ratePerHour?: unknown;
    openRegistration?: unknown;
    playgroundWorkspace?: unknown;
    playgroundMaxUsers?: unknown;
  }>(req);
  if (b.adminEmail !== undefined) {
    const email = typeof b.adminEmail === 'string' ? b.adminEmail.trim() : '';
    if (email && (email.length > 200 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email))) throw new HttpError(400, 'that is not a valid email address');
    await setting(env, 'admin_email', email || null);
  }
  if ('defaultStorageLimit' in b) await setting(env, 'default_storage_limit', limitSetting(b.defaultStorageLimit, 'the storage limit'));
  if ('defaultMaxPages' in b) await setting(env, 'default_max_pages', limitSetting(b.defaultMaxPages, 'the page limit'));
  if ('maxFileBytes' in b) await setting(env, 'max_file_bytes', limitSetting(b.maxFileBytes, 'the file size limit'));
  for (const [field, key, what] of [['ratePerMinute', 'rate_per_minute', 'the per-minute limit'], ['ratePerHour', 'rate_per_hour', 'the per-hour limit']] as const) {
    if (field in b) {
      const v = b[field];
      if (v === null || v === '' || v === undefined) await setting(env, key, null); // back to the default
      else {
        const n = Math.floor(Number(v));
        if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${what} must be a number (0 = no limit)`);
        await env.DB.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, String(n)).run();
      }
    }
  }
  forgetRateLimits();
  if ('playgroundWorkspace' in b) {
    const id = typeof b.playgroundWorkspace === 'string' ? b.playgroundWorkspace : '';
    if (id && !(await env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(id).first())) throw new HttpError(404, 'no such workspace');
    await setting(env, 'playground_workspace', id || null);
    if (!id) await setting(env, 'open_registration', null); // nothing to join: registration closes
  }
  if ('playgroundMaxUsers' in b) await setting(env, 'playground_max_users', limitSetting(b.playgroundMaxUsers, 'the account limit'));
  if ('openRegistration' in b) {
    if (b.openRegistration === true && !(await getAppSetting(env, 'playground_workspace'))) throw new HttpError(400, 'choose the playground workspace new accounts will join before opening registration');
    await setting(env, 'open_registration', b.openRegistration === true ? '1' : null);
  }
  return json(await instanceSettings(env));
}
