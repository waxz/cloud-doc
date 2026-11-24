export type Role = 'viewer' | 'commenter' | 'editor' | 'admin';
export type WorkspaceRole = 'owner' | 'admin' | 'member';

export const ROLE_LABEL: Record<Role, string> = {
  viewer: 'Can view',
  commenter: 'Can comment',
  editor: 'Can edit',
  admin: 'Admin',
};
const RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, admin: 4 };
export const atLeast = (role: Role | null | undefined, needed: Role) => !!role && RANK[role] >= RANK[needed];

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
}
export interface Workspace {
  id: string;
  name: string;
  displayName: string;
  ownerName: string;
  role: WorkspaceRole;
}
export interface Me {
  user: User;
  workspaces: Workspace[];
  canCreateWorkspaces: boolean;
}
export interface Project {
  id: string;
  name: string;
  defaultRole: Role | null;
  role: Role;
}
export interface Page {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  icon: string;
  position: number;
  updated_at: number;
}
export interface FileInfo {
  id: string;
  name: string;
  mime: string;
  size: number;
  owner_id: string;
  created_at: number;
  url: string;
}
export interface Storage {
  id: string;
  name: string;
  url: string;
  /** The server address and the folder under it (the folder is made if it doesn't exist). */
  baseUrl?: string;
  path?: string;
  username: string;
  hasPassword: boolean;
}
/** A storage the admin shares: users see its name, their limit and their use, never its address. */
export interface SharedStorageForMe {
  id: string;
  name: string;
  limit_bytes: number | null;
  used: number;
}
export interface SharedStorageGrant {
  user_id: string;
  name: string;
  email: string;
  limit_bytes: number | null;
  used: number;
}
export interface SharedStorage extends Storage {
  grants: SharedStorageGrant[];
}
/** A file of a workspace, with the pages that use it. */
export interface WorkspaceFile extends FileInfo {
  owner_name: string | null;
  storage_name: string | null;
  used_count: number;
  used_in: { id: string; title: string }[];
  can_delete: boolean;
}
export interface DeletePreview {
  pages: number;
  files: (FileInfo & { shared: boolean; used_elsewhere: { id: string; title: string }[]; can_delete: boolean })[];
}
export interface StorageInput {
  name?: string;
  url?: string;
  baseUrl?: string;
  path?: string;
  /** With a test: create the folder if it's missing. */
  create?: boolean;
  username?: string;
  password?: string;
}
export interface WorkspaceStorageInfo {
  storages: (Pick<Storage, 'id' | 'name'> & Partial<Storage> & { shared?: boolean })[];
  assigned: string[];
}
export interface Settings {
  user: User;
  usage: number;
  defaultStorageId: string | null;
  canCreateWorkspaces: boolean;
  storages: Storage[];
  sharedStorages: SharedStorageForMe[];
  workspaces: { id: string; name: string; displayName: string; storage_id: string | null; storage_ids: { id: string; name: string }[] }[];
}
export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  can_create_workspaces: number;
  disabled: number;
  created_at: number;
  own_storages: number;
  shared_storages: number;
  usage: number;
}
export interface UserUsage {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  disabled: number;
  storage_used: number;
  grants: { storage_name: string; limit_bytes: number | null; used: number }[];
  files: number;
  comments: number;
  requests_24h: number;
  requests_7d: number;
  requests_30d: number;
  errors_24h: number;
  bytes_in_24h: number;
  bytes_out_24h: number;
  peak_hour: number;
  last_active: number | null;
}
export interface AdminStats {
  now: number;
  hour: number;
  users: UserUsage[];
  series: { hour: number; requests: number; errors: number }[];
  dailyLimit: number;
}
export interface UserPatch {
  name?: string;
  role?: 'admin' | 'member';
  canCreateWorkspaces?: boolean;
  disabled?: boolean;
  password?: string;
}
export interface RegistrationLink {
  token: string;
  email: string | null;
  role: 'admin' | 'member';
  created_at: number;
  expires_at: number | null;
  used_at: number | null;
  used_by_name: string | null;
  workspace_id: string | null;
  workspace_role: string;
  workspace_name: string | null;
  storage_id: string | null;
  storage_name: string | null;
  limit_bytes: number | null;
}
export interface PageInfo {
  page: Page;
  role: Role;
  viaShare: boolean;
  project: { id: string; name: string; workspace_id: string } | null;
  path: { id: string; title: string }[];
}
export interface SearchHit {
  id: string;
  project_id: string;
  title: string;
  snippet: string;
  matches: { n: number; before: string; text: string; after: string }[];
}
export interface Member {
  id: string;
  name: string;
  email: string;
  role: WorkspaceRole;
}
export interface Invite {
  email: string;
  role: 'admin' | 'member';
}
export interface RegisteredMember {
  id: string;
  name: string;
  email: string;
}
export interface ProjectMember {
  id: string;
  name: string;
  email: string;
  workspace_role: WorkspaceRole;
  role: Role | null;
}
export interface Version {
  id: string;
  kind: 'auto' | 'manual' | 'before-restore';
  title: string;
  created_by_name: string | null;
  size: number;
  created_at: number;
}
export interface Comment {
  id: string;
  thread_id: string;
  parent_id?: string | null;
  author_id: string | null;
  author_name: string;
  quote: string | null;
  body: string;
  created_at: number;
  edited_at: number | null;
  resolved_at: number | null;
  resolved_by_name: string | null;
  visibility: 'public' | 'mentioned';
  quote_page: number | null;
  quote_rects: string | null;
  quote_pdf_url: string | null;
  quote_color: string | null;
  quote_shape: string | null;
  quote_start: number | null;
  quote_end: number | null;
}
export interface Notification {
  id: string;
  comment_id: string;
  thread_id: string;
  page_id: string;
  read_at: number | null;
  created_at: number;
  author_name: string;
  body: string;
  page_title: string;
  workspace_id: string;
}
export interface PrivateMessage {
  id: string;
  sender_id: string;
  recipient_id: string;
  sender_name: string;
  recipient_name: string;
  body: string;
  read_at: number | null;
  created_at: number;
}
export interface Todo {
  id: string;
  title: string;
  source_type: string | null;
  source_id: string | null;
  references: { type: 'comment' | 'url'; id?: string; url?: string; label?: string }[];
  completed_at: number | null;
  created_at: number;
}
export interface Share {
  token: string;
  role: Role;
  include_subpages: number;
  expires_at: number | null;
  created_by_name?: string | null;
}
export interface OpenedShare {
  rootPageId: string;
  linkRole: Role;
  role: Role;
  signedIn: boolean;
  pages: Page[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The rest of the error answer (e.g. the pages still using a file). */
    readonly data: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

/** Names this browser tab, so a live notice about a change can skip the tab that made it. */
export const TAB_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random()).slice(2);

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'x-tab-id': TAB_ID, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText, body);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const enc = encodeURIComponent;

/**
 * Shares one request between callers asking for the same thing at about the same time
 * (the editor, the PDF viewer and the panel all load a page's comments after one change),
 * and reuses the answer for `ttl` ms. A write calls `forget` so the next read is fresh.
 */
const shared = new Map<string, { at: number; value: Promise<unknown> }>();
function cachedGet<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = shared.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as Promise<T>;
  const value = load();
  shared.set(key, { at: Date.now(), value });
  value.catch(() => shared.delete(key));
  return value;
}
const forget = (prefix: string) => {
  for (const key of shared.keys()) if (key.startsWith(prefix)) shared.delete(key);
};
const afterWrite = <T>(prefix: string, promise: Promise<T>) =>
  promise.finally(() => {
    forget(prefix);
    // Everything showing comments (the page's highlights, the panels, an open thread) reloads from one shared request.
    if (prefix === 'comments:' && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('cloud-doc-comments-changed'));
  });

export const api = {
  me: () => call<Me>('GET', '/api/me'),
  authStatus: () => call<{ setup: boolean }>('GET', '/api/auth/status'),
  registration: (token: string) => call<{ email: string | null; workspace: string | null; storage: string | null }>('GET', `/api/register/${enc(token)}`),
  signup: (email: string, name: string, password: string, token?: string) =>
    afterWrite('', call<Me>('POST', '/api/auth/signup', { email, name, password, token })),
  // Shared reads are per page and kept briefly: never carry them from one account to the next.
  login: (email: string, password: string) => afterWrite('', call<Me>('POST', '/api/auth/login', { email, password })),
  logout: () => afterWrite('', call<void>('POST', '/api/auth/logout')),

  createWorkspace: (name: string, storageId: string) => afterWrite('', call<Workspace>('POST', '/api/workspaces', { name, storageId })),
  renameWorkspace: (wid: string, name: string) => call<void>('PATCH', `/api/workspaces/${wid}`, { name }),
  deleteWorkspace: (wid: string) => call<void>('DELETE', `/api/workspaces/${wid}`),
  members: (wid: string) => call<{ members: Member[]; invites: Invite[] }>('GET', `/api/workspaces/${wid}/members`),
  availableMembers: (wid: string, q = '') =>
    call<RegisteredMember[]>('GET', `/api/workspaces/${wid}/available-members?q=${enc(q)}`),
  addMember: (wid: string, email: string, role: string) =>
    call<{ added?: boolean; invited?: boolean }>('POST', `/api/workspaces/${wid}/members`, { email, role }),
  setMemberRole: (wid: string, uid: string, role: string) => call<void>('PATCH', `/api/workspaces/${wid}/members/${uid}`, { role }),
  removeMember: (wid: string, uid: string) => call<void>('DELETE', `/api/workspaces/${wid}/members/${uid}`),
  removeInvite: (wid: string, email: string) => call<void>('DELETE', `/api/workspaces/${wid}/invites/${enc(email)}`),
  workspaceStorages: (wid: string) => call<WorkspaceStorageInfo>('GET', `/api/workspaces/${wid}/storages`),
  setWorkspaceStorages: (wid: string, storageIds: string[]) =>
    call<void>('PUT', `/api/workspaces/${wid}/storages`, { storageIds }),
  search: (wid: string, q: string) => call<SearchHit[]>('GET', `/api/workspaces/${wid}/search?q=${enc(q)}`),

  tree: (wid: string) => call<{ projects: Project[]; pages: Record<string, Page[]>; members: number }>('GET', `/api/workspaces/${wid}/tree`),
  projects: (wid: string) => call<Project[]>('GET', `/api/workspaces/${wid}/projects`),
  createProject: (wid: string, name: string, defaultRole: Role | null) =>
    call<Project>('POST', `/api/workspaces/${wid}/projects`, { name, defaultRole }),
  updateProject: (pid: string, patch: { name?: string; defaultRole?: Role | null }) => call<void>('PATCH', `/api/projects/${pid}`, patch),
  deleteProject: (pid: string) => call<void>('DELETE', `/api/projects/${pid}`),
  projectMembers: (pid: string) => call<ProjectMember[]>('GET', `/api/projects/${pid}/members`),
  setProjectMember: (pid: string, uid: string, role: Role | null) => call<void>('PUT', `/api/projects/${pid}/members/${uid}`, { role }),

  pages: (pid: string) => call<Page[]>('GET', `/api/projects/${pid}/pages`),
  createPage: (pid: string, parentId: string | null) => call<Page>('POST', `/api/projects/${pid}/pages`, { parentId }),
  page: (id: string) => call<PageInfo>('GET', `/api/pages/${id}`),
  movePage: (id: string, parentId: string | null, position?: number) => call<Page>('PATCH', `/api/pages/${id}`, { parentId, position }),
  deletePage: (id: string, files: 'keep' | 'delete' = 'keep') =>
    call<{ filesDeleted: number; filesKept: number }>('DELETE', `/api/pages/${id}${files === 'delete' ? '?files=delete' : ''}`),
  deletePreview: (id: string) => call<DeletePreview>('GET', `/api/pages/${id}/delete-preview`),
  workspaceFiles: (wid: string) => call<{ files: WorkspaceFile[] }>('GET', `/api/workspaces/${wid}/files`),

  versions: (id: string) => call<Version[]>('GET', `/api/pages/${id}/versions`),
  saveVersion: (id: string) => call<Version>('POST', `/api/pages/${id}/versions`),
  async versionContent(id: string, vid: string): Promise<Uint8Array> {
    const res = await fetch(`/api/pages/${id}/versions/${vid}/content`);
    if (!res.ok) throw new ApiError(res.status, 'could not load this version');
    return new Uint8Array(await res.arrayBuffer());
  },
  restoreVersion: (id: string, vid: string) => call<void>('POST', `/api/pages/${id}/versions/${vid}/restore`),

  invalidateComments: () => forget('comments:'),
  comments: (id: string) => cachedGet(`comments:${id}`, 2000, () => call<Comment[]>('GET', `/api/pages/${id}/comments`)),
  commentMembers: (id: string) => cachedGet(`members:${id}`, 60_000, () => call<RegisteredMember[]>('GET', `/api/pages/${id}/comment-members`)),
  addComment: (id: string, body: string, opts: {
    quote?: string;
    quotePage?: number;
    quoteRects?: number[][];
    quotePdfUrl?: string;
    quoteColor?: string;
    quoteShape?: string;
    quoteStart?: number;
    quoteEnd?: number;
    threadId?: string;
    parentId?: string;
    mentionIds?: string[];
    visibility?: 'public' | 'mentioned';
  } = {}) =>
    afterWrite('comments:', call<Comment>('POST', `/api/pages/${id}/comments`, { body, ...opts })),
  editComment: (cid: string, body: string) => afterWrite('comments:', call<void>('PATCH', `/api/comments/${cid}`, { body })),
  /** Where highlights now sit after an edit, many in one request (the server answers quietly, with no live notice). */
  updateAnchors: (pageId: string, anchors: { id: string; start: number; end: number; quote?: string }[]) =>
    call<void>('PATCH', `/api/pages/${pageId}/anchors`, { anchors }),
  setCommentVisibility: (cid: string, visibility: 'public' | 'mentioned', mentionIds: string[] = []) => afterWrite('comments:', call<void>('PATCH', `/api/comments/${cid}`, { visibility, mentionIds })),
  setCommentStyle: (cid: string, style: { quoteColor?: string; quoteShape?: string }) => afterWrite('comments:', call<void>('PATCH', `/api/comments/${cid}`, style)),
  resolveComment: (cid: string, resolved: boolean) => afterWrite('comments:', call<void>('PATCH', `/api/comments/${cid}`, { resolved })),
  deleteComment: (cid: string) => afterWrite('comments:', call<void>('DELETE', `/api/comments/${cid}`)),
  inbox: () => call<{ notifications: Notification[] }>('GET', '/api/inbox'),
  notifications: () => call<Notification[]>('GET', '/api/notifications'),
  setNotificationRead: (nid: string, read: boolean) => call<void>('PATCH', `/api/notifications/${nid}`, { read }),
  messages: () => call<PrivateMessage[]>('GET', '/api/messages'),
  sendMessage: (recipientId: string, body: string) => call<PrivateMessage>('POST', '/api/messages', { recipientId, body }),
  setMessageRead: (id: string, read: boolean) => call<void>('PATCH', `/api/messages/${id}`, { read }),
  todos: () => call<Todo[]>('GET', '/api/todos'),
  addTodo: (title: string, sourceType?: string, sourceId?: string, references?: Todo['references']) => call<Todo>('POST', '/api/todos', { title, sourceType, sourceId, references }),
  setTodoCompleted: (id: string, completed: boolean) => call<void>('PATCH', `/api/todos/${id}`, { completed }),

  shares: (id: string) => call<Share[]>('GET', `/api/pages/${id}/shares`),
  createShare: (id: string, role: Role, includeSubpages: boolean, expiresInDays: number | null) =>
    call<Share>('POST', `/api/pages/${id}/shares`, { role, includeSubpages, expiresInDays }),
  deleteShare: (token: string) => call<void>('DELETE', `/api/shares/${token}`),
  openShare: (token: string) => call<OpenedShare>('GET', `/api/share/${token}`),

  settings: () => call<Settings>('GET', '/api/settings'),
  updateProfile: (patch: { name?: string; currentPassword?: string; newPassword?: string }) => call<void>('PATCH', '/api/settings/profile', patch),
  storages: (uid: string) => call<Storage[]>('GET', `/api/users/${uid}/storages`),
  createStorage: (uid: string, s: StorageInput) => call<Storage>('POST', `/api/users/${uid}/storages`, s),
  updateStorage: (sid: string, s: StorageInput) => call<Storage>('PATCH', `/api/storages/${sid}`, s),
  deleteStorage: (sid: string) => call<void>('DELETE', `/api/storages/${sid}`),
  testStorage: (sid: string | null, s: StorageInput) =>
    call<{ ok: boolean; message: string; missing?: boolean; created?: boolean }>('POST', sid ? `/api/storages/${sid}/test` : '/api/storages/test', s),
  setDefaultStorage: (uid: string, storageId: string | null) => call<void>('PUT', `/api/users/${uid}/default-storage`, { storageId }),
  setWorkspaceStorage: (uid: string, wid: string, storageId: string | null) =>
    call<void>('PUT', `/api/users/${uid}/workspaces/${wid}/storage`, { storageId }),

  migrateStep: (wid: string, body: { toStorageId: string; removeOld: boolean; start: boolean; skip: string[] }) =>
    call<{ moved: number; failed: { id: string; error: string }[]; remaining: number; done: boolean }>('POST', `/api/workspaces/${wid}/migrate`, body),
  backupStep: (wid: string, body: { storageId: string; folder?: string; state?: unknown }) =>
    call<{ folder: string; state: unknown; done: boolean; totals?: Record<string, number>; skipped?: { kind: string; id: string; name: string; reason: string }[] }>('POST', `/api/workspaces/${wid}/backup`, body),
  backups: (sid: string) => call<{ folder: string; complete: boolean; name?: string; exportedAt?: number; counts?: Record<string, number> }[]>('GET', `/api/storages/${sid}/backups`),
  importStep: (body: { storageId: string; folder: string; targetStorageId: string; name?: string; restoreMembers?: boolean; state?: unknown }) =>
    call<{ state: { workspaceId: string; failed: { kind: string; id: string; error: string }[] }; done: boolean; totals?: Record<string, number>; workspace?: { id: string; name: string } }>('POST', '/api/import', body),

  adminStats: () => call<AdminStats>('GET', '/api/admin/stats'),
  adminUsers: () => call<AdminUser[]>('GET', '/api/admin/users'),
  adminCreateUser: (u: { email: string; name: string; password: string } & UserPatch) => call<{ id: string }>('POST', '/api/admin/users', u),
  adminUpdateUser: (uid: string, patch: UserPatch) => call<void>('PATCH', `/api/admin/users/${uid}`, patch),
  adminDeleteUser: (uid: string) => call<void>('DELETE', `/api/admin/users/${uid}`),
  adminSharedStorages: () => call<SharedStorage[]>('GET', '/api/admin/shared-storages'),
  adminCreateSharedStorage: (s: StorageInput) => call<SharedStorage>('POST', '/api/admin/shared-storages', s),
  adminUpdateSharedStorage: (sid: string, s: StorageInput) => call<Storage>('PATCH', `/api/admin/shared-storages/${sid}`, s),
  adminDeleteSharedStorage: (sid: string) => call<void>('DELETE', `/api/admin/shared-storages/${sid}`),
  adminTestSharedStorage: (sid: string | null, s: StorageInput) =>
    call<{ ok: boolean; message: string; missing?: boolean; created?: boolean }>('POST', sid ? `/api/admin/shared-storages/${sid}/test` : '/api/admin/shared-storages/test', s),
  adminSetGrant: (sid: string, uid: string, limitBytes: number | null) => call<void>('PUT', `/api/admin/shared-storages/${sid}/grants/${uid}`, { limitBytes }),
  adminRemoveGrant: (sid: string, uid: string) => call<void>('DELETE', `/api/admin/shared-storages/${sid}/grants/${uid}`),
  adminLinks: () => call<RegistrationLink[]>('GET', '/api/admin/links'),
  adminWorkspaces: () => call<{ id: string; name: string }[]>('GET', '/api/admin/workspaces'),
  adminCreateLink: (l: { email?: string; role?: string; expiresInDays?: number | null; workspaceId?: string | null; workspaceRole?: string; storageId?: string | null; limitBytes?: number | null }) => call<RegistrationLink>('POST', '/api/admin/links', l),
  adminDeleteLink: (token: string) => call<void>('DELETE', `/api/admin/links/${enc(token)}`),

  files: (pageId: string) => call<FileInfo[]>('GET', `/api/pages/${pageId}/files`),
  deleteFile: (fid: string, force = false) => call<void>('DELETE', `/api/files/${fid}${force ? '?force=1' : ''}`),
  async upload(pageId: string, file: File): Promise<FileInfo> {
    const res = await fetch(`/api/pages/${pageId}/files`, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
      body: file,
    });
    if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'upload failed');
    return (await res.json()) as FileInfo;
  },
};
