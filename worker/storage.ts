import type { Env } from './env.js';
import { openPassword } from './secret.js';
import { HttpError } from './http.js';

/** A user's WebDAV folder (cloud-drive, Nextcloud, any WebDAV server). */
export interface StorageRow {
  id: string;
  user_id: string;
  name: string;
  url: string;
  username: string;
  password: string;
  /** 1 for a storage the admin shares with chosen users. */
  shared?: number;
  /** The folder part of `url` ('' when the address was saved as one piece). */
  root_path?: string;
}

/** Everything the app keeps in a storage lives under this folder. */
const ROOT = 'cloud-doc';

export const fileKey = (workspaceId: string, fileId: string, name: string) => `${ROOT}/${workspaceId}/files/${fileId}-${name}`;
export const historyKey = (workspaceId: string, pageId: string, versionId: string) =>
  `${ROOT}/${workspaceId}/${pageId}/history/${versionId}.ydoc`;
const historyFolder = (workspaceId: string, pageId: string) => `${ROOT}/${workspaceId}/${pageId}/history/`;
export const workspaceFolder = (workspaceId: string) => `${ROOT}/${workspaceId}/`;

/** Folders known to exist, per storage, for this isolate. */
const madeDirs = new Set<string>();

export class WebDav {
  constructor(private readonly s: Pick<StorageRow, 'id' | 'url' | 'username' | 'password'>) {}

  private url(key: string): string {
    const path = key
      .split('/')
      .map((seg, i, all) => (seg === '' && i === all.length - 1 ? '' : encodeURIComponent(seg)))
      .join('/');
    return `${this.s.url.replace(/\/+$/, '')}/${path}`;
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    if (!this.s.username) return extra;
    const pair = new TextEncoder().encode(`${this.s.username}:${await openPassword(this.s.password)}`);
    return { authorization: `Basic ${btoa(String.fromCharCode(...pair))}`, ...extra };
  }

  private async request(method: string, key: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
    try {
      return await fetch(this.url(key), { ...init, method, headers: await this.headers(init.headers) });
    } catch (err) {
      throw new HttpError(502, `storage "${this.s.url}" is unreachable: ${(err as Error).message}`);
    }
  }

  /** Creates the parent folders of `key` (generic WebDAV servers need them to exist). */
  private async ensureParents(key: string): Promise<void> {
    const parts = key.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = `${parts.slice(0, i).join('/')}/`;
      if (madeDirs.has(`${this.s.id}:${dir}`)) continue;
      const res = await this.request('MKCOL', dir);
      // 201 created, 405 already exists; anything else is a real problem.
      if (!res.ok && res.status !== 405) {
        throw new HttpError(502, `storage refused to create a folder (${res.status})`);
      }
      madeDirs.add(`${this.s.id}:${dir}`);
    }
  }

  async put(key: string, body: BodyInit | null, contentType: string, length?: string | null): Promise<void> {
    await this.ensureParents(key);
    const res = await this.request('PUT', key, {
      body,
      headers: { 'content-type': contentType, ...(length ? { 'content-length': length } : {}) },
    });
    if (!res.ok) throw new HttpError(502, `storage upload failed (${res.status})`);
  }

  get(key: string, range?: string | null): Promise<Response> {
    return this.request('GET', key, { headers: range ? { range } : {} });
  }

  /** Deletes a file or folder; missing is fine. */
  async delete(key: string): Promise<void> {
    const res = await this.request('DELETE', key);
    if (!res.ok && res.status !== 404) throw new HttpError(502, `storage delete failed (${res.status})`);
  }

  /** HTTP status of a PROPFIND on `key` (0 = unreachable is thrown as 502 by request). */
  async propfind(key = ''): Promise<number> {
    return (await this.request('PROPFIND', key, { headers: { depth: '0' } })).status;
  }

  /** Creates `segments` one level at a time below this storage's URL; folders that exist are fine. */
  async makeFolders(segments: string[]): Promise<void> {
    for (let i = 1; i <= segments.length; i++) {
      const res = await this.request('MKCOL', `${segments.slice(0, i).join('/')}/`);
      if (!res.ok && res.status !== 405) throw new HttpError(502, `the server refused to create the folder "${segments.slice(0, i).join('/')}" (${res.status})`);
    }
  }

  /** Names of the folders directly inside `key` (empty when it doesn't exist). */
  async listFolders(key: string): Promise<string[]> {
    const res = await this.request('PROPFIND', key, { headers: { depth: '1' } });
    if (res.status === 404) return [];
    if (res.status !== 207) throw new HttpError(502, `storage could not list its folders (${res.status})`);
    const xml = (await res.text()).slice(0, 2_000_000);
    const names: string[] = [];
    for (const m of xml.matchAll(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/gi)) {
      let path = m[1]!;
      try {
        path = decodeURIComponent(path);
      } catch {
        continue;
      }
      if (!path.endsWith('/')) continue; // a file, not a folder
      const name = path.replace(/\/+$/, '').split('/').pop() ?? '';
      if (name && name !== key.replace(/\/+$/, '').split('/').pop()) names.push(name);
    }
    return [...new Set(names)];
  }

  /** Checks the folder is reachable and the credentials work. */
  async check(): Promise<{ ok: boolean; message: string }> {
    const res = await this.request('PROPFIND', '', { headers: { depth: '0' } }).catch((e: Error) => e);
    if (res instanceof Error) return { ok: false, message: res.message };
    if (res.status === 207 || res.ok) return { ok: true, message: 'Connected' };
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'Wrong username or password' };
    if (res.status === 404) return { ok: false, message: 'Folder not found' };
    return { ok: false, message: `Unexpected answer from the server (${res.status})` };
  }
}

export async function storageById(env: Env, id: string | null): Promise<StorageRow | null> {
  if (!id) return null;
  return env.DB.prepare('SELECT id, user_id, name, url, username, password, shared, root_path FROM storages WHERE id = ?').bind(id).first<StorageRow>();
}

/** The storage a user writes to in a workspace: a bound personal override,
 * then a workspace binding, then their personal override/default. */
export async function resolveStorage(env: Env, userId: string, workspaceId: string): Promise<StorageRow | null> {
  return env.DB.prepare(
    `SELECT id, user_id, name, url, username, password, shared FROM storages WHERE id = COALESCE(
       (SELECT ws.storage_id FROM workspace_storage ws
        JOIN workspace_storage_bindings b ON b.workspace_id = ws.workspace_id AND b.storage_id = ws.storage_id
        WHERE ws.workspace_id = ? AND ws.user_id = ?),
       (SELECT storage_id FROM workspace_storage_bindings WHERE workspace_id = ? ORDER BY created_at LIMIT 1),
       (SELECT storage_id FROM workspace_storage WHERE workspace_id = ? AND user_id = ?),
       (SELECT default_storage_id FROM users WHERE id = ?))`
  )
    .bind(workspaceId, userId, workspaceId, workspaceId, userId, userId)
    .first<StorageRow>();
}

/** Bytes a user keeps in storages: uploaded files plus history snapshots. */
export async function usage(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT (SELECT COALESCE(SUM(size), 0) FROM files WHERE owner_id = ?)
          + (SELECT COALESCE(SUM(size), 0) FROM page_versions WHERE owner_id = ?) AS used`
  )
    .bind(userId, userId)
    .first<{ used: number }>();
  return row?.used ?? 0;
}

const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

/** Bytes counted against a user's allocation of a shared storage: what workspaces funded by them keep there. */
export async function sharedUsage(env: Env, storageId: string, granteeId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COALESCE(SUM(f.size), 0) FROM files f
          LEFT JOIN workspace_storage_bindings b ON b.workspace_id = f.workspace_id AND b.storage_id = f.storage_id
        WHERE f.storage_id = ?1 AND COALESCE(b.granted_user_id, f.owner_id) = ?2)
     + (SELECT COALESCE(SUM(v.size), 0) FROM page_versions v
          JOIN pages p ON p.id = v.page_id JOIN projects pr ON pr.id = p.project_id
          LEFT JOIN workspace_storage_bindings b ON b.workspace_id = pr.workspace_id AND b.storage_id = v.storage_id
        WHERE v.storage_id = ?1 AND COALESCE(b.granted_user_id, v.owner_id) = ?2) AS used`
  )
    .bind(storageId, granteeId)
    .first<{ used: number }>();
  return row?.used ?? 0;
}

/**
 * Whose allocation a write to `storage` in `workspaceId` counts against: for a shared storage, the user
 * whose grant the workspace was bound with (else the writer); nobody for a person's own storage.
 */
export async function fundingUser(env: Env, storage: StorageRow, writerId: string, workspaceId: string): Promise<string | null> {
  if (!storage.shared) return null;
  const bound = await env.DB.prepare('SELECT granted_user_id FROM workspace_storage_bindings WHERE workspace_id = ? AND storage_id = ?')
    .bind(workspaceId, storage.id)
    .first<{ granted_user_id: string | null }>();
  return bound?.granted_user_id ?? writerId;
}

/** Throws when `adding` more bytes would pass the allocation of a shared storage. Own storages have no limit. */
export async function checkQuota(env: Env, storage: StorageRow, writerId: string, workspaceId: string, adding: number): Promise<void> {
  const funder = await fundingUser(env, storage, writerId, workspaceId);
  if (!funder) return;
  const grant = await env.DB.prepare('SELECT limit_bytes FROM storage_grants WHERE storage_id = ? AND user_id = ?')
    .bind(storage.id, funder)
    .first<{ limit_bytes: number | null }>();
  if (!grant) throw new HttpError(403, 'this shared storage is no longer allocated to the workspace owner');
  if (grant.limit_bytes == null) return;
  const used = await sharedUsage(env, storage.id, funder);
  if (used + adding > grant.limit_bytes) {
    throw new HttpError(413, `the shared storage allocation is full: ${mb(used)} of ${mb(grant.limit_bytes)} used`);
  }
}

/** The storage to write to, or a clear error telling the user to set one up. */
export async function requireStorage(env: Env, userId: string, workspaceId: string): Promise<StorageRow> {
  const s = await resolveStorage(env, userId, workspaceId);
  if (!s) throw new HttpError(409, 'this workspace has no storage: a workspace owner can add one in Workspace settings');
  return s;
}

export async function workspaceOfPage(env: Env, pageId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT pr.workspace_id FROM pages p JOIN projects pr ON pr.id = p.project_id WHERE p.id = ?')
    .bind(pageId)
    .first<{ workspace_id: string }>();
  if (!row) throw new HttpError(404, 'no such page');
  return row.workspace_id;
}

/**
 * Removes a page's history from every storage that holds it. Call before the page's rows are
 * deleted. Files are not touched: they belong to the workspace. Storage errors are logged,
 * not thrown: the page is going away either way.
 */
export async function deletePageHistory(env: Env, workspaceId: string, pageId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT s.id, s.user_id, s.name, s.url, s.username, s.password FROM storages s
     WHERE s.id IN (SELECT storage_id FROM page_versions WHERE page_id = ?)`
  )
    .bind(pageId)
    .all<StorageRow>();
  for (const s of results) {
    await new WebDav(s).delete(historyFolder(workspaceId, pageId)).catch((err) => console.error('storage cleanup failed', err));
  }
}

/** Removes everything a workspace keeps from every storage it used (files and page history). */
export async function deleteWorkspaceData(env: Env, workspaceId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT s.id, s.user_id, s.name, s.url, s.username, s.password FROM storages s
     WHERE s.id IN (SELECT storage_id FROM files WHERE workspace_id = ?1
                    UNION SELECT v.storage_id FROM page_versions v JOIN pages p ON p.id = v.page_id JOIN projects pr ON pr.id = p.project_id WHERE pr.workspace_id = ?1
                    UNION SELECT storage_id FROM workspace_storage_bindings WHERE workspace_id = ?1)`
  )
    .bind(workspaceId)
    .all<StorageRow>();
  for (const s of results) {
    await new WebDav(s).delete(workspaceFolder(workspaceId)).catch((err) => console.error('storage cleanup failed', err));
  }
}

// ---------- address: server URL + folder path ----------

/** A folder path as clean segments: no empty, `.` or `..` parts, no control characters or backslashes. */
export function cleanPath(v: unknown): string[] {
  const raw = typeof v === 'string' ? v : '';
  if (raw.length > 300) throw new HttpError(400, 'the folder path is too long');
  const parts = raw.split('/').map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    if (p === '.' || p === '..' || /[\\\u0000-\u001f]/.test(p)) throw new HttpError(400, 'the folder path can only use plain folder names');
  }
  return parts;
}

const encodePath = (parts: string[]) => parts.map(encodeURIComponent).join('/');

/** The full address of a folder: the server URL (no trailing slash) plus its path. */
export const joinUrl = (base: string, parts: string[]) => (parts.length ? `${base.replace(/\/+$/, '')}/${encodePath(parts)}` : base.replace(/\/+$/, ''));

/** Splits a saved full URL back into server URL and path, using the stored `root_path`. */
export function splitUrl(url: string, rootPath: string): { baseUrl: string; path: string } {
  const parts = rootPath.split('/').filter(Boolean);
  const suffix = parts.length ? `/${encodePath(parts)}` : '';
  if (suffix && url.endsWith(suffix)) return { baseUrl: url.slice(0, url.length - suffix.length), path: parts.join('/') };
  return { baseUrl: url, path: '' };
}

export interface ProbeResult {
  ok: boolean;
  message: string;
  /** The server answered but the folder doesn't exist yet (and wasn't asked to be created). */
  missing?: boolean;
  created?: boolean;
}

/**
 * Checks a storage in two steps so the message says which part is wrong: the server (address and login), then
 * the folder under it. With `create`, a missing folder is made (each level in turn).
 */
export async function probeStorage(
  s: Pick<StorageRow, 'id' | 'url' | 'username' | 'password'>,
  rootPath: string,
  create: boolean
): Promise<ProbeResult> {
  const parts = rootPath.split('/').filter(Boolean);
  const { baseUrl } = splitUrl(s.url, rootPath);
  const server = new WebDav({ ...s, url: baseUrl });
  try {
    const status = await server.propfind('');
    if (status === 401 || status === 403) return { ok: false, message: 'Wrong username or password' };
    if (status === 404) return { ok: false, message: parts.length ? 'Server URL not found: check the address' : 'Folder not found' };
    if (status !== 207 && !(status >= 200 && status < 300)) return { ok: false, message: `Unexpected answer from the server (${status})` };
    if (!parts.length) return { ok: true, message: 'Connected' };
    const folder = await new WebDav(s).propfind('');
    if (folder === 207 || (folder >= 200 && folder < 300)) return { ok: true, message: 'Connected' };
    if (folder !== 404) return { ok: false, message: `Unexpected answer for the folder (${folder})` };
    if (!create) return { ok: false, missing: true, message: `The folder "${parts.join('/')}" doesn't exist yet` };
    await server.makeFolders(parts);
    return { ok: true, created: true, message: `Connected; created the folder "${parts.join('/')}"` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
