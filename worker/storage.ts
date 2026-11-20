import type { Env } from './env.js';
import { HttpError } from './http.js';

/** A user's WebDAV folder (cloud-drive, Nextcloud, any WebDAV server). */
export interface StorageRow {
  id: string;
  user_id: string;
  name: string;
  url: string;
  username: string;
  password: string;
}

/** Everything the app keeps in a storage lives under this folder. */
const ROOT = 'cloud-doc';

export const fileKey = (workspaceId: string, pageId: string, fileId: string, name: string) =>
  `${ROOT}/${workspaceId}/${pageId}/files/${fileId}-${name}`;
export const historyKey = (workspaceId: string, pageId: string, versionId: string) =>
  `${ROOT}/${workspaceId}/${pageId}/history/${versionId}.ydoc`;
const pageFolder = (workspaceId: string, pageId: string) => `${ROOT}/${workspaceId}/${pageId}/`;

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

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    if (!this.s.username) return extra;
    const pair = new TextEncoder().encode(`${this.s.username}:${this.s.password}`);
    return { authorization: `Basic ${btoa(String.fromCharCode(...pair))}`, ...extra };
  }

  private async request(method: string, key: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
    try {
      return await fetch(this.url(key), { ...init, method, headers: this.headers(init.headers) });
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
  return env.DB.prepare('SELECT id, user_id, name, url, username, password FROM storages WHERE id = ?').bind(id).first<StorageRow>();
}

/** The storage a user writes to in a workspace: their override for it, else their default. */
export async function resolveStorage(env: Env, userId: string, workspaceId: string): Promise<StorageRow | null> {
  return env.DB.prepare(
    `SELECT id, user_id, name, url, username, password FROM storages WHERE id = COALESCE(
       (SELECT storage_id FROM workspace_storage WHERE workspace_id = ? AND user_id = ?),
       (SELECT default_storage_id FROM users WHERE id = ?))`
  )
    .bind(workspaceId, userId, userId)
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

/** Throws when `adding` more bytes would pass the user's storage limit. */
export async function checkQuota(env: Env, userId: string, adding: number): Promise<void> {
  const row = await env.DB.prepare('SELECT storage_limit FROM users WHERE id = ?').bind(userId).first<{ storage_limit: number | null }>();
  if (row?.storage_limit == null) return;
  const used = await usage(env, userId);
  if (used + adding > row.storage_limit) {
    throw new HttpError(413, `storage limit reached: ${mb(used)} of ${mb(row.storage_limit)} used`);
  }
}

/** The storage to write to, or a clear error telling the user to set one up. */
export async function requireStorage(env: Env, userId: string, workspaceId: string): Promise<StorageRow> {
  const s = await resolveStorage(env, userId, workspaceId);
  if (!s) throw new HttpError(409, 'no storage set up: add one in Settings → Storage');
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
 * Removes a page's folder from every storage that holds its files or
 * history. Call before the page's rows are deleted. Storage errors are
 * logged, not thrown: the page is going away either way.
 */
export async function deletePageFolders(env: Env, workspaceId: string, pageId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT s.id, s.user_id, s.name, s.url, s.username, s.password FROM storages s
     WHERE s.id IN (SELECT storage_id FROM files WHERE page_id = ? UNION SELECT storage_id FROM page_versions WHERE page_id = ?)`
  )
    .bind(pageId, pageId)
    .all<StorageRow>();
  for (const s of results) {
    await new WebDav(s).delete(pageFolder(workspaceId, pageId)).catch((err) => console.error('storage cleanup failed', err));
  }
}
