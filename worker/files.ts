import { pageAccess, requirePage, requireWorkspace, visibleProjects, workspaceRole } from './access.js';
import { requireUser, type User } from './auth.js';
import type { Env } from './env.js';
import { HttpError, json, newId, noContent } from './http.js';
import { tellRoom } from './rooms.js';
import { checkQuota, fileKey, requireStorage, storageById, WebDav, workspaceOfPage } from './storage.js';

/**
 * Files belong to a workspace. `page_id` is only where one was uploaded from; which pages use a file is
 * kept in file_refs (updated whenever a page is saved), so a file can serve many pages and outlive them.
 */

const FILE_COLS = 'f.id, f.workspace_id, f.page_id, f.owner_id, f.storage_id, f.key, f.name, f.mime, f.size, f.created_at';

interface FileRow {
  id: string;
  workspace_id: string;
  page_id: string | null;
  owner_id: string | null;
  storage_id: string | null;
  key: string;
  name: string;
  mime: string;
  size: number;
  created_at: number;
}

const fileUrl = (id: string, name: string) => `/api/files/${id}/${encodeURIComponent(name)}`;

const publicFile = (f: Pick<FileRow, 'id' | 'name' | 'mime' | 'size' | 'owner_id' | 'created_at'>) => ({
  id: f.id,
  name: f.name,
  mime: f.mime,
  size: f.size,
  owner_id: f.owner_id,
  created_at: f.created_at,
  url: fileUrl(f.id, f.name),
});

async function loadFile(env: Env, fid: string): Promise<FileRow> {
  const row = await env.DB.prepare(`SELECT ${FILE_COLS} FROM files f WHERE f.id = ?`).bind(fid).first<FileRow>();
  if (!row) throw new HttpError(404, 'no such file');
  return row;
}

/** Who may read a file: its uploader, workspace admins, and anyone who can view a page that uses it. */
async function canRead(req: Request, env: Env, u: User | null, f: FileRow): Promise<boolean> {
  if (u && f.owner_id === u.id) return true;
  if (f.page_id && (await pageAccess(req, env, u, f.page_id))) return true;
  const { results } = await env.DB.prepare('SELECT page_id FROM file_refs WHERE file_id = ? LIMIT 25').bind(f.id).all<{ page_id: string }>();
  for (const ref of results) if (await pageAccess(req, env, u, ref.page_id)) return true;
  if (u) {
    const role = await workspaceRole(env, u, f.workspace_id);
    if (role === 'owner' || role === 'admin') return true;
  }
  return false;
}

/** Who may delete a file: its uploader, or a workspace owner or admin. */
async function canManage(env: Env, u: User, f: FileRow): Promise<boolean> {
  if (f.owner_id === u.id) return true;
  const role = await workspaceRole(env, u, f.workspace_id);
  return role === 'owner' || role === 'admin';
}

// ---------- upload, list, download ----------

export async function uploadFile(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const user = requireUser(u);
  await requirePage(req, env, user, id, 'editor');
  // The size is needed up front to check the storage limit.
  const size = Number(req.headers.get('content-length'));
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(411, 'uploads need a Content-Length');
  const workspaceId = await workspaceOfPage(env, id);
  const storage = await requireStorage(env, user.id, workspaceId);
  await checkQuota(env, storage, user.id, workspaceId, size);
  const raw = decodeURIComponent(req.headers.get('x-filename') ?? 'file');
  const name = raw.replace(/[/\\\u0000-\u001f]+/g, '_').trim().slice(-120) || 'file';
  const mime = (req.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim() || 'application/octet-stream';
  const fileId = newId();
  const key = fileKey(workspaceId, fileId, name.replace(/[^\w.\- ]+/g, '_'));
  await new WebDav(storage).put(key, req.body, mime, String(size));
  const row = { id: fileId, owner_id: user.id, name, mime, size, created_at: Date.now() };
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO files (id, workspace_id, page_id, owner_id, storage_id, key, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(fileId, workspaceId, id, user.id, storage.id, key, name, mime, size, row.created_at),
    // The page it was uploaded into is about to use it.
    env.DB.prepare('INSERT INTO file_refs (file_id, page_id) VALUES (?, ?)').bind(fileId, id),
  ]);
  await tellRoom(env, id, '/notify', { type: 'files' });
  return json(publicFile(row), 201);
}

/** The files a page uses (or was the first to upload). */
export async function listFiles(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  await requirePage(req, env, u, id, 'viewer');
  const { results } = await env.DB.prepare(
    `SELECT ${FILE_COLS} FROM files f
     WHERE f.id IN (SELECT file_id FROM file_refs WHERE page_id = ?1) OR f.page_id = ?1
     ORDER BY f.created_at DESC`
  )
    .bind(id)
    .all<FileRow>();
  return json(results.map(publicFile));
}

/** Streams a file (with Range support, so video can seek) to anyone who can read a page that uses it. */
export async function downloadFile(req: Request, env: Env, u: User | null, fid: string): Promise<Response> {
  const f = await loadFile(env, fid);
  if (!(await canRead(req, env, u, f))) throw new HttpError(u ? 404 : 401, u ? 'no such file' : 'sign in required');
  const storage = await storageById(env, f.storage_id);
  if (!storage) throw new HttpError(410, 'the storage holding this file was removed');
  const range = req.headers.get('range');
  let res = await new WebDav(storage).get(f.key, range);
  // A storage backend may advertise Range support but fail an individual range.
  // PDF.js is used for document reading, so retry the whole object instead of
  // turning a recoverable range failure into a 502.
  if (range && (!res.ok || (res.status !== 206 && res.status !== 200))) {
    res = await new WebDav(storage).get(f.key);
  }
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, 'file not available from its storage');
  const headers = new Headers();
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('content-type', f.mime);
  // Files come from users and are served from the app's own origin, so a page that can run
  // script (HTML, SVG, XML) must never run here: it would act with the viewer's session.
  // Those types download instead of displaying, and every file gets a sandbox policy for
  // the case where one is opened directly. Pictures, video and PDFs still show in pages.
  const active = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|(text|application)\/xml|(text|application)\/(x-)?javascript)\b/i.test(f.mime);
  headers.set('content-disposition', `${active ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-security-policy', "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
  // Ids are unique per upload, so the content never changes.
  headers.set('cache-control', 'private, max-age=31536000, immutable');
  return new Response(res.body, { status: res.status, headers });
}

// ---------- the workspace's files ----------

/** Every file of a workspace that the caller may see, with the pages that use it. */
export async function listWorkspaceFiles(env: Env, u: User | null, wid: string): Promise<Response> {
  const user = requireUser(u);
  const wsRole = await requireWorkspace(env, user, wid);
  const isAdmin = wsRole === 'owner' || wsRole === 'admin';
  const visible = new Set((await visibleProjects(env, user, wid)).map((p) => p.id));
  const { results: files } = await env.DB.prepare(
    `SELECT ${FILE_COLS}, u.name AS owner_name, s.name AS storage_name,
            (SELECT p.project_id FROM pages p WHERE p.id = f.page_id) AS origin_project
     FROM files f LEFT JOIN users u ON u.id = f.owner_id LEFT JOIN storages s ON s.id = f.storage_id
     WHERE f.workspace_id = ? ORDER BY f.created_at DESC LIMIT 1000`
  )
    .bind(wid)
    .all<FileRow & { owner_name: string | null; storage_name: string | null; origin_project: string | null }>();
  const { results: refs } = await env.DB.prepare(
    `SELECT r.file_id, p.id AS page_id, p.title, p.project_id FROM file_refs r
     JOIN pages p ON p.id = r.page_id JOIN projects pr ON pr.id = p.project_id WHERE pr.workspace_id = ?`
  )
    .bind(wid)
    .all<{ file_id: string; page_id: string; title: string; project_id: string }>();
  const byFile = new Map<string, { id: string; title: string; project_id: string }[]>();
  for (const r of refs) byFile.set(r.file_id, [...(byFile.get(r.file_id) ?? []), { id: r.page_id, title: r.title, project_id: r.project_id }]);
  const out = [];
  for (const f of files) {
    const used = byFile.get(f.id) ?? [];
    const usedVisible = used.filter((p) => visible.has(p.project_id));
    const mayList = isAdmin || f.owner_id === user.id || usedVisible.length > 0 || (!!f.origin_project && visible.has(f.origin_project));
    if (!mayList) continue;
    out.push({
      ...publicFile(f),
      owner_name: f.owner_name,
      storage_name: f.storage_name,
      used_count: used.length,
      used_in: usedVisible.slice(0, 20).map((p) => ({ id: p.id, title: p.title })),
      can_delete: isAdmin || f.owner_id === user.id,
    });
  }
  return json({ files: out });
}

// ---------- deleting ----------

async function removeFiles(env: Env, files: FileRow[]): Promise<void> {
  const touched = new Set<string>();
  for (const f of files) {
    const storage = await storageById(env, f.storage_id);
    if (storage) await new WebDav(storage).delete(f.key).catch((err) => console.error('file delete failed', err));
    const { results } = await env.DB.prepare('SELECT page_id FROM file_refs WHERE file_id = ?').bind(f.id).all<{ page_id: string }>();
    for (const r of results) touched.add(r.page_id);
    await env.DB.prepare('DELETE FROM files WHERE id = ?').bind(f.id).run();
  }
  for (const pid of touched) await tellRoom(env, pid, '/notify', { type: 'files' }).catch(() => undefined);
}

/** Deletes a file. One that pages still use needs `?force=1`, and the answer lists them so the caller can warn. */
export async function deleteFile(req: Request, env: Env, u: User | null, fid: string): Promise<Response> {
  const user = requireUser(u);
  const f = await loadFile(env, fid);
  if (!(await canRead(req, env, user, f)) || !(await canManage(env, user, f))) {
    throw new HttpError(await canRead(req, env, user, f) ? 403 : 404, 'only the uploader or a workspace admin can delete this file');
  }
  const { results: used } = await env.DB.prepare(
    'SELECT p.id, p.title FROM file_refs r JOIN pages p ON p.id = r.page_id WHERE r.file_id = ? LIMIT 20'
  )
    .bind(fid)
    .all<{ id: string; title: string }>();
  if (used.length && new URL(req.url).searchParams.get('force') !== '1') {
    return json({ error: `this file is used in ${used.length} page${used.length === 1 ? '' : 's'}`, used_in: used }, 409);
  }
  await removeFiles(env, [f]);
  return noContent();
}

/** What deleting a page (and its subpages) would mean for files: which are only used here, which are shared. */
export async function deletePreview(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const user = requireUser(u);
  await requirePage(req, env, user, id, 'editor');
  const ids = await subtreeIds(env, id);
  const { results } = await env.DB.prepare(
    `SELECT ${FILE_COLS},
            (SELECT COUNT(*) FROM file_refs r WHERE r.file_id = f.id AND r.page_id NOT IN (SELECT value FROM json_each(?1))) AS outside
     FROM files f WHERE f.id IN (SELECT file_id FROM file_refs WHERE page_id IN (SELECT value FROM json_each(?1)))`
  )
    .bind(JSON.stringify(ids))
    .all<FileRow & { outside: number }>();
  const files = [];
  for (const f of results) {
    const { results: elsewhere } = f.outside
      ? await env.DB.prepare(
          `SELECT p.id, p.title FROM file_refs r JOIN pages p ON p.id = r.page_id
           WHERE r.file_id = ?1 AND r.page_id NOT IN (SELECT value FROM json_each(?2)) LIMIT 3`
        ).bind(f.id, JSON.stringify(ids)).all<{ id: string; title: string }>()
      : { results: [] };
    files.push({ ...publicFile(f), shared: f.outside > 0, used_elsewhere: elsewhere, can_delete: await canManage(env, user, f) });
  }
  return json({ pages: ids.length, files });
}

async function subtreeIds(env: Env, id: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id) SELECT id FROM sub`
  )
    .bind(id)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/**
 * Called when pages are deleted with "also delete their files": removes the files that no page outside
 * the deleted ones uses (and the user may delete); shared ones stay.
 */
export async function deleteTreeFiles(env: Env, user: User, pageIds: string[]): Promise<{ filesDeleted: number; filesKept: number }> {
  const { results } = await env.DB.prepare(
    `SELECT ${FILE_COLS},
            (SELECT COUNT(*) FROM file_refs r WHERE r.file_id = f.id AND r.page_id NOT IN (SELECT value FROM json_each(?1))) AS outside
     FROM files f WHERE f.id IN (SELECT file_id FROM file_refs WHERE page_id IN (SELECT value FROM json_each(?1)))`
  )
    .bind(JSON.stringify(pageIds))
    .all<FileRow & { outside: number }>();
  const doomed: FileRow[] = [];
  let kept = 0;
  for (const f of results) {
    if (f.outside === 0 && (await canManage(env, user, f))) doomed.push(f);
    else kept++;
  }
  await removeFiles(env, doomed);
  return { filesDeleted: doomed.length, filesKept: kept };
}

// ---------- which pages use which files ----------

const FILE_URL = /\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//g;

/** File ids a document refers to (in image, video, PDF and file blocks and in links). */
export function fileIdsIn(documentXml: string): string[] {
  return [...new Set([...documentXml.matchAll(FILE_URL)].map((m) => m[1]!))].slice(0, 500);
}

/** Makes file_refs match what a page uses now. Only files of the page's own workspace count. */
export async function syncFileRefs(env: Env, pageId: string, ids: string[]): Promise<void> {
  const json_ids = JSON.stringify(ids);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM file_refs WHERE page_id = ?1 AND file_id NOT IN (SELECT value FROM json_each(?2))').bind(pageId, json_ids),
    env.DB.prepare(
      `INSERT OR IGNORE INTO file_refs (file_id, page_id)
       SELECT f.id, ?1 FROM files f
       WHERE f.id IN (SELECT value FROM json_each(?2))
         AND f.workspace_id = (SELECT pr.workspace_id FROM pages p JOIN projects pr ON pr.id = p.project_id WHERE p.id = ?1)`
    ).bind(pageId, json_ids),
  ]);
}
