import { isRole, type Role, requireProject, requireWorkspace, type WorkspaceRole, visibleProjects } from './access.js';
import { getAppSetting, requireAdmin, requireUser, type User } from './auth.js';
import type { Env } from './env.js';
import { HttpError, json, newId, noContent, readJson, str } from './http.js';
import { deletePageTree } from './pages.js';
import { defaultLimits, deleteWorkspaceData, maxFileBytes, workspaceLimits, workspaceUsage } from './storage.js';
import { usableStorage } from './settings.js';

// ---------- workspaces and members ----------

export async function createWorkspace(req: Request, env: Env, u: User | null): Promise<Response> {
  const user = requireUser(u);
  if (user.role !== 'admin') {
    const row = await env.DB.prepare('SELECT can_create_workspaces FROM users WHERE id = ?').bind(user.id).first<{ can_create_workspaces: number }>();
    if (!row?.can_create_workspaces) throw new HttpError(403, 'your account may not create workspaces');
  }
  const body = await readJson<{ name?: string; storageId?: string }>(req);
  const name = str(body.name, 'name', 80);
  // A workspace keeps its files and page history in a storage, so it can't exist without one: the user's
  // own, or a shared storage the admin allocated to them. Members then use that storage without their own.
  if (typeof body.storageId !== 'string' || !body.storageId) {
    throw new HttpError(400, 'choose a storage for the workspace: one of yours, or a shared one an admin allocated to you');
  }
  const storage = await usableStorage(env, user.id, body.storageId);
  if (!storage) throw new HttpError(400, 'that storage is not yours and was not shared with you');
  const conflict = await env.DB.prepare(
    `SELECT 1 FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.user_id = ? AND wm.role = 'owner' AND lower(w.name) = lower(?) LIMIT 1`
  ).bind(user.id, name).first();
  if (conflict) throw new HttpError(409, `A workspace named "${name}" already exists in your account`);
  const id = newId();
  const now = Date.now();
  const limits = await defaultLimits(env); // what the admin has set for new workspaces (a playground, say)
  await env.DB.batch([
    env.DB.prepare('INSERT INTO workspaces (id, name, created_at, storage_limit, max_pages, max_comments) VALUES (?, ?, ?, ?, ?, ?)').bind(id, name, now, limits.storageLimit, limits.maxPages, limits.maxComments),
    env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(id, user.id),
    env.DB.prepare('INSERT INTO workspace_storage_bindings (workspace_id, storage_id, created_at, granted_user_id) VALUES (?, ?, ?, ?)').bind(
      id,
      storage.id,
      now,
      storage.shared ? user.id : null
    ),
    // A first project everyone in the workspace can edit.
    env.DB.prepare("INSERT INTO projects (id, workspace_id, name, default_role, created_at) VALUES (?, ?, 'General', 'editor', ?)").bind(
      newId(),
      id,
      now
    ),
  ]);
  return json({ id, name, displayName: name, ownerName: user.name, role: 'owner' }, 201);
}

export async function renameWorkspace(req: Request, env: Env, u: User | null, wid: string): Promise<Response> {
  const user = requireUser(u);
  await requireWorkspace(env, user, wid, true);
  const name = str((await readJson<{ name?: string }>(req)).name, 'name', 80);
  const conflict = await env.DB.prepare(
    `SELECT 1 FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.user_id = ? AND wm.role = 'owner' AND w.id != ? AND lower(w.name) = lower(?) LIMIT 1`
  ).bind(user.id, wid, name).first();
  if (conflict) throw new HttpError(409, `A workspace named "${name}" already exists in your account`);
  await env.DB.prepare('UPDATE workspaces SET name = ? WHERE id = ?').bind(name, wid).run();
  return json({ id: wid, name });
}

export async function deleteWorkspace(env: Env, u: User | null, wid: string): Promise<Response> {
  const user = requireUser(u);
  const role = await requireWorkspace(env, user, wid, true);
  if (role !== 'owner') throw new HttpError(403, 'only the workspace owner can delete it');
  // Its files and page history, from every storage that holds them, while the rows still say where.
  await deleteWorkspaceData(env, wid);
  const { results: projects } = await env.DB.prepare('SELECT id FROM projects WHERE workspace_id = ?')
    .bind(wid).all<{ id: string }>();
  for (const project of projects) await deleteProject(env, u, project.id);
  await env.DB.prepare('DELETE FROM workspaces WHERE id = ?').bind(wid).run();
  return noContent();
}

export async function listMembers(env: Env, u: User | null, wid: string): Promise<Response> {
  await requireWorkspace(env, requireUser(u), wid);
  const members = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ? ORDER BY u.name`
  )
    .bind(wid)
    .all();
  const invites = await env.DB.prepare('SELECT email, role, created_at FROM workspace_invites WHERE workspace_id = ? ORDER BY email')
    .bind(wid)
    .all();
  return json({ members: members.results, invites: invites.results });
}

export async function listAvailableMembers(env: Env, u: User | null, wid: string, q: string): Promise<Response> {
  await requireWorkspace(env, requireUser(u), wid, true);
  const query = q.trim().toLowerCase();
  const pattern = `%${query}%`;
  const users = await env.DB.prepare(
    `SELECT u.id, u.name, u.email
     FROM users u
     WHERE u.disabled = 0
       AND NOT EXISTS (
         SELECT 1 FROM workspace_members wm
         WHERE wm.workspace_id = ? AND wm.user_id = u.id
       )
       AND (? = '' OR lower(u.name) LIKE ? OR lower(u.email) LIKE ?)
     ORDER BY u.name LIMIT 50`
  )
    .bind(wid, query, pattern, pattern)
    .all();
  return json(users.results);
}

const isMemberRole = (r: unknown): r is 'admin' | 'member' => r === 'admin' || r === 'member';

/** Adds an existing account, or records an invite that applies when that email signs up. */
export async function addMember(req: Request, env: Env, u: User | null, wid: string): Promise<Response> {
  await requireWorkspace(env, requireUser(u), wid, true);
  const body = await readJson<{ email?: string; role?: string }>(req);
  const email = str(body.email, 'email').toLowerCase();
  const role = isMemberRole(body.role) ? body.role : 'member';
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
  if (existing) {
    await env.DB.prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'
    )
      .bind(wid, existing.id, role)
      .run();
    return json({ added: true }, 201);
  }
  await env.DB.prepare(
    `INSERT INTO workspace_invites (workspace_id, email, role, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (workspace_id, email) DO UPDATE SET role = excluded.role`
  )
    .bind(wid, email, role, Date.now())
    .run();
  return json({ invited: true }, 201);
}

async function targetRole(env: Env, wid: string, userId: string): Promise<WorkspaceRole> {
  const row = await env.DB.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .bind(wid, userId)
    .first<{ role: WorkspaceRole }>();
  if (!row) throw new HttpError(404, 'not a member');
  return row.role;
}

export async function setMemberRole(req: Request, env: Env, u: User | null, wid: string, userId: string): Promise<Response> {
  await requireWorkspace(env, requireUser(u), wid, true);
  const role = (await readJson<{ role?: string }>(req)).role;
  if (!isMemberRole(role)) throw new HttpError(400, 'role must be admin or member');
  if ((await targetRole(env, wid, userId)) === 'owner') throw new HttpError(403, "the owner's role can't be changed");
  await env.DB.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?').bind(role, wid, userId).run();
  return noContent();
}

export async function removeMember(env: Env, u: User | null, wid: string, userId: string): Promise<Response> {
  const user = requireUser(u);
  // Admins remove others; anyone can leave (except the owner).
  if (userId !== user.id) await requireWorkspace(env, user, wid, true);
  if ((await targetRole(env, wid, userId)) === 'owner') throw new HttpError(403, "the owner can't be removed");
  await env.DB.batch([
    env.DB.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').bind(wid, userId),
    env.DB.prepare(
      'DELETE FROM project_members WHERE user_id = ? AND project_id IN (SELECT id FROM projects WHERE workspace_id = ?)'
    ).bind(userId, wid),
  ]);
  return noContent();
}

export async function removeInvite(env: Env, u: User | null, wid: string, email: string): Promise<Response> {
  await requireWorkspace(env, requireUser(u), wid, true);
  await env.DB.prepare('DELETE FROM workspace_invites WHERE workspace_id = ? AND email = ?').bind(wid, email).run();
  return noContent();
}

// ---------- workspace storage bindings ----------

export async function listWorkspaceStorages(env: Env, u: User | null, wid: string): Promise<Response> {
  const user = requireUser(u);
  await requireWorkspace(env, user, wid);
  // What this user could add: their own storages and shared ones allocated to them. Storages already bound
  // are listed by name too, so members can see where the workspace keeps its data.
  const { results: available } = await env.DB.prepare(
    `SELECT s.id, s.name, s.url, s.username, s.password, s.shared FROM storages s
     WHERE (s.user_id = ?1 AND s.shared = 0)
        OR (s.shared = 1 AND EXISTS (SELECT 1 FROM storage_grants g WHERE g.storage_id = s.id AND g.user_id = ?1))
        OR s.id IN (SELECT storage_id FROM workspace_storage_bindings WHERE workspace_id = ?2)
     ORDER BY s.created_at`
  ).bind(user.id, wid).all<{ id: string; name: string; url: string; username: string; password: string; shared: number; user_id: string }>();
  const { results: assigned } = await env.DB.prepare(
    `SELECT storage_id FROM workspace_storage_bindings WHERE workspace_id = ? ORDER BY created_at`
  ).bind(wid).all<{ storage_id: string }>();
  return json({
    storages: available.map((s) => ({
      id: s.id,
      name: s.name,
      // Another person's address and login are theirs; shared storages keep theirs from users.
      ...(s.shared ? {} : { url: s.url, username: s.username, hasPassword: !!s.password }),
      shared: !!s.shared,
    })),
    assigned: assigned.map((s) => s.storage_id),
  });
}

/** A storage that may be bound to a workspace by this user: theirs, or shared and allocated to them. */
async function bindableStorage(env: Env, user: User, storageId: string) {
  const storage = await usableStorage(env, user.id, storageId);
  if (!storage) throw new HttpError(404, 'no such storage');
  return storage;
}

export async function setWorkspaceStorages(req: Request, env: Env, u: User | null, wid: string): Promise<Response> {
  const user = requireUser(u);
  await requireWorkspace(env, user, wid, true);
  const body = await readJson<{ storageIds?: unknown }>(req);
  if (!Array.isArray(body.storageIds)) throw new HttpError(400, 'storageIds must be an array');
  const ids = [...new Set(body.storageIds.filter((id): id is string => typeof id === 'string'))];
  if (ids.length === 0) throw new HttpError(400, 'a workspace needs at least one storage');
  const { results: current } = await env.DB.prepare('SELECT storage_id FROM workspace_storage_bindings WHERE workspace_id = ?').bind(wid).all<{ storage_id: string }>();
  const already = new Set(current.map((c) => c.storage_id));
  const fresh: { id: string; shared: boolean }[] = [];
  for (const id of ids) if (!already.has(id)) fresh.push({ id, shared: !!(await bindableStorage(env, user, id)).shared });
  await env.DB.batch([
    // Bindings made by someone else stay when they're kept in the list; they're left exactly as they were.
    ...current.filter((c) => !ids.includes(c.storage_id)).map((c) => env.DB.prepare('DELETE FROM workspace_storage_bindings WHERE workspace_id = ? AND storage_id = ?').bind(wid, c.storage_id)),
    ...fresh.map((f) => env.DB.prepare(
      'INSERT INTO workspace_storage_bindings (workspace_id, storage_id, created_at, granted_user_id) VALUES (?, ?, ?, ?)'
    ).bind(wid, f.id, Date.now(), f.shared ? user.id : null)),
  ]);
  return noContent();
}

export async function bindWorkspaceStorage(req: Request, env: Env, u: User | null, wid: string, sid: string): Promise<Response> {
  const user = requireUser(u);
  await requireWorkspace(env, user, wid, true);
  const storage = await bindableStorage(env, user, sid);
  await env.DB.prepare(
    'INSERT INTO workspace_storage_bindings (workspace_id, storage_id, created_at, granted_user_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING'
  ).bind(wid, sid, Date.now(), storage.shared ? user.id : null).run();
  return noContent();
}

export async function unbindWorkspaceStorage(env: Env, u: User | null, wid: string, sid: string): Promise<Response> {
  await requireWorkspace(env, requireUser(u), wid, true);
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM workspace_storage_bindings WHERE workspace_id = ?').bind(wid).first<{ n: number }>();
  if ((count?.n ?? 0) <= 1) throw new HttpError(409, 'a workspace needs a storage: add another one before removing this one');
  await env.DB.prepare('DELETE FROM workspace_storage_bindings WHERE workspace_id = ? AND storage_id = ?').bind(wid, sid).run();
  return noContent();
}

// ---------- projects ----------

/** Projects this user can see, with their role in each. */
export async function listProjects(env: Env, u: User | null, wid: string): Promise<Response> {
  return json(await visibleProjects(env, requireUser(u), wid));
}

/**
 * The sidebar's page tree in one request. For a workspace with up to `tree_lazy_over` pages (default 1500) that is every
 * page. Past that it is only the top-level pages plus the children of the pages the caller has opened (`open`, a comma list;
 * `focus`, the page being read, opens the way down to it), each flagged `has_children`, and `partial` says so: the browser
 * asks again with more ids as the person unfolds the tree.
 */
export async function listWorkspacePages(env: Env, u: User | null, wid: string, url?: URL): Promise<Response> {
  const projects = await visibleProjects(env, requireUser(u), wid);
  const pagesByProject: Record<string, unknown[]> = Object.fromEntries(projects.map((p) => [p.id, []]));
  let partial = false;
  if (projects.length) {
    const visible = JSON.stringify(projects.map((p) => p.id));
    const threshold = Number(await getAppSetting(env, 'tree_lazy_over')) || 1500;
    const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM pages WHERE project_id IN (SELECT value FROM json_each(?))').bind(visible).first<{ n: number }>())?.n ?? 0;
    let results: { project_id: string }[];
    if (total <= threshold) {
      ({ results } = await env.DB.prepare(
        `SELECT id, project_id, parent_id, title, icon, position, updated_at FROM pages
         WHERE project_id IN (SELECT value FROM json_each(?)) ORDER BY position`
      )
        .bind(visible)
        .all<{ project_id: string }>());
    } else {
      partial = true;
      const open = new Set((url?.searchParams.get('open') ?? '').split(',').filter((x) => /^[\w-]{1,80}$/.test(x)).slice(0, 200));
      const focus = url?.searchParams.get('focus') ?? '';
      if (/^[\w-]{1,80}$/.test(focus)) {
        const { results: up } = await env.DB.prepare(
          `WITH RECURSIVE up(id, parent_id) AS (
             SELECT id, parent_id FROM pages WHERE id = ?1
             UNION ALL SELECT p.id, p.parent_id FROM pages p JOIN up ON p.id = up.parent_id)
           SELECT id FROM up WHERE id != ?1 LIMIT 50`
        )
          .bind(focus)
          .all<{ id: string }>();
        for (const row of up) open.add(row.id);
      }
      ({ results } = await env.DB.prepare(
        `SELECT id, project_id, parent_id, title, icon, position, updated_at,
                EXISTS (SELECT 1 FROM pages c WHERE c.parent_id = pages.id) AS has_children
         FROM pages
         WHERE project_id IN (SELECT value FROM json_each(?1))
           AND (parent_id IS NULL OR parent_id IN (SELECT value FROM json_each(?2)))
         ORDER BY position LIMIT 5000`
      )
        .bind(visible, JSON.stringify([...open]))
        .all<{ project_id: string }>());
    }
    for (const page of results) pagesByProject[page.project_id]?.push(page);
  }
  // Whether anyone else could be changing the tree: a workspace of one has nothing to poll for.
  const people = await env.DB.prepare('SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?').bind(wid).first<{ n: number }>();
  return json({ projects, pages: pagesByProject, members: people?.n ?? 1, partial });
}

const parseDefaultRole = (v: unknown): Role | null => {
  if (v === null || v === undefined || v === '' || v === 'none') return null;
  if (!isRole(v)) throw new HttpError(400, 'invalid default role');
  return v;
};

export async function createProject(req: Request, env: Env, u: User | null, wid: string): Promise<Response> {
  const user = requireUser(u);
  await requireWorkspace(env, user, wid);
  const body = await readJson<{ name?: string; defaultRole?: string | null; readOnly?: boolean }>(req);
  const name = str(body.name, 'name', 80);
  // Absent means open to the workspace as editors; an explicit null makes it private.
  const defaultRole = parseDefaultRole('defaultRole' in body ? body.defaultRole : 'editor');
  const id = newId();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO projects (id, workspace_id, name, default_role, read_only, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
      id,
      wid,
      name,
      defaultRole,
      body.readOnly ? 1 : 0,
      Date.now()
    ),
    // The creator administers it, even if the project is private.
    env.DB.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'admin')").bind(id, user.id),
  ]);
  return json({ id, name, defaultRole, readOnly: !!body.readOnly, role: 'admin' }, 201);
}

export async function updateProject(req: Request, env: Env, u: User | null, pid: string): Promise<Response> {
  await requireProject(env, requireUser(u), pid, 'admin');
  const body = await readJson<{ name?: string; defaultRole?: string | null; readOnly?: boolean }>(req);
  if (typeof body.readOnly === 'boolean') {
    await env.DB.prepare('UPDATE projects SET read_only = ? WHERE id = ?').bind(body.readOnly ? 1 : 0, pid).run();
  }
  if (body.name !== undefined) {
    await env.DB.prepare('UPDATE projects SET name = ? WHERE id = ?').bind(str(body.name, 'name', 80), pid).run();
  }
  if ('defaultRole' in body) {
    await env.DB.prepare('UPDATE projects SET default_role = ? WHERE id = ?').bind(parseDefaultRole(body.defaultRole), pid).run();
  }
  return noContent();
}

export async function deleteProject(env: Env, u: User | null, pid: string): Promise<Response> {
  await requireProject(env, requireUser(u), pid, 'admin');
  const { results } = await env.DB.prepare('SELECT id FROM pages WHERE project_id = ? AND parent_id IS NULL')
    .bind(pid)
    .all<{ id: string }>();
  for (const p of results) await deletePageTree(env, p.id);
  await env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(pid).run();
  return noContent();
}

/** Workspace members with their explicit role in this project (null = only the default). */
export async function listProjectMembers(env: Env, u: User | null, pid: string): Promise<Response> {
  await requireProject(env, requireUser(u), pid, 'admin');
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, wm.role AS workspace_role, pm.role AS role
     FROM projects p
     JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
     JOIN users u ON u.id = wm.user_id
     LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = u.id
     WHERE p.id = ? ORDER BY u.name`
  )
    .bind(pid)
    .all();
  return json(results);
}

export async function setProjectMember(req: Request, env: Env, u: User | null, pid: string, userId: string): Promise<Response> {
  await requireProject(env, requireUser(u), pid, 'admin');
  const role = (await readJson<{ role?: string | null }>(req)).role ?? null;
  if (role === null) {
    await env.DB.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').bind(pid, userId).run();
    return noContent();
  }
  if (!isRole(role)) throw new HttpError(400, 'invalid role');
  const inWorkspace = await env.DB.prepare(
    'SELECT 1 FROM projects p JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = ? WHERE p.id = ?'
  )
    .bind(userId, pid)
    .first();
  if (!inWorkspace) throw new HttpError(400, 'add them to the workspace first');
  await env.DB.prepare(
    `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`
  )
    .bind(pid, userId, role)
    .run();
  return noContent();
}


// ---------- usage and limits ----------

/** What a workspace keeps, against its limits (for its owners and admins). */
export async function getWorkspaceUsage(env: Env, u: User | null, wid: string): Promise<Response> {
  await requireWorkspace(env, requireUser(u), wid, true);
  const [usage, limits, cap] = await Promise.all([workspaceUsage(env, wid), workspaceLimits(env, wid), maxFileBytes(env)]);
  return json({ ...usage, ...limits, maxFileBytes: cap });
}

const limitValue = (v: unknown, what: string): number | null => {
  if (v === null || v === '' || v === undefined) return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${what} must be a number, or empty for no limit`);
  return n === 0 ? null : n;
};

/** Only the instance admin sets a workspace's limits: an owner could otherwise lift their own. */
export async function setWorkspaceLimits(req: Request, env: Env, u: User | null, wid: string): Promise<Response> {
  requireAdmin(u);
  if (!(await env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(wid).first())) throw new HttpError(404, 'no such workspace');
  const b = await readJson<{ storageLimit?: unknown; maxPages?: unknown; maxComments?: unknown }>(req);
  const cur = await workspaceLimits(env, wid);
  const next = {
    storageLimit: 'storageLimit' in b ? limitValue(b.storageLimit, 'the storage limit') : cur.storageLimit,
    maxPages: 'maxPages' in b ? limitValue(b.maxPages, 'the page limit') : cur.maxPages,
    maxComments: 'maxComments' in b ? limitValue(b.maxComments, 'the comment limit') : cur.maxComments,
  };
  await env.DB.prepare('UPDATE workspaces SET storage_limit = ?, max_pages = ?, max_comments = ? WHERE id = ?').bind(next.storageLimit, next.maxPages, next.maxComments, wid).run();
  return json(next);
}
