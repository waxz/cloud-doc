import { routePartykitRequest } from 'partyserver';
import { atLeast, requirePage } from './access.js';
import { authStatus, currentUser, getMe, login, logout, registrationInfo, signup, type User } from './auth.js';
import type { Env } from './env.js';
import { HttpError, json } from './http.js';
import { ensureSchema } from './migrate.js';
import * as backup from './backup.js';
import * as files from './files.js';
import * as pages from './pages.js';
import * as settings from './settings.js';
import { useStorageKey } from './secret.js';
import { adminStats, flushUsage, recordUsage } from './usage.js';
import { NAME_HEADER, ROLE_HEADER } from './page-room.js';
import * as ws from './workspaces.js';

export { PageRoom } from './page-room.js';

type Handler = (req: Request, env: Env, user: User | null, params: string[], url: URL) => Promise<Response>;

const routes: [string, RegExp, Handler][] = [];
const route = (method: string, pattern: string, handler: Handler) =>
  routes.push([method, new RegExp(`^${pattern.replace(/:\w+/g, '([^/]+)')}$`), handler]);

route('POST', '/api/auth/signup', (r, e) => signup(r, e));
route('POST', '/api/auth/login', (r, e) => login(r, e));
route('POST', '/api/auth/logout', (r, e) => logout(r, e));
route('GET', '/api/auth/status', (r, e) => authStatus(e));
route('GET', '/api/register/:t', (r, e, u, [t]) => registrationInfo(e, t!));
route('GET', '/api/me', (r, e, u) => getMe(e, u));

route('GET', '/api/settings', (r, e, u) => settings.getSettings(e, u));
route('PATCH', '/api/settings/profile', (r, e, u) => settings.updateProfile(r, e, u));
route('GET', '/api/users/:u/storages', (r, e, u, [id]) => settings.listStorages(e, u, id!));
route('POST', '/api/users/:u/storages', (r, e, u, [id]) => settings.createStorage(r, e, u, id!));
route('PUT', '/api/users/:u/default-storage', (r, e, u, [id]) => settings.setDefaultStorage(r, e, u, id!));
route('PUT', '/api/users/:u/workspaces/:w/storage', (r, e, u, [id, w]) => settings.setWorkspaceStorage(r, e, u, id!, w!));
route('POST', '/api/storages/test', (r, e, u) => settings.testStorage(r, e, u, null));
route('PATCH', '/api/storages/:s', (r, e, u, [s]) => settings.updateStorage(r, e, u, s!));
route('DELETE', '/api/storages/:s', (r, e, u, [s]) => settings.deleteStorage(e, u, s!));
route('POST', '/api/storages/:s/test', (r, e, u, [s]) => settings.testStorage(r, e, u, s!));

route('GET', '/api/admin/users', (r, e, u) => settings.adminListUsers(e, u));
route('POST', '/api/admin/users', (r, e, u) => settings.adminCreateUser(r, e, u));
route('PATCH', '/api/admin/users/:u', (r, e, u, [id]) => settings.adminUpdateUser(r, e, u, id!));
route('DELETE', '/api/admin/users/:u', (r, e, u, [id]) => settings.adminDeleteUser(e, u, id!));
route('GET', '/api/admin/shared-storages', (r, e, u) => settings.adminListSharedStorages(e, u));
route('POST', '/api/admin/shared-storages', (r, e, u) => settings.adminCreateSharedStorage(r, e, u));
route('POST', '/api/admin/shared-storages/test', (r, e, u) => settings.adminTestSharedStorage(r, e, u, null));
route('PATCH', '/api/admin/shared-storages/:s', (r, e, u, [s]) => settings.adminUpdateSharedStorage(r, e, u, s!));
route('DELETE', '/api/admin/shared-storages/:s', (r, e, u, [s]) => settings.adminDeleteSharedStorage(e, u, s!));
route('POST', '/api/admin/shared-storages/:s/test', (r, e, u, [s]) => settings.adminTestSharedStorage(r, e, u, s!));
route('PUT', '/api/admin/shared-storages/:s/grants/:u', (r, e, u, [s, id]) => settings.adminSetGrant(r, e, u, s!, id!));
route('DELETE', '/api/admin/shared-storages/:s/grants/:u', (r, e, u, [s, id]) => settings.adminRemoveGrant(e, u, s!, id!));
route('GET', '/api/admin/stats', (r, e, u) => adminStats(e, u));
route('GET', '/api/admin/links', (r, e, u) => settings.adminListLinks(e, u));
route('GET', '/api/admin/workspaces', (r, e, u) => settings.adminListWorkspaces(e, u));
route('POST', '/api/admin/links', (r, e, u) => settings.adminCreateLink(r, e, u));
route('DELETE', '/api/admin/links/:t', (r, e, u, [t]) => settings.adminDeleteLink(e, u, t!));

route('POST', '/api/workspaces', (r, e, u) => ws.createWorkspace(r, e, u));
route('PATCH', '/api/workspaces/:w', (r, e, u, [w]) => ws.renameWorkspace(r, e, u, w!));
route('DELETE', '/api/workspaces/:w', (r, e, u, [w]) => ws.deleteWorkspace(e, u, w!));
route('GET', '/api/workspaces/:w/members', (r, e, u, [w]) => ws.listMembers(e, u, w!));
route('GET', '/api/workspaces/:w/available-members', (r, e, u, [w], url) => ws.listAvailableMembers(e, u, w!, url.searchParams.get('q') ?? ''));
route('POST', '/api/workspaces/:w/members', (r, e, u, [w]) => ws.addMember(r, e, u, w!));
route('PATCH', '/api/workspaces/:w/members/:u', (r, e, u, [w, id]) => ws.setMemberRole(r, e, u, w!, id!));
route('DELETE', '/api/workspaces/:w/members/:u', (r, e, u, [w, id]) => ws.removeMember(e, u, w!, id!));
route('DELETE', '/api/workspaces/:w/invites/:email', (r, e, u, [w, m]) => ws.removeInvite(e, u, w!, m!));
route('GET', '/api/workspaces/:w/storages', (r, e, u, [w]) => ws.listWorkspaceStorages(e, u, w!));
route('PUT', '/api/workspaces/:w/storages', (r, e, u, [w]) => ws.setWorkspaceStorages(r, e, u, w!));
route('PUT', '/api/workspaces/:w/storages/:s', (r, e, u, [w, s]) => ws.bindWorkspaceStorage(r, e, u, w!, s!));
route('DELETE', '/api/workspaces/:w/storages/:s', (r, e, u, [w, s]) => ws.unbindWorkspaceStorage(e, u, w!, s!));
route('POST', '/api/workspaces/:w/migrate', (r, e, u, [w]) => backup.migrateStep(r, e, u, w!));
route('POST', '/api/workspaces/:w/backup', (r, e, u, [w]) => backup.backupStep(r, e, u, w!));
route('GET', '/api/storages/:s/backups', (r, e, u, [s]) => backup.listBackups(e, u, s!));
route('POST', '/api/import', (r, e, u) => backup.importStep(r, e, u));
route('GET', '/api/workspaces/:w/projects', (r, e, u, [w]) => ws.listProjects(e, u, w!));
route('GET', '/api/workspaces/:w/tree', (r, e, u, [w]) => ws.listWorkspacePages(e, u, w!));
route('POST', '/api/workspaces/:w/projects', (r, e, u, [w]) => ws.createProject(r, e, u, w!));
route('GET', '/api/workspaces/:w/search', (r, e, u, [w], url) => pages.search(e, u, w!, url.searchParams.get('q') ?? ''));

route('PATCH', '/api/projects/:p', (r, e, u, [p]) => ws.updateProject(r, e, u, p!));
route('DELETE', '/api/projects/:p', (r, e, u, [p]) => ws.deleteProject(e, u, p!));
route('GET', '/api/projects/:p/members', (r, e, u, [p]) => ws.listProjectMembers(e, u, p!));
route('PUT', '/api/projects/:p/members/:u', (r, e, u, [p, id]) => ws.setProjectMember(r, e, u, p!, id!));
route('GET', '/api/projects/:p/pages', (r, e, u, [p]) => pages.listPages(r, e, u, p!));
route('POST', '/api/projects/:p/pages', (r, e, u, [p]) => pages.createPage(r, e, u, p!));

route('GET', '/api/pages/:id', (r, e, u, [id]) => pages.getPage(r, e, u, id!));
route('PATCH', '/api/pages/:id', (r, e, u, [id]) => pages.movePage(r, e, u, id!));
route('DELETE', '/api/pages/:id', (r, e, u, [id]) => pages.deletePage(r, e, u, id!));
route('POST', '/api/pages/:id/files', (r, e, u, [id]) => files.uploadFile(r, e, u, id!));
route('GET', '/api/workspaces/:w/files', (r, e, u, [w]) => files.listWorkspaceFiles(e, u, w!));
route('GET', '/api/pages/:id/delete-preview', (r, e, u, [id]) => files.deletePreview(r, e, u, id!));
route('GET', '/api/pages/:id/files', (r, e, u, [id]) => files.listFiles(r, e, u, id!));
route('GET', '/api/files/:f/:name', (r, e, u, [f]) => files.downloadFile(r, e, u, f!));
route('DELETE', '/api/files/:f', (r, e, u, [f]) => files.deleteFile(r, e, u, f!));
route('GET', '/api/pages/:id/versions', (r, e, u, [id]) => pages.listVersions(r, e, u, id!));
route('POST', '/api/pages/:id/versions', (r, e, u, [id]) => pages.saveVersion(r, e, u, id!));
route('GET', '/api/pages/:id/versions/:v/content', (r, e, u, [id, v]) => pages.versionContent(r, e, u, id!, v!));
route('POST', '/api/pages/:id/versions/:v/restore', (r, e, u, [id, v]) => pages.restoreVersion(r, e, u, id!, v!));
route('GET', '/api/pages/:id/comments', (r, e, u, [id]) => pages.listComments(r, e, u, id!));
route('POST', '/api/pages/:id/comments', (r, e, u, [id]) => pages.addComment(r, e, u, id!));
route('GET', '/api/pages/:id/comment-members', (r, e, u, [id]) => pages.listCommentMembers(r, e, u, id!));
route('PATCH', '/api/pages/:id/anchors', (r, e, u, [id]) => pages.updateAnchors(r, e, u, id!));
route('PATCH', '/api/comments/:c', (r, e, u, [c]) => pages.updateComment(r, e, u, c!));
route('DELETE', '/api/comments/:c', (r, e, u, [c]) => pages.deleteComment(r, e, u, c!));
route('GET', '/api/inbox', (r, e, u) => pages.inbox(e, u));
route('GET', '/api/notifications', (r, e, u) => pages.listNotifications(e, u));
route('PATCH', '/api/notifications/:n', (r, e, u, [id]) => pages.markNotificationRead(r, e, u, id!));
route('GET', '/api/messages', (r, e, u) => pages.listMessages(e, u));
route('POST', '/api/messages', (r, e, u) => pages.sendMessage(r, e, u));
route('PATCH', '/api/messages/:m', (r, e, u, [id]) => pages.markMessageRead(r, e, u, id!));
route('GET', '/api/todos', (r, e, u) => pages.listTodos(e, u));
route('POST', '/api/todos', (r, e, u) => pages.addTodo(r, e, u));
route('PATCH', '/api/todos/:t', (r, e, u, [id]) => pages.updateTodo(r, e, u, id!));
route('GET', '/api/pages/:id/shares', (r, e, u, [id]) => pages.listShares(r, e, u, id!));
route('POST', '/api/pages/:id/shares', (r, e, u, [id]) => pages.createShare(r, e, u, id!));
route('DELETE', '/api/shares/:t', (r, e, u, [t]) => pages.deleteShare(r, e, u, t!));
route('GET', '/api/share/:t', (r, e, u, [t]) => pages.openShare(e, u, t!));

/** Live sync: only for people who can view the page, with their role passed to the room. */
async function sync(req: Request, env: Env, user: User | null): Promise<Response> {
  // Only this site's pages may open a live connection (the session cookie is Lax, which already
  // keeps it off cross-site sockets; this is the second lock).
  const origin = req.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(req.url).host) return new Response('forbidden', { status: 403 });
  const res = await routePartykitRequest(req, env as unknown as Record<string, unknown>, {
    onBeforeConnect: async (r, lobby) => {
      try {
        const access = await requirePage(r, env, user, lobby.name, 'viewer');
        const headers = new Headers(r.headers);
        headers.set(ROLE_HEADER, access.role);
        headers.set(NAME_HEADER, user?.name ?? '');
        return new Request(r, { headers });
      } catch (err) {
        if (err instanceof HttpError) return new Response(err.message, { status: err.status });
        throw err;
      }
    },
    // Plain HTTP to a room is internal only (the Worker calls rooms directly).
    onBeforeRequest: () => new Response('Not Found', { status: 404 }),
  });
  return res ?? json({ error: 'not found' }, 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    // Clients never get to set these; only onBeforeConnect does.
    if (req.headers.has(ROLE_HEADER) || req.headers.has(NAME_HEADER)) {
      const headers = new Headers(req.headers);
      headers.delete(ROLE_HEADER);
      headers.delete(NAME_HEADER);
      req = new Request(req, { headers });
    }
    let user: User | null = null;
    let res: Response;
    try {
      useStorageKey(env.STORAGE_KEY);
      await ensureSchema(env.DB);
      user = await currentUser(req, env);
      if (p.startsWith('/parties/')) res = await sync(req, env, user);
      else {
        res = json({ error: 'not found' }, 404);
        for (const [method, re, handler] of routes) {
          const m = re.exec(p);
          if (m && (req.method === method || (method === 'GET' && req.method === 'HEAD'))) {
            res = await handler(req, env, user, m.slice(1).map(decodeURIComponent), url);
            break;
          }
        }
      }
    } catch (err) {
      if (err instanceof HttpError) res = json({ error: err.message }, err.status);
      else {
        console.error(err);
        res = json({ error: 'internal error' }, 500);
      }
    }
    if (p.startsWith('/api/') || p.startsWith('/parties/')) {
      // Private data must not be kept by caches or sniffed into another type.
      if (res.status !== 101 && !res.headers.has('cache-control')) {
        res = new Response(res.body, res);
        res.headers.set('cache-control', 'no-store');
        res.headers.set('x-content-type-options', 'nosniff');
      }
      recordUsage(user, req, res);
      ctx.waitUntil(flushUsage(env));
    }
    return res;
  },
} satisfies ExportedHandler<Env>;
