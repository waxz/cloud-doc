import { requireWorkspace } from './access.js';
import { requireUser, type User } from './auth.js';
import type { Env } from './env.js';
import { HttpError, json, newId, readJson, str } from './http.js';
import { exportRoom, loadRoom } from './rooms.js';
import { deriveId, mapFileUrls } from './rewrite.js';
import { usableStorage } from './settings.js';
import { checkQuota, fileKey, historyKey, storageById, WebDav, type StorageRow } from './storage.js';

/**
 * Moving a workspace between storages, and backing it up to one and restoring it from one.
 *
 * Both are done in steps. A Worker request has a small budget (on the free plan: 50 outgoing
 * requests, 10 ms of CPU), so each call handles a handful of items and returns where to continue; the
 * browser keeps calling until it is done. The server remembers nothing between calls: all progress is in
 * the request and the response, so an interrupted run can simply be started again.
 */

const BACKUP_ROOT = 'cloud-doc-backups';
const FORMAT = 'cloud-doc-backup';
const VERSION = 1;
/** Items per step, sized so one step stays inside the request budget. */
const PAGE_STEP = 10;
const COMMENT_STEP = 30;
const FILE_STEP = 6;
const VERSION_STEP = 6;
/** A step stops taking more files once it has moved this many bytes. */
const BYTE_BUDGET = 40 * 1024 * 1024;
const MIGRATE_STEP = 6;
const MAX_META_BYTES = 2_000_000;
const MAX_PROJECTS = 40;

type Phase = 'pages' | 'comments' | 'files' | 'versions';
const PHASES: Phase[] = ['pages', 'comments', 'files', 'versions'];

const folderOk = (v: unknown): v is string => typeof v === 'string' && /^[\w][\w .\-]{0,99}$/.test(v) && !v.includes('..');
const slug = (s: string) => s.replace(/[^\w.\- ]+/g, '_').trim().slice(0, 50) || 'workspace';

/** Runs `fn` over `items` with a few at a time (a Worker can hold only so many connections open). */
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    })
  );
}

async function requireOwner(env: Env, user: User, wid: string): Promise<void> {
  const role = await requireWorkspace(env, user, wid, true);
  if (role !== 'owner') throw new HttpError(403, 'only the workspace owner can do this');
}

const workspacePages = `SELECT p.id FROM pages p JOIN projects pr ON pr.id = p.project_id WHERE pr.workspace_id = ?1`;

// ---------- migrate: move a workspace's files and history to another storage ----------

interface MoveRow {
  kind: 'file' | 'version';
  id: string;
  storage_id: string;
  key: string;
  size: number;
  mime: string;
}

/**
 * One step of moving everything the workspace keeps to `toStorageId`. The first call (`start`) also makes the
 * target the workspace's storage, so uploads made while this runs already go there. Each file is copied,
 * then its row is pointed at the copy, then (if asked) the old copy is deleted, so a failure at any point
 * leaves the item readable from one place.
 */
export async function migrateStep(req: Request, env: Env, u: User | null, wid: string): Promise<Response> {
  const user = requireUser(u);
  await requireOwner(env, user, wid);
  const b = await readJson<{ toStorageId?: string; removeOld?: boolean; start?: boolean; skip?: string[] }>(req);
  const target = await usableStorage(env, user.id, str(b.toStorageId, 'toStorageId', 80));
  if (!target) throw new HttpError(400, 'that storage is not yours and was not shared with you');
  const skip = (Array.isArray(b.skip) ? b.skip : []).filter((x): x is string => typeof x === 'string').slice(0, 200);

  if (b.start) {
    const check = await new WebDav(target).check();
    if (!check.ok) throw new HttpError(400, `the target storage can't be used: ${check.message}`);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM workspace_storage_bindings WHERE workspace_id = ?').bind(wid),
      env.DB.prepare('INSERT INTO workspace_storage_bindings (workspace_id, storage_id, created_at, granted_user_id) VALUES (?, ?, ?, ?)').bind(
        wid,
        target.id,
        Date.now(),
        target.shared ? user.id : null
      ),
    ]);
  }

  const skipJson = JSON.stringify(skip);
  const pending = `storage_id IS NOT NULL AND storage_id != ?2 AND id NOT IN (SELECT value FROM json_each(?3))`;
  const { results } = await env.DB.prepare(
    `SELECT 'file' AS kind, id, storage_id, key, size, mime FROM files WHERE workspace_id = ?1 AND ${pending}
     UNION ALL
     SELECT 'version', id, storage_id, storage_key, size, 'application/octet-stream' FROM page_versions
       WHERE page_id IN (${workspacePages}) AND ${pending}
     LIMIT ${MIGRATE_STEP}`
  )
    .bind(wid, target.id, skipJson)
    .all<MoveRow>();

  const failed: { id: string; error: string }[] = [];
  let moved = 0;
  let bytes = 0;
  const to = new WebDav(target);
  const sources = new Map<string, StorageRow | null>();
  for (const row of results) {
    if (bytes >= BYTE_BUDGET) break;
    try {
      if (!sources.has(row.storage_id)) sources.set(row.storage_id, await storageById(env, row.storage_id));
      const from = sources.get(row.storage_id);
      if (!from) throw new HttpError(410, 'the storage holding this item was removed');
      await checkQuota(env, target, user.id, wid, row.size);
      const res = await new WebDav(from).get(row.key);
      if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `not readable from its storage (${res.status})`);
      await to.put(row.key, res.body, row.mime, String(row.size));
      await env.DB.prepare(`UPDATE ${row.kind === 'file' ? 'files' : 'page_versions'} SET storage_id = ? WHERE id = ?`).bind(target.id, row.id).run();
      if (b.removeOld && from.id !== target.id) await new WebDav(from).delete(row.key).catch(() => undefined);
      moved++;
      bytes += row.size;
    } catch (err) {
      failed.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const left = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM files WHERE workspace_id = ?1 AND ${pending})
          + (SELECT COUNT(*) FROM page_versions WHERE page_id IN (${workspacePages}) AND ${pending}) AS n`
  )
    .bind(wid, target.id, skipJson)
    .first<{ n: number }>();
  return json({ moved, failed, remaining: left?.n ?? 0, done: (left?.n ?? 0) === 0 });
}

// ---------- backup: write a workspace into a storage ----------

interface BackupState {
  phase: Phase | 'finish';
  after: string;
  seq: number;
  counts: Record<Phase, number>;
  skipped: { kind: string; id: string; name: string; reason: string }[];
}

const emptyState = (): BackupState => ({ phase: 'pages', after: '-1|', seq: 0, counts: { pages: 0, comments: 0, files: 0, versions: 0 }, skipped: [] });

/** A backup you can open by eye: manifest.json, meta/<kind>-<n>.json chains, and the blobs next to them. */
export async function backupStep(req: Request, env: Env, u: User | null, wid: string): Promise<Response> {
  const user = requireUser(u);
  await requireOwner(env, user, wid);
  const b = await readJson<{ storageId?: string; folder?: string; state?: BackupState }>(req);
  // Backups are not counted against a storage allocation, so they go to a storage the person owns.
  const storage = await storageById(env, str(b.storageId, 'storageId', 80));
  if (!storage || storage.user_id !== user.id || storage.shared) throw new HttpError(400, 'back up to one of your own storages');
  const dav = new WebDav(storage);
  const ws = await env.DB.prepare('SELECT name FROM workspaces WHERE id = ?').bind(wid).first<{ name: string }>();
  if (!ws) throw new HttpError(404, 'no such workspace');

  let folder = b.folder;
  if (!folder) {
    const d = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    folder = `${slug(ws.name)}-${d}`;
    const check = await dav.check();
    if (!check.ok) throw new HttpError(400, `the storage can't be used: ${check.message}`);
    const totals = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM pages WHERE id IN (${workspacePages})) AS pages,
              (SELECT COUNT(*) FROM comments WHERE page_id IN (${workspacePages})) AS comments,
              (SELECT COUNT(*) FROM files WHERE workspace_id = ?1) AS files,
              (SELECT COUNT(*) FROM page_versions WHERE page_id IN (${workspacePages})) AS versions`
    )
      .bind(wid)
      .first<Record<Phase, number>>();
    return json({ folder, state: emptyState(), totals, done: false });
  }
  if (!folderOk(folder)) throw new HttpError(400, 'invalid backup folder');
  const base = `${BACKUP_ROOT}/${folder}`;
  const st: BackupState = b.state && PHASES.concat(['finish' as never]).includes(b.state.phase as never) ? b.state : emptyState();
  st.counts ??= { pages: 0, comments: 0, files: 0, versions: 0 };
  st.skipped = (st.skipped ?? []).slice(0, 200);
  const putJson = (key: string, data: unknown) => dav.put(`${base}/${key}`, JSON.stringify(data), 'application/json');
  const advance = (phase: BackupState['phase']) => {
    st.phase = phase;
    st.after = '';
    st.seq = 0;
  };

  if (st.phase === 'pages') {
    const [depthText, afterId = ''] = st.after.split('|');
    const depth = Number(depthText);
    const { results } = await env.DB.prepare(
      `WITH RECURSIVE t(id, depth) AS (
         SELECT p.id, 0 FROM pages p JOIN projects pr ON pr.id = p.project_id WHERE pr.workspace_id = ?1 AND p.parent_id IS NULL
         UNION ALL SELECT c.id, t.depth + 1 FROM pages c JOIN t ON c.parent_id = t.id)
       SELECT p.id, p.project_id, p.parent_id, p.title, p.icon, p.position, p.created_at, p.updated_at, t.depth
       FROM t JOIN pages p ON p.id = t.id
       WHERE t.depth > ?2 OR (t.depth = ?2 AND p.id > ?3)
       ORDER BY t.depth, p.id LIMIT ${PAGE_STEP + 1}`
    )
      .bind(wid, Number.isFinite(depth) ? depth : -1, afterId)
      .all<{ id: string; depth: number }>();
    const rows = results.slice(0, PAGE_STEP);
    await pool(rows, 4, async (p) => dav.put(`${base}/pages/${p.id}.ydoc`, await exportRoom(env, p.id), 'application/octet-stream'));
    const more = results.length > PAGE_STEP;
    await putJson(`meta/pages-${st.seq}.json`, { rows, next: more ? st.seq + 1 : null });
    st.counts.pages += rows.length;
    if (more) {
      const last = rows[rows.length - 1]!;
      st.after = `${last.depth}|${last.id}`;
      st.seq++;
    } else advance('comments');
  } else if (st.phase === 'comments') {
    const { results } = await env.DB.prepare(`SELECT * FROM comments WHERE page_id IN (${workspacePages}) AND id > ?2 ORDER BY id LIMIT ${COMMENT_STEP + 1}`)
      .bind(wid, st.after)
      .all<{ id: string }>();
    const rows = results.slice(0, COMMENT_STEP);
    const more = results.length > COMMENT_STEP;
    await putJson(`meta/comments-${st.seq}.json`, { rows, next: more ? st.seq + 1 : null });
    st.counts.comments += rows.length;
    if (more) {
      st.after = rows[rows.length - 1]!.id;
      st.seq++;
    } else advance('files');
  } else if (st.phase === 'files' || st.phase === 'versions') {
    const isFiles = st.phase === 'files';
    const { results } = await env.DB.prepare(
      isFiles
        ? `SELECT id, page_id, storage_id, key, name, mime, size, created_at FROM files WHERE workspace_id = ?1 AND id > ?2 ORDER BY id LIMIT ${FILE_STEP + 1}`
        : `SELECT id, page_id, storage_id, storage_key AS key, kind, title, created_by_name, size, created_at FROM page_versions
           WHERE page_id IN (${workspacePages}) AND id > ?2 ORDER BY id LIMIT ${VERSION_STEP + 1}`
    )
      .bind(wid, st.after)
      .all<{ id: string; storage_id: string | null; key: string; size: number; mime?: string; name?: string; title?: string }>();
    const limit = isFiles ? FILE_STEP : VERSION_STEP;
    const done: Record<string, unknown>[] = [];
    let bytes = 0;
    let stoppedEarly = false;
    for (const row of results.slice(0, limit)) {
      if (bytes >= BYTE_BUDGET) {
        stoppedEarly = true;
        break;
      }
      const blob = `${base}/${isFiles ? 'files' : 'history'}/${row.id}`;
      let missing = '';
      try {
        const from = await storageById(env, row.storage_id);
        if (!from) missing = 'the storage holding it was removed';
        else {
          const res = await new WebDav(from).get(row.key);
          if (!res.ok) missing = `not readable from its storage (${res.status})`;
          else await dav.put(blob, res.body, row.mime ?? 'application/octet-stream', String(row.size));
        }
      } catch (err) {
        missing = err instanceof Error ? err.message : String(err);
      }
      if (missing) st.skipped.push({ kind: isFiles ? 'file' : 'version', id: row.id, name: row.name ?? row.title ?? '', reason: missing });
      else bytes += row.size;
      const { storage_id: _s, key: _k, ...meta } = row;
      done.push({ ...meta, ...(missing ? { missing: true } : {}) });
    }
    if (isFiles && done.length) {
      const ids = JSON.stringify(done.map((d) => d.id));
      const refs = await env.DB.prepare('SELECT file_id, page_id FROM file_refs WHERE file_id IN (SELECT value FROM json_each(?))').bind(ids).all();
      for (const d of done) d.refs = refs.results.filter((r) => r.file_id === d.id).map((r) => r.page_id);
    }
    const more = stoppedEarly || results.length > limit;
    await putJson(`meta/${st.phase}-${st.seq}.json`, { rows: done, next: more ? st.seq + 1 : null });
    st.counts[st.phase] += done.length;
    if (more) {
      st.after = String(done[done.length - 1]!.id);
      st.seq++;
    } else advance(isFiles ? 'versions' : 'finish');
  } else {
    // Everything is in place: the manifest comes last, so a folder without one is an unfinished backup.
    const [projects, members, projectMembers] = await Promise.all([
      env.DB.prepare('SELECT id, name, default_role FROM projects WHERE workspace_id = ? ORDER BY created_at').bind(wid).all(),
      env.DB.prepare('SELECT u.email, u.name, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?').bind(wid).all(),
      env.DB.prepare(
        `SELECT pm.project_id, u.email, pm.role FROM project_members pm JOIN users u ON u.id = pm.user_id
         JOIN projects p ON p.id = pm.project_id WHERE p.workspace_id = ?`
      )
        .bind(wid)
        .all(),
    ]);
    await putJson('manifest.json', {
      format: FORMAT,
      version: VERSION,
      exportedAt: Date.now(),
      workspace: { id: wid, name: ws.name },
      projects: projects.results,
      members: members.results,
      projectMembers: projectMembers.results,
      counts: st.counts,
      skipped: st.skipped,
      complete: true,
    });
    return json({ folder, state: st, done: true, skipped: st.skipped });
  }
  return json({ folder, state: st, done: false });
}

/** The backups found in one of the user's storages, newest first. */
export async function listBackups(env: Env, u: User | null, storageId: string): Promise<Response> {
  const user = requireUser(u);
  const storage = await usableStorage(env, user.id, storageId);
  if (!storage) throw new HttpError(404, 'no such storage');
  const dav = new WebDav(storage);
  const folders = (await dav.listFolders(`${BACKUP_ROOT}/`)).filter(folderOk).slice(0, 30);
  const found = await Promise.all(
    folders.map(async (folder) => {
      try {
        const res = await dav.get(`${BACKUP_ROOT}/${folder}/manifest.json`);
        if (!res.ok) return { folder, complete: false };
        const m = JSON.parse((await res.text()).slice(0, MAX_META_BYTES)) as Manifest;
        if (m.format !== FORMAT) return null;
        return { folder, complete: !!m.complete, name: String(m.workspace?.name ?? ''), exportedAt: Number(m.exportedAt) || 0, counts: m.counts };
      } catch {
        return { folder, complete: false };
      }
    })
  );
  return json(found.filter(Boolean).sort((a, b) => (b!.exportedAt ?? 0) - (a!.exportedAt ?? 0)));
}

// ---------- import: restore a backup as a new workspace ----------

interface Manifest {
  format: string;
  version: number;
  exportedAt: number;
  workspace: { id: string; name: string };
  projects: { id: string; name: string; default_role: string | null }[];
  members?: { email: string; name: string; role: string }[];
  projectMembers?: { project_id: string; email: string; role: string }[];
  counts: Record<Phase, number>;
  complete: boolean;
}

interface ImportState {
  workspaceId: string;
  phase: Phase;
  seq: number;
  done: Record<Phase, number>;
  failed: { kind: string; id: string; error: string }[];
}

async function readMeta<T>(dav: WebDav, key: string): Promise<T> {
  const res = await dav.get(key);
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `${key.split('/').slice(-2).join('/')} is missing from the backup (${res.status})`);
  const text = await res.text();
  if (text.length > MAX_META_BYTES) throw new HttpError(413, 'the backup has an oversized index file');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(422, 'the backup has an unreadable index file');
  }
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

export async function importStep(req: Request, env: Env, u: User | null): Promise<Response> {
  const user = requireUser(u);
  const b = await readJson<{ storageId?: string; folder?: string; targetStorageId?: string; name?: string; restoreMembers?: boolean; state?: ImportState }>(req);
  const source = await usableStorage(env, user.id, str(b.storageId, 'storageId', 80));
  if (!source) throw new HttpError(400, 'that storage is not yours and was not shared with you');
  if (!folderOk(b.folder)) throw new HttpError(400, 'invalid backup folder');
  const target = await usableStorage(env, user.id, str(b.targetStorageId ?? b.storageId, 'targetStorageId', 80));
  if (!target) throw new HttpError(400, 'the storage for the new workspace is not yours and was not shared with you');
  const from = new WebDav(source);
  const base = `${BACKUP_ROOT}/${b.folder}`;

  if (!b.state) {
    // Start: create the workspace and its projects.
    if (user.role !== 'admin') {
      const row = await env.DB.prepare('SELECT can_create_workspaces FROM users WHERE id = ?').bind(user.id).first<{ can_create_workspaces: number }>();
      if (!row?.can_create_workspaces) throw new HttpError(403, 'your account may not create workspaces');
    }
    const m = await readMeta<Manifest>(from, `${base}/manifest.json`);
    if (m.format !== FORMAT || m.version !== VERSION) throw new HttpError(422, 'this folder is not a Cloud Doc backup this version can read');
    if (!m.complete) throw new HttpError(422, 'this backup was never finished');
    if (!Array.isArray(m.projects) || m.projects.length > MAX_PROJECTS) throw new HttpError(422, `a backup can hold at most ${MAX_PROJECTS} projects`);

    let name = (typeof b.name === 'string' && b.name.trim() ? b.name : String(m.workspace?.name ?? 'Imported')).trim().slice(0, 80) || 'Imported';
    for (let n = 0; ; n++) {
      const candidate = n === 0 ? name : `${name.slice(0, 70)} (${n === 1 ? 'restored' : `restored ${n}`})`;
      const taken = await env.DB.prepare(
        `SELECT 1 FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE wm.user_id = ? AND wm.role = 'owner' AND lower(w.name) = lower(?)`
      )
        .bind(user.id, candidate)
        .first();
      if (!taken) {
        name = candidate;
        break;
      }
      if (n > 20) throw new HttpError(409, 'pick another name for the restored workspace');
    }
    const wid = newId();
    const now = Date.now();
    const stmts = [
      env.DB.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').bind(wid, name, now),
      env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(wid, user.id),
      env.DB.prepare('INSERT INTO workspace_storage_bindings (workspace_id, storage_id, created_at, granted_user_id) VALUES (?, ?, ?, ?)').bind(
        wid,
        target.id,
        now,
        target.shared ? user.id : null
      ),
    ];
    const roles = ['viewer', 'commenter', 'editor', 'admin'];
    for (const p of m.projects) {
      const role = typeof p.default_role === 'string' && roles.includes(p.default_role) ? p.default_role : null;
      stmts.push(
        env.DB.prepare('INSERT INTO projects (id, workspace_id, name, default_role, created_at) VALUES (?, ?, ?, ?, ?)').bind(
          await deriveId(wid, String(p.id)),
          wid,
          text(p.name, 80) || 'Project',
          role,
          now
        )
      );
    }
    await env.DB.batch(stmts);
    if (b.restoreMembers) await restoreMembers(env, wid, user.id, m);
    const state: ImportState = { workspaceId: wid, phase: 'pages', seq: 0, done: { pages: 0, comments: 0, files: 0, versions: 0 }, failed: [] };
    return json({ state, totals: m.counts, workspace: { id: wid, name }, done: false });
  }

  const st = b.state;
  if (!PHASES.includes(st.phase) || typeof st.workspaceId !== 'string') throw new HttpError(400, 'invalid import state');
  const wid = st.workspaceId;
  await requireOwner(env, user, wid);
  st.failed = (st.failed ?? []).slice(0, 200);
  st.done ??= { pages: 0, comments: 0, files: 0, versions: 0 };
  const meta = await readMeta<{ rows: Record<string, unknown>[]; next: number | null }>(from, `${base}/meta/${st.phase}-${st.seq}.json`);
  const rows = Array.isArray(meta.rows) ? meta.rows.slice(0, 100) : [];
  const fail = (kind: string, id: unknown, err: unknown) => st.failed.push({ kind, id: String(id).slice(0, 80), error: err instanceof Error ? err.message : String(err) });
  const d = (id: unknown) => deriveId(wid, String(id));

  if (st.phase === 'pages') {
    const ready: { oldId: string; id: string }[] = [];
    for (const r of rows) {
      try {
        const id = await d(r.id);
        const parent = r.parent_id ? await d(r.parent_id) : null;
        await env.DB.prepare(
          `INSERT OR IGNORE INTO pages (id, project_id, parent_id, title, position, created_by, created_at, updated_at, icon)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?2 AND workspace_id = ?10)
             AND (?3 IS NULL OR EXISTS (SELECT 1 FROM pages WHERE id = ?3))`
        )
          .bind(id, await d(r.project_id), parent, text(r.title, 500) ?? '', typeof r.position === 'number' ? r.position : 0, user.id, int(r.created_at) ?? Date.now(), int(r.updated_at) ?? Date.now(), text(r.icon, 16) ?? '', wid)
          .run();
        ready.push({ oldId: String(r.id), id });
      } catch (err) {
        fail('page', r.id, err);
      }
    }
    await pool(ready, 4, async (p) => {
      try {
        const res = await from.get(`${base}/pages/${p.oldId}.ydoc`);
        if (!res.ok) throw new Error(`document missing from the backup (${res.status})`);
        await loadRoom(env, p.id, new Uint8Array(await res.arrayBuffer()), { workspaceId: wid, oldPageId: p.oldId });
        st.done.pages++;
      } catch (err) {
        fail('page', p.oldId, err);
      }
    });
  } else if (st.phase === 'comments') {
    const authors = await env.DB.prepare('SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(rows.map((r) => r.author_id).filter((x) => typeof x === 'string')))
      .all<{ id: string }>();
    const known = new Set(authors.results.map((a) => a.id));
    const stmts = [];
    for (const r of rows) {
      try {
        const fileMap = new Map<string, string>();
        for (const id of [...String(r.body ?? '').matchAll(/\/api\/files\/([0-9a-f-]{36})\//g), ...String(r.quote_pdf_url ?? '').matchAll(/\/api\/files\/([0-9a-f-]{36})\//g)]) {
          fileMap.set(id[1]!, await d(id[1]));
        }
        const visibility = r.visibility === 'mentioned' ? 'mentioned' : 'public';
        stmts.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO comments (id, page_id, thread_id, author_id, author_name, quote, body, created_at, edited_at, resolved_at, resolved_by_name,
               visibility, visible_to_json, quote_page, quote_rects, quote_pdf_url, quote_color, quote_shape, quote_start, quote_end, parent_id)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM pages p JOIN projects pr ON pr.id = p.project_id WHERE p.id = ? AND pr.workspace_id = ?)`
          ).bind(
            await d(r.id),
            await d(r.page_id),
            await d(r.thread_id),
            typeof r.author_id === 'string' && known.has(r.author_id) ? r.author_id : null,
            text(r.author_name, 200) ?? '',
            text(r.quote, 500),
            mapFileUrls(text(r.body, 5000) ?? '', fileMap),
            int(r.created_at) ?? Date.now(),
            int(r.edited_at),
            int(r.resolved_at),
            text(r.resolved_by_name, 200),
            visibility,
            text(r.visible_to_json, 5000) ?? '[]',
            int(r.quote_page),
            text(r.quote_rects, 20000),
            r.quote_pdf_url ? mapFileUrls(text(r.quote_pdf_url, 2000) ?? '', fileMap) : null,
            text(r.quote_color, 20),
            text(r.quote_shape, 20),
            int(r.quote_start),
            int(r.quote_end),
            r.parent_id ? await d(r.parent_id) : null,
            await d(r.page_id),
            wid
          )
        );
        st.done.comments++;
      } catch (err) {
        fail('comment', r.id, err);
      }
    }
    if (stmts.length) await env.DB.batch(stmts);
  } else {
    const isFiles = st.phase === 'files';
    const to = new WebDav(target);
    let bytes = 0;
    for (const r of rows) {
      if (r.missing) {
        fail(isFiles ? 'file' : 'version', r.id, 'was not in the backup (it could not be read when the backup was made)');
        continue;
      }
      try {
        const size = int(r.size) ?? 0;
        if (bytes >= BYTE_BUDGET) throw new Error('left for the next step');
        await checkQuota(env, target, user.id, wid, size);
        const blob = await from.get(`${base}/${isFiles ? 'files' : 'history'}/${r.id}`);
        if (!blob.ok) throw new Error(`missing from the backup (${blob.status})`);
        const id = await d(r.id);
        if (isFiles) {
          const name = (text(r.name, 120) ?? 'file').replace(/[/\\\u0000-\u001f]+/g, '_');
          const mime = text(r.mime, 200) || 'application/octet-stream';
          const key = fileKey(wid, id, name.replace(/[^\w.\- ]+/g, '_'));
          await to.put(key, blob.body, mime, String(size));
          const page = r.page_id ? await d(r.page_id) : null;
          const refs = await Promise.all((Array.isArray(r.refs) ? r.refs : []).slice(0, 500).map((x) => d(x)));
          await env.DB.batch([
            env.DB.prepare(
              `INSERT OR IGNORE INTO files (id, workspace_id, page_id, owner_id, storage_id, key, name, mime, size, created_at)
               VALUES (?1, ?2, (SELECT id FROM pages WHERE id = ?3), ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
            ).bind(id, wid, page, user.id, target.id, key, name, mime, size, int(r.created_at) ?? Date.now()),
            env.DB.prepare(
              `INSERT OR IGNORE INTO file_refs (file_id, page_id) SELECT ?1, id FROM pages WHERE id IN (SELECT value FROM json_each(?2))`
            ).bind(id, JSON.stringify(refs)),
          ]);
        } else {
          const pageId = await d(r.page_id);
          const key = historyKey(wid, pageId, id);
          await to.put(key, blob.body, 'application/octet-stream', String(size));
          await env.DB.prepare(
            `INSERT OR IGNORE INTO page_versions (id, page_id, kind, title, created_by_name, size, storage_key, storage_id, owner_id, created_at)
             SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ? FROM pages WHERE id = ?`
          )
            .bind(id, ['auto', 'manual', 'before-restore'].includes(String(r.kind)) ? r.kind : 'manual', text(r.title, 500) ?? '', text(r.created_by_name, 200), size, key, target.id, user.id, int(r.created_at) ?? Date.now(), pageId)
            .run();
        }
        st.done[st.phase]++;
        bytes += size;
      } catch (err) {
        fail(isFiles ? 'file' : 'version', r.id, err);
      }
    }
  }

  if (meta.next != null && Number.isInteger(meta.next)) st.seq = meta.next;
  else {
    const next = PHASES[PHASES.indexOf(st.phase) + 1];
    if (!next) return json({ state: st, done: true, failed: st.failed });
    st.phase = next;
    st.seq = 0;
  }
  return json({ state: st, done: false });
}

/** Optional: put people from the backup back into the workspace (accounts that exist, invites for the rest). */
async function restoreMembers(env: Env, wid: string, ownerId: string, m: Manifest): Promise<void> {
  const members = (m.members ?? []).slice(0, 100).filter((x) => typeof x.email === 'string' && (x.role === 'admin' || x.role === 'member'));
  if (!members.length) return;
  const found = await env.DB.prepare('SELECT id, email FROM users WHERE disabled = 0 AND lower(email) IN (SELECT lower(value) FROM json_each(?))')
    .bind(JSON.stringify(members.map((x) => x.email)))
    .all<{ id: string; email: string }>();
  const byEmail = new Map(found.results.map((x) => [x.email.toLowerCase(), x.id]));
  const stmts = [];
  for (const x of members) {
    const id = byEmail.get(x.email.toLowerCase());
    if (id === ownerId) continue;
    stmts.push(
      id
        ? env.DB.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').bind(wid, id, x.role)
        : env.DB.prepare('INSERT OR IGNORE INTO workspace_invites (workspace_id, email, role, created_at) VALUES (?, ?, ?, ?)').bind(wid, x.email.toLowerCase().slice(0, 200), x.role, Date.now())
    );
  }
  if (stmts.length) await env.DB.batch(stmts.slice(0, 40));
}
