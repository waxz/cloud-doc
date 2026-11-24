import {
  atLeast,
  isRole,
  pageAccess,
  type Role,
  requirePage,
  requireProject,
  requireWorkspace,
  SHARE_COOKIE,
  projectRole,
  visibleProjects,
} from './access.js';
import { requireUser, type User } from './auth.js';
import { deletePageHistory, storageById, WebDav, workspaceOfPage } from './storage.js';
import { deleteTreeFiles } from './files.js';
import type { Env } from './env.js';
import { exportRoom, room, tellRoom } from './rooms.js';
import { cookie, HttpError, json, newId, noContent, randomToken, readJson, str } from './http.js';

const PAGE_COLS = 'id, project_id, parent_id, title, icon, position, updated_at';

// ---------- pages ----------

export async function listPages(req: Request, env: Env, u: User | null, pid: string): Promise<Response> {
  await requireProject(env, u, pid, 'viewer');
  const { results } = await env.DB.prepare(`SELECT ${PAGE_COLS} FROM pages WHERE project_id = ? ORDER BY position`)
    .bind(pid)
    .all();
  return json(results);
}

export async function getPage(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const access = await requirePage(req, env, u, id, 'viewer');
  const project = await env.DB.prepare('SELECT id, name, workspace_id FROM projects WHERE id = ?')
    .bind(access.page.project_id)
    .first();
  // Breadcrumb from the root down to this page.
  const { results: path } = await env.DB.prepare(
    `WITH RECURSIVE up(id, parent_id, title, depth) AS (
       SELECT id, parent_id, title, 0 FROM pages WHERE id = ?
       UNION ALL SELECT p.id, p.parent_id, p.title, up.depth + 1 FROM pages p JOIN up ON p.id = up.parent_id)
     SELECT id, title FROM up ORDER BY depth DESC`
  )
    .bind(id)
    .all<{ id: string; title: string }>();
  // Through a share link, only show the part of the tree the link covers.
  const visible = [];
  for (const p of path) if (!access.viaShare || (await pageAccess(req, env, u, p.id))) visible.push(p);
  return json({
    page: access.page,
    role: access.role,
    viaShare: access.viaShare,
    project: access.viaShare ? null : project,
    path: visible,
  });
}

export async function createPage(req: Request, env: Env, u: User | null, pid: string): Promise<Response> {
  const user = requireUser(u);
  await requireProject(env, user, pid, 'editor');
  // `position` places it among its new siblings (the client sends the midpoint
  // between its neighbours); without it the page goes last.
  const { parentId = null, position } = await readJson<{ parentId?: string | null; position?: number }>(req);
  if (position !== undefined && !Number.isFinite(position)) throw new HttpError(400, 'position must be a number');
  if (parentId) {
    const parent = await env.DB.prepare('SELECT project_id FROM pages WHERE id = ?').bind(parentId).first<{ project_id: string }>();
    if (parent?.project_id !== pid) throw new HttpError(400, 'parent page is not in this project');
  }
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO pages (id, project_id, parent_id, title, position, created_by, created_at, updated_at)
     VALUES (?, ?, ?, '', (SELECT COALESCE(MAX(position), 0) + 1 FROM pages WHERE project_id = ? AND parent_id IS ?), ?, ?, ?)
     RETURNING ${PAGE_COLS}`
  )
    .bind(newId(), pid, parentId, pid, parentId, user.id, now, now)
    .first();
  return json(row, 201);
}

export async function movePage(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const user = requireUser(u);
  const { page } = await requirePage(req, env, user, id, 'editor');
  await requireProject(env, user, page.project_id, 'editor');
  // `position` places it among its new siblings (the client sends the midpoint
  // between its neighbours); without it the page goes last.
  const { parentId = null, position } = await readJson<{ parentId?: string | null; position?: number }>(req);
  if (position !== undefined && !Number.isFinite(position)) throw new HttpError(400, 'position must be a number');
  if (parentId) {
    const parent = await env.DB.prepare('SELECT project_id FROM pages WHERE id = ?').bind(parentId).first<{ project_id: string }>();
    if (parent?.project_id !== page.project_id) throw new HttpError(400, 'pages can only move within their project');
    const cycle = await env.DB.prepare(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id)
       SELECT 1 FROM sub WHERE id = ?`
    )
      .bind(id, parentId)
      .first();
    if (cycle) throw new HttpError(400, 'cannot move a page under itself');
  }
  const row = await env.DB.prepare(
    `UPDATE pages SET parent_id = ?,
       position = COALESCE(?, (SELECT COALESCE(MAX(position), 0) + 1 FROM pages WHERE project_id = ? AND parent_id IS ?))
     WHERE id = ? RETURNING ${PAGE_COLS}`
  )
    .bind(parentId, position ?? null, page.project_id, parentId, id)
    .first();
  return json(row);
}

/**
 * Deletes a page and its subpages: rows, search entries, live rooms and history. Files belong to the
 * workspace and stay, unless `files` says to delete the ones no other page uses (and the user may delete).
 */
export async function deletePageTree(env: Env, id: string, files?: { user: User }): Promise<{ filesDeleted: number; filesKept: number }> {
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id)
     SELECT id FROM sub`
  )
    .bind(id)
    .all<{ id: string }>();
  const ids = results.map((r) => r.id);
  // Files and history first, while their rows still say which storages hold them.
  const workspaceId = await workspaceOfPage(env, id);
  const outcome = files ? await deleteTreeFiles(env, files.user, ids) : { filesDeleted: 0, filesKept: 0 };
  for (const pid of ids) await deletePageHistory(env, workspaceId, pid);
  await env.DB.batch([
    ...ids.map((pid) => env.DB.prepare('DELETE FROM pages_fts WHERE page_id = ?').bind(pid)),
    env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(id), // the rest follows via ON DELETE CASCADE
  ]);
  for (const pid of ids) {
    const stub = await room(env, pid);
    await stub.fetch(new Request('http://room/', { method: 'DELETE' }));
  }
  return outcome;
}

export async function deletePage(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const user = requireUser(u);
  const { page } = await requirePage(req, env, user, id, 'editor');
  await requireProject(env, user, page.project_id, 'editor');
  // ?files=delete also removes the files only this page (and its subpages) use; shared ones always stay.
  const deleteFiles = new URL(req.url).searchParams.get('files') === 'delete';
  const outcome = await deletePageTree(env, id, deleteFiles ? { user } : undefined);
  return json(outcome);
}

// ---------- search ----------

export async function search(env: Env, u: User | null, wid: string, q: string): Promise<Response> {
  const user = requireUser(u);
  await requireWorkspace(env, user, wid);
  const visible = (await visibleProjects(env, user, wid)).map((p) => p.id);
  // Each word becomes a quoted prefix term, so user input can't break the FTS5 syntax.
  const terms = q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
  if (terms.length === 0 || visible.length === 0) return json([]);
  const { results } = await env.DB.prepare(
    `SELECT page_id AS id, project_id, title, snippet(pages_fts, 3, '<mark>', '</mark>', '…', 12) AS snippet, body
     FROM pages_fts WHERE pages_fts MATCH ? AND project_id IN (${visible.map(() => '?').join(',')})
     ORDER BY rank LIMIT 20`
  )
    .bind(terms.join(' '), ...visible)
    .all<{ id: string; project_id: string; title: string; snippet: string; body: string }>();
  const words = q.split(/\s+/).filter(Boolean).map(fold);
  // Finding the matches reads each page's whole text: do it for the best few only, and cap how much
  // of a long page is read, to stay inside the Free plan's CPU time per request.
  return json(results.map(({ body, ...hit }, index) => ({ ...hit, matches: index < 10 ? findMatches(body.slice(0, 200_000), words) : [] })));
}

/** Lower-cases and drops accents one character at a time, so offsets still line up with the original. */
function fold(text: string): string {
  let out = '';
  for (const c of text) {
    const base = c.normalize('NFD')[0] ?? c;
    const lower = base.toLowerCase();
    out += lower.length === base.length ? lower : base;
  }
  return out;
}

export interface SearchMatch {
  /** Which occurrence of the search words this is, counting from 0, so the page can jump to it. */
  n: number;
  before: string;
  text: string;
  after: string;
}

/** Where the words occur in a page's text, with a little context: the first few per page. */
function findMatches(body: string, words: string[], limit = 4): SearchMatch[] {
  if (!words.length) return [];
  const folded = fold(body);
  if (folded.length !== body.length) return [];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[\\p{L}\\p{N}]*`, 'gu');
  const out: SearchMatch[] = [];
  let n = 0;
  for (const m of folded.matchAll(pattern)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (out.length < limit) {
      const flat = (t: string) => t.replace(/\s*\n\s*/g, ' ⏎ ');
      out.push({
        n,
        before: flat(body.slice(Math.max(0, start - 45), start)),
        text: body.slice(start, end),
        after: flat(body.slice(end, Math.min(end + 90, folded.slice(end).search(pattern) > 0 ? end + folded.slice(end).search(pattern) : end + 90))),
      });
    }
    n++;
  }
  return out;
}

async function requireHistoryAccess(req: Request, env: Env, u: User | null, id: string) {
  const access = await requirePage(req, env, u, id, 'viewer');
  if (access.viaShare) throw new HttpError(403, 'history is only available to project members');
  return access;
}

export async function listVersions(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  await requireHistoryAccess(req, env, u, id);
  const { results } = await env.DB.prepare(
    'SELECT id, kind, title, created_by_name, size, created_at FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 200'
  )
    .bind(id)
    .all();
  return json(results);
}

export async function saveVersion(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  await requirePage(req, env, u, id, 'editor');
  const user = requireUser(u);
  return tellRoom(env, id, '/snapshot', { by: user.name, userId: user.id });
}

export async function versionContent(req: Request, env: Env, u: User | null, id: string, vid: string): Promise<Response> {
  await requireHistoryAccess(req, env, u, id);
  const row = await env.DB.prepare('SELECT storage_key, storage_id FROM page_versions WHERE id = ? AND page_id = ?')
    .bind(vid, id)
    .first<{ storage_key: string; storage_id: string | null }>();
  if (!row) throw new HttpError(404, 'no such version');
  const storage = await storageById(env, row.storage_id);
  if (!storage) throw new HttpError(410, 'the storage holding this version was removed');
  const res = await new WebDav(storage).get(row.storage_key);
  if (!res.ok) throw new HttpError(502, 'version not available from its storage');
  return new Response(res.body, {
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' },
  });
}

export async function restoreVersion(req: Request, env: Env, u: User | null, id: string, vid: string): Promise<Response> {
  await requirePage(req, env, u, id, 'editor');
  const user = requireUser(u);
  return tellRoom(env, id, '/restore', { versionId: vid, by: user.name, userId: user.id });
}

// ---------- comments ----------

export async function listComments(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const access = await requirePage(req, env, u, id, 'viewer');
  // A published (view-only) link shows the page, not the team's discussion.
  if (access.viaShare && !atLeast(access.role, 'commenter')) throw new HttpError(403, 'comments are not shared through this link');
  const userId = u?.id ?? '';
  const { results } = await env.DB.prepare(
    `SELECT id, thread_id, author_id, author_name, quote, quote_page, quote_rects, quote_pdf_url, quote_color, quote_shape, quote_start, quote_end, body, created_at, edited_at, resolved_at, resolved_by_name, visibility, parent_id
     FROM comments
     WHERE page_id = ? AND (visibility = 'public' OR author_id = ? OR (visibility = 'mentioned' AND instr(visible_to_json, '"' || ? || '"') > 0))
     ORDER BY created_at`
  )
    .bind(id, userId, userId)
    .all();
  return json(results);
}

/** Active members of the page's workspace, for mention matching. */
async function pageMembers(env: Env, pageId: string) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name FROM pages pg JOIN projects p ON p.id = pg.project_id
     JOIN workspace_members wm ON wm.workspace_id = p.workspace_id JOIN users u ON u.id = wm.user_id
     WHERE pg.id = ? AND u.disabled = 0`
  ).bind(pageId).all<{ id: string; name: string }>();
  return results;
}

function mentionedIn(body: string, members: { id: string; name: string }[]) {
  const text = body.toLocaleLowerCase();
  return members.filter((m) => text.includes(`@${m.name.toLocaleLowerCase()}`)).map((m) => m.id);
}

/** A private thread is visible to the people mentioned in it and to everyone who posted in it. */
async function syncThreadVisibility(env: Env, pageId: string, threadId: string, extra: string[] = []) {
  const { results } = await env.DB.prepare('SELECT author_id, body FROM comments WHERE thread_id = ?').bind(threadId).all<{ author_id: string; body: string }>();
  const members = await pageMembers(env, pageId);
  const ids = new Set<string>(extra.filter((x) => members.some((m) => m.id === x)));
  for (const row of results) {
    ids.add(row.author_id);
    for (const m of mentionedIn(row.body, members)) ids.add(m);
  }
  await env.DB.prepare('UPDATE comments SET visible_to_json = ? WHERE thread_id = ?').bind(JSON.stringify([...ids]), threadId).run();
}

export async function addComment(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const user = requireUser(u);
  await requirePage(req, env, user, id, 'commenter');
  const b = await readJson<{
    body?: string;
    quote?: string;
    quotePage?: number;
    quoteRects?: unknown;
    quotePdfUrl?: string;
    quoteColor?: string;
    quoteShape?: string;
    quoteStart?: number;
    quoteEnd?: number;
    threadId?: string;
    parentId?: string;
    mentionIds?: unknown;
    visibility?: unknown;
  }>(req);
  const quote = !b.threadId && typeof b.quote === 'string' && b.quote.trim() ? b.quote.trim().slice(0, 500) : null;
  const body = quote
    ? (typeof b.body === 'string' ? b.body.trim().slice(0, 5000) : '')
    : str(b.body, 'comment', 5000);
  const commentId = newId();
  let threadId: string = commentId;
  let parentId: string | null = null;
  let visibility: 'public' | 'mentioned' = b.visibility === 'mentioned' ? 'mentioned' : 'public';
  let visibleTo: string[] = [];
  if (b.threadId) {
    const thread = await env.DB.prepare('SELECT id, visibility, visible_to_json FROM comments WHERE id = ? AND page_id = ? AND thread_id = id')
      .bind(b.threadId, id)
      .first<{ id: string; visibility: 'public' | 'mentioned'; visible_to_json: string }>();
    if (!thread) throw new HttpError(404, 'no such thread');
    threadId = b.threadId;
    if (typeof b.parentId === 'string' && b.parentId && b.parentId !== b.threadId) {
      const parent = await env.DB.prepare('SELECT id FROM comments WHERE id = ? AND thread_id = ?').bind(b.parentId, b.threadId).first();
      if (!parent) throw new HttpError(404, 'no such comment to reply to');
      parentId = b.parentId;
    }
    visibility = thread.visibility;
    visibleTo = JSON.parse(thread.visible_to_json || '[]');
  } else if (visibility === 'mentioned') {
    if (!Array.isArray(b.mentionIds)) throw new HttpError(400, 'mentioned-only comments need at least one mentioned member');
    visibleTo = b.mentionIds.filter((x): x is string => typeof x === 'string' && x !== user.id);
    if (visibleTo.length === 0) throw new HttpError(400, 'mentioned-only comments need at least one mentioned member');
  }
  const quotePage = !b.threadId && Number.isInteger(b.quotePage) && Number(b.quotePage) > 0 ? Number(b.quotePage) : null;
  const quoteRects = !b.threadId && Array.isArray(b.quoteRects)
    ? JSON.stringify(b.quoteRects
      .filter((r): r is number[] => Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === 'number'))
      .map((r) => r.map((n) => Math.min(1, Math.max(0, n))))
      .slice(0, 200))
    : null;
  const quotePdfUrl = !b.threadId && typeof b.quotePdfUrl === 'string' ? b.quotePdfUrl.slice(0, 2000) : null;
  const quoteColor = !b.threadId && typeof b.quoteColor === 'string'
    ? b.quoteColor.toLowerCase().match(/^(yellow|orange|red|pink|purple|blue|green)$/)?.[0] ?? null
    : null;
  const quoteShape = !b.threadId && typeof b.quoteShape === 'string'
    ? b.quoteShape.toLowerCase().match(/^(highlight|underline|strike|box)$/)?.[0] ?? null
    : null;
  const quoteStart = !b.threadId && Number.isInteger(b.quoteStart) && Number(b.quoteStart) >= 0 ? Number(b.quoteStart) : null;
  const quoteEnd = !b.threadId && Number.isInteger(b.quoteEnd) && Number(b.quoteEnd) >= 0 ? Number(b.quoteEnd) : null;
  const row = await env.DB.prepare(
    `INSERT INTO comments (id, page_id, thread_id, author_id, author_name, quote, quote_page, quote_rects, quote_pdf_url, quote_color, quote_shape, quote_start, quote_end, body, visibility, visible_to_json, created_at, parent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  )
    .bind(commentId, id, threadId, user.id, user.name, quote, quotePage, quoteRects, quotePdfUrl, quoteColor, quoteShape, quoteStart, quoteEnd, body, visibility, JSON.stringify(visibleTo), Date.now(), parentId)
    .first();
  if (visibility === 'mentioned') {
    const extra = Array.isArray(b.mentionIds) ? b.mentionIds.filter((x): x is string => typeof x === 'string') : [];
    await syncThreadVisibility(env, id, threadId, [...extra, ...visibleTo]);
  }
  {
    // An @name typed in the text notifies too, even when the client sent no list of ids.
    const workspace = await env.DB.prepare(
      `SELECT p.workspace_id FROM pages pg JOIN projects p ON p.id = pg.project_id WHERE pg.id = ?`
    ).bind(id).first<{ workspace_id: string }>();
    if (workspace) {
      const requestedIds = (Array.isArray(b.mentionIds) ? b.mentionIds : []).filter((x): x is string => typeof x === 'string' && x !== user.id);
      const members = await env.DB.prepare(
        `SELECT u.id, u.name FROM workspace_members wm JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = ? AND u.disabled = 0`
      ).bind(workspace.workspace_id).all<{ id: string; name: string }>();
      const mentionedFromText = members.results
        .filter((member) => body.toLocaleLowerCase().includes(`@${member.name.toLocaleLowerCase()}`))
        .map((member) => member.id);
      const mentioned = [...new Set([...requestedIds, ...mentionedFromText])];
      // `members` already lists who is in the workspace, so no per-person lookup is needed.
      const memberIds = new Set(members.results.map((m) => m.id));
      const now = Date.now();
      const inserts = mentioned
        .filter((mentionedId) => memberIds.has(mentionedId))
        .map((mentionedId) => env.DB.prepare(
          'INSERT INTO notifications (id, user_id, comment_id, page_id, read_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)'
        ).bind(newId(), mentionedId, commentId, id, now));
      if (inserts.length) await env.DB.batch(inserts);
    }
  }
  await tellRoom(env, id, '/notify', { type: 'comments', from: req.headers.get('x-tab-id') });
  return json(row, 201);
}

export async function listCommentMembers(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const user = requireUser(u);
  await requirePage(req, env, user, id, 'viewer');
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.email
     FROM pages pg JOIN projects p ON p.id = pg.project_id
     JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
     JOIN users u ON u.id = wm.user_id
     WHERE pg.id = ? AND u.disabled = 0 ORDER BY u.name`
  ).bind(id).all();
  return json(results);
}

/** Mentions, messages and to-dos in one response, so the sidebar's poll is one request. */
export async function inbox(env: Env, u: User | null): Promise<Response> {
  return json({ notifications: await listNotifications(env, u).then((r) => r.json()) });
}

export async function listNotifications(env: Env, u: User | null): Promise<Response> {
  const user = requireUser(u);
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.comment_id, n.page_id, n.read_at, n.created_at,
            c.thread_id, c.author_name, c.body, pg.title AS page_title,
            p.workspace_id
     FROM notifications n
     JOIN comments c ON c.id = n.comment_id
     JOIN pages pg ON pg.id = n.page_id
     JOIN projects p ON p.id = pg.project_id
     WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 100`
  ).bind(user.id).all();
  return json(results);
}

export async function markNotificationRead(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const user = requireUser(u);
  const body = await readJson<{ read?: unknown }>(req);
  const read = body.read !== false;
  await env.DB.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?')
    .bind(read ? Date.now() : null, id, user.id).run();
  return noContent();
}

export async function listMessages(env: Env, u: User | null): Promise<Response> {
  const user = requireUser(u);
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.sender_id, m.recipient_id, m.body, m.read_at, m.created_at,
            s.name AS sender_name, r.name AS recipient_name
     FROM private_messages m
     JOIN users s ON s.id = m.sender_id
     JOIN users r ON r.id = m.recipient_id
     WHERE m.sender_id = ? OR m.recipient_id = ?
     ORDER BY m.created_at DESC LIMIT 100`
  ).bind(user.id, user.id).all();
  return json(results);
}

export async function sendMessage(req: Request, env: Env, u: User | null): Promise<Response> {
  const user = requireUser(u);
  const b = await readJson<{ recipientId?: unknown; body?: unknown }>(req);
  const recipientId = str(b.recipientId, 'recipient', 100);
  const body = str(b.body, 'message', 5000);
  if (recipientId === user.id) throw new HttpError(400, 'you cannot message yourself');
  const recipient = await env.DB.prepare(
    `SELECT u.id FROM users u
     WHERE u.id = ? AND u.disabled = 0
       AND EXISTS (
         SELECT 1 FROM workspace_members mine
         JOIN workspace_members theirs ON theirs.workspace_id = mine.workspace_id
         WHERE mine.user_id = ? AND theirs.user_id = u.id
       )`
  ).bind(recipientId, user.id).first();
  if (!recipient) throw new HttpError(404, 'no such recipient');
  const row = await env.DB.prepare(
    `INSERT INTO private_messages (id, sender_id, recipient_id, body, created_at)
     VALUES (?, ?, ?, ?, ?) RETURNING *`
  ).bind(newId(), user.id, recipientId, body, Date.now()).first();
  return json(row, 201);
}

export async function markMessageRead(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const user = requireUser(u);
  const b = await readJson<{ read?: unknown }>(req);
  await env.DB.prepare('UPDATE private_messages SET read_at = ? WHERE id = ? AND recipient_id = ?')
    .bind(b.read === false ? null : Date.now(), id, user.id).run();
  return noContent();
}

export async function listTodos(env: Env, u: User | null): Promise<Response> {
  const user = requireUser(u);
  const { results } = await env.DB.prepare(
    'SELECT id, title, source_type, source_id, references_json, completed_at, created_at FROM todos WHERE user_id = ? ORDER BY completed_at IS NOT NULL, created_at DESC LIMIT 100'
  ).bind(user.id).all();
  return json(results.map((todo) => ({ ...todo, references: parseReferences(todo.references_json) })));
}

export async function addTodo(req: Request, env: Env, u: User | null): Promise<Response> {
  const user = requireUser(u);
  const b = await readJson<{ title?: unknown; sourceType?: unknown; sourceId?: unknown; references?: unknown }>(req);
  const title = str(b.title, 'title', 500);
  const references = parseReferences(b.references);
  const row = await env.DB.prepare(
    'INSERT INTO todos (id, user_id, title, source_type, source_id, references_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *'
  ).bind(newId(), user.id, title, typeof b.sourceType === 'string' ? b.sourceType : null, typeof b.sourceId === 'string' ? b.sourceId : null, JSON.stringify(references), Date.now()).first<Record<string, unknown>>();
  return json(row ? { ...row, references } : row, 201);
}

type TodoReference = { type: 'comment' | 'url'; id?: string; url?: string; label?: string };
function parseReferences(value: unknown): TodoReference[] {
  const parsed = typeof value === 'string' ? JSON.parse(value || '[]') : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is TodoReference => item && (item.type === 'comment' || item.type === 'url') && (!item.id || typeof item.id === 'string') && (!item.url || typeof item.url === 'string'));
}

export async function updateTodo(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const user = requireUser(u);
  const b = await readJson<{ completed?: unknown }>(req);
  await env.DB.prepare('UPDATE todos SET completed_at = ? WHERE id = ? AND user_id = ?')
    .bind(b.completed ? Date.now() : null, id, user.id).run();
  return noContent();
}

async function loadComment(env: Env, cid: string) {
  const c = await env.DB.prepare('SELECT id, page_id, thread_id, author_id FROM comments WHERE id = ?')
    .bind(cid)
    .first<{ id: string; page_id: string; thread_id: string; author_id: string | null }>();
  if (!c) throw new HttpError(404, 'no such comment');
  return c;
}

/** Edit your own comment's text, or resolve/reopen a thread (commenters and up). */
export async function updateComment(req: Request, env: Env, u: User | null, cid: string): Promise<Response> {
  const user = requireUser(u);
  const c = await loadComment(env, cid);
  const { role } = await requirePage(req, env, user, c.page_id, 'commenter');
  const b = await readJson<{ body?: string; resolved?: boolean; visibility?: unknown; mentionIds?: unknown; quoteColor?: unknown; quoteShape?: unknown; quoteStart?: number; quoteEnd?: number; quote?: string }>(req);
  if (b.body !== undefined) {
    if (c.author_id !== user.id) throw new HttpError(403, 'you can only edit your own comments');
    await env.DB.prepare('UPDATE comments SET body = ?, edited_at = ? WHERE id = ?').bind(str(b.body, 'comment', 5000), Date.now(), cid).run();
    const root = await env.DB.prepare('SELECT visibility FROM comments WHERE id = ?').bind(c.thread_id).first<{ visibility: string }>();
    if (root?.visibility === 'mentioned') await syncThreadVisibility(env, c.page_id, c.thread_id);
  }
  if (b.resolved !== undefined) {
    await env.DB.prepare('UPDATE comments SET resolved_at = ?, resolved_by_name = ? WHERE id = ?')
      .bind(b.resolved ? Date.now() : null, b.resolved ? user.name : null, c.thread_id)
      .run();
  }
  if (b.quoteStart !== undefined && b.quoteEnd !== undefined) {
    // Highlight positions follow the document's text, which only people who can edit it change.
    if (!atLeast(role, 'editor')) throw new HttpError(403, 'only editors move highlights');
    const qStart = Number.isInteger(b.quoteStart) && Number(b.quoteStart) >= 0 ? Number(b.quoteStart) : null;
    const qEnd = Number.isInteger(b.quoteEnd) && Number(b.quoteEnd) >= 0 ? Number(b.quoteEnd) : null;
    if (typeof b.quote === 'string') {
      await env.DB.prepare('UPDATE comments SET quote_start = ?, quote_end = ?, quote = ? WHERE id = ?')
        .bind(qStart, qEnd, b.quote.slice(0, 500), cid).run();
    } else {
      await env.DB.prepare('UPDATE comments SET quote_start = ?, quote_end = ? WHERE id = ?')
        .bind(qStart, qEnd, cid).run();
    }
  }
  if (b.quoteColor !== undefined || b.quoteShape !== undefined) {
    if (c.thread_id !== c.id) throw new HttpError(400, 'the highlight style is set on the first comment of a thread');
    if (c.author_id !== user.id && !atLeast(role, 'admin')) throw new HttpError(403, 'you can only restyle your own highlights');
    const color = typeof b.quoteColor === 'string' ? b.quoteColor.toLowerCase().match(/^(yellow|orange|red|pink|purple|blue|green)$/)?.[0] : undefined;
    const shape = typeof b.quoteShape === 'string' ? b.quoteShape.toLowerCase().match(/^(highlight|underline|strike|box)$/)?.[0] : undefined;
    if (b.quoteColor !== undefined && !color) throw new HttpError(400, 'invalid highlight color');
    if (b.quoteShape !== undefined && !shape) throw new HttpError(400, 'invalid highlight shape');
    if (color) await env.DB.prepare('UPDATE comments SET quote_color = ? WHERE id = ?').bind(color, cid).run();
    if (shape) await env.DB.prepare('UPDATE comments SET quote_shape = ? WHERE id = ?').bind(shape, cid).run();
  }
  if (b.visibility !== undefined) {
    if (c.thread_id !== c.id) throw new HttpError(400, 'visibility is set on the whole thread');
    if (c.author_id !== user.id && !atLeast(role, 'admin')) {
      throw new HttpError(403, 'you can only change visibility of your own comments');
    }
    if (b.visibility !== 'public' && b.visibility !== 'mentioned') throw new HttpError(400, 'invalid comment visibility');
    await env.DB.prepare('UPDATE comments SET visibility = ?, visible_to_json = ? WHERE thread_id = ?')
      .bind(b.visibility, '[]', c.thread_id)
      .run();
    if (b.visibility === 'mentioned') {
      const extra = Array.isArray(b.mentionIds) ? b.mentionIds.filter((x): x is string => typeof x === 'string') : [];
      await syncThreadVisibility(env, c.page_id, c.thread_id, extra);
    }
  }
  // Moving a highlight with the text changes nothing anyone else needs to reload.
  const anchorOnly = Object.keys(b).every((k) => k === 'quoteStart' || k === 'quoteEnd' || k === 'quote');
  if (!anchorOnly) await tellRoom(env, c.page_id, '/notify', { type: 'comments', from: req.headers.get('x-tab-id') });
  return noContent();
}

/**
 * The page as it is now, as Yjs bytes, for readers who don't open a live connection (guests on a share link).
 * Anyone who can view the page may fetch it; it is the same content the live connection would have sent.
 */
export async function pageSnapshot(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  await requirePage(req, env, u, id, 'viewer');
  return new Response(await exportRoom(env, id), { headers: { 'content-type': 'application/octet-stream' } });
}

/**
 * Saves where several highlights now sit after an edit, in one request. Quiet on purpose: no live
 * notice (nobody needs to reload because a highlight moved with its text), and rows that already hold
 * these positions are not written.
 */
export async function updateAnchors(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const user = requireUser(u);
  await requirePage(req, env, user, id, 'editor');
  const b = await readJson<{ anchors?: { id?: unknown; start?: unknown; end?: unknown; quote?: unknown }[] }>(req);
  const list = Array.isArray(b.anchors) ? b.anchors.slice(0, 40) : [];
  const stmts = [];
  for (const a of list) {
    if (typeof a.id !== 'string' || !Number.isInteger(a.start) || !Number.isInteger(a.end)) continue;
    const start = Number(a.start);
    const end = Number(a.end);
    if (start < 0 || end < start) continue;
    const quote = typeof a.quote === 'string' ? a.quote.slice(0, 500) : null;
    stmts.push(
      env.DB.prepare(
        `UPDATE comments SET quote_start = ?1, quote_end = ?2, quote = COALESCE(?3, quote)
         WHERE id = ?4 AND page_id = ?5 AND thread_id = id
           AND (quote_start IS NOT ?1 OR quote_end IS NOT ?2 OR (?3 IS NOT NULL AND quote IS NOT ?3))`
      ).bind(start, end, quote, a.id, id)
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return noContent();
}

/** Authors delete their own comments; project admins delete any. Deleting a thread's first comment deletes the thread. */
export async function deleteComment(req: Request, env: Env, u: User | null, cid: string): Promise<Response> {
  const user = requireUser(u);
  const c = await loadComment(env, cid);
  const { role } = await requirePage(req, env, user, c.page_id, 'commenter');
  if (c.author_id !== user.id && !atLeast(role, 'admin')) throw new HttpError(403, 'you can only delete your own comments');
  if (c.thread_id === c.id) await env.DB.prepare('DELETE FROM comments WHERE thread_id = ?').bind(cid).run();
  else {
    // a reply goes together with the replies to it
    await env.DB.prepare(
      `WITH RECURSIVE d(id) AS (SELECT ? UNION SELECT c.id FROM comments c JOIN d ON c.parent_id = d.id)
       DELETE FROM comments WHERE id IN (SELECT id FROM d)`
    ).bind(cid).run();
  }
  await tellRoom(env, c.page_id, '/notify', { type: 'comments', from: req.headers.get('x-tab-id') });
  return noContent();
}

// ---------- share links ----------

const SHARE_ROLES: Role[] = ['viewer', 'commenter', 'editor'];

export async function listShares(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  await requirePage(req, env, requireUser(u), id, 'editor');
  const { results } = await env.DB.prepare(
    `SELECT s.token, s.role, s.include_subpages, s.expires_at, s.created_at, u.name AS created_by_name
     FROM page_shares s LEFT JOIN users u ON u.id = s.created_by WHERE s.page_id = ? ORDER BY s.created_at DESC`
  )
    .bind(id)
    .all();
  return json(results);
}

/** Editors share for viewing or commenting; edit links need a project admin. */
export async function createShare(req: Request, env: Env, u: User | null, id: string): Promise<Response> {
  const user = requireUser(u);
  const { page } = await requirePage(req, env, user, id, 'editor');
  const b = await readJson<{ role?: string; includeSubpages?: boolean; expiresInDays?: number | null }>(req);
  const role = isRole(b.role) && SHARE_ROLES.includes(b.role) ? b.role : 'viewer';
  if (role === 'editor') await requireProject(env, user, page.project_id, 'admin');
  else await requireProject(env, user, page.project_id, 'editor');
  const days = Number(b.expiresInDays);
  const expiresAt = days > 0 ? Date.now() + Math.min(days, 3650) * 86_400_000 : null;
  const token = randomToken(24);
  await env.DB.prepare(
    `INSERT INTO page_shares (token, page_id, role, include_subpages, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(token, id, role, b.includeSubpages === false ? 0 : 1, expiresAt, user.id, Date.now())
    .run();
  return json({ token, role, include_subpages: b.includeSubpages === false ? 0 : 1, expires_at: expiresAt }, 201);
}

export async function deleteShare(req: Request, env: Env, u: User | null, token: string): Promise<Response> {
  const user = requireUser(u);
  const share = await env.DB.prepare('SELECT page_id FROM page_shares WHERE token = ?').bind(token).first<{ page_id: string }>();
  if (!share) throw new HttpError(404, 'no such link');
  const { page } = await requirePage(req, env, user, share.page_id, 'editor');
  await requireProject(env, user, page.project_id, 'editor');
  await env.DB.prepare('DELETE FROM page_shares WHERE token = ?').bind(token).run();
  return noContent();
}

/**
 * Opens a share link: remembers the token in a cookie (so page data, images
 * and live sync all carry it) and returns the pages it covers.
 */
export async function openShare(env: Env, u: User | null, token: string): Promise<Response> {
  const share = await env.DB.prepare(
    'SELECT page_id, role, include_subpages, expires_at FROM page_shares WHERE token = ? AND (expires_at IS NULL OR expires_at > ?)'
  )
    .bind(token, Date.now())
    .first<{ page_id: string; role: Role; include_subpages: number; expires_at: number | null }>();
  if (!share) throw new HttpError(404, 'this link has expired or was removed');
  const pages = share.include_subpages
    ? (
        await env.DB.prepare(
          `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id)
           SELECT ${PAGE_COLS} FROM pages WHERE id IN (SELECT id FROM sub) ORDER BY position`
        )
          .bind(share.page_id)
          .all()
      ).results
    : [await env.DB.prepare(`SELECT ${PAGE_COLS} FROM pages WHERE id = ?`).bind(share.page_id).first()];
  const maxAge = share.expires_at ? Math.floor((share.expires_at - Date.now()) / 1000) : 30 * 86_400;
  return json(
    { rootPageId: share.page_id, linkRole: share.role, role: u ? share.role : 'viewer', signedIn: !!u, pages },
    200,
    { 'set-cookie': cookie(SHARE_COOKIE, token, maxAge) }
  );
}
