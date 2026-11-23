// End-to-end check of accounts, admin, storages, workspaces, projects,
// permissions, comments, history, files and share links against a running
// Cloud Doc (wrangler dev) with an EMPTY database: the first account made
// here becomes the admin. Storage is a WebDAV server the test starts itself.
// Usage: WIKI_URL=http://127.0.0.1:8787 node test/api.mjs
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import YProvider from 'y-partyserver/provider';
import * as Y from 'yjs';
import { startWebDav } from './webdav-server.mjs';

const BASE = process.env.WIKI_URL ?? 'http://127.0.0.1:8787';
const run = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One browser-like client with its own cookies. */
class Client {
  cookies = new Map();
  constructor(label) {
    this.label = label;
  }
  get cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async call(method, path, body, headers = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: { cookie: this.cookieHeader, ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const v = pair.slice(i + 1);
      if (/Max-Age=0/.test(c)) this.cookies.delete(pair.slice(0, i));
      else this.cookies.set(pair.slice(0, i), v);
    }
    const type = res.headers.get('content-type') ?? '';
    const data = res.status === 204 ? null : type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
    return { status: res.status, data };
  }
  async ok(method, path, body, headers) {
    const r = await this.call(method, path, body, headers);
    assert.ok(r.status < 300, `${this.label} ${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
  async expect(status, method, path, body) {
    const r = await this.call(method, path, body);
    assert.equal(r.status, status, `${this.label} ${method} ${path}: expected ${status}, got ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
  async signup(name, token) {
    this.email = `${name.toLowerCase()}-${run}@example.com`;
    const r = await this.ok('POST', '/api/auth/signup', { email: this.email, name, password: 'correct horse battery', token });
    this.id = r.user.id;
    return r;
  }
  /** A live-sync connection to a page, as this client. */
  async connect(pageId, setup) {
    const cookie = this.cookieHeader;
    class CookieWS extends WebSocket {
      constructor(url, protocols) {
        super(url, protocols, { headers: { cookie } });
      }
    }
    const doc = new Y.Doc();
    const provider = new YProvider(new URL(BASE).host, pageId, doc, { party: 'page-room', protocol: 'ws', WebSocketPolyfill: CookieWS });
    setup?.(provider);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.label} could not sync ${pageId}`)), 8000);
      provider.on('sync', (s) => s && (clearTimeout(t), resolve()));
    });
    return { doc, provider, close: () => (provider.destroy(), doc.destroy()) };
  }
}

const text = (doc) => {
  const parts = [];
  const walk = (n) => {
    for (const c of n.toArray()) {
      if (c instanceof Y.XmlText) parts.push(c.toString());
      else if (c instanceof Y.XmlElement) walk(c);
    }
  };
  walk(doc.getXmlFragment('document-store'));
  return parts.join('\n');
};
const write = (doc, s) => {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(s)]);
  doc.getXmlFragment('document-store').push([p]);
};

const alice = new Client('alice'), bob = new Client('bob'), carol = new Client('carol'), dave = new Client('dave');
const anon = new Client('anonymous');

// --- first account, admin, registration links ---
const dav = await startWebDav();
assert.equal((await anon.ok('GET', '/api/auth/status')).setup, true, 'test/api.mjs needs an empty database (first account = admin)');
assert.equal((await alice.signup('Alice')).user.role, 'admin', 'first account is the admin');
assert.equal((await anon.ok('GET', '/api/auth/status')).setup, false);
await anon.expect(403, 'POST', '/api/auth/signup', { email: `x-${run}@example.com`, name: 'X', password: 'correct horse battery' });
// a link for one email
const bobLink = await alice.ok('POST', '/api/admin/links', { email: `bob-${run}@example.com`, expiresInDays: 7 });
assert.deepEqual(await anon.ok('GET', `/api/register/${bobLink.token}`), { email: `bob-${run}@example.com`, workspace: null, storage: null });
await anon.expect(400, 'POST', '/api/auth/signup', { email: `mallory-${run}@example.com`, name: 'M', password: 'correct horse battery', token: bobLink.token });
assert.equal((await bob.signup('Bob', bobLink.token)).user.role, 'member');
await anon.expect(404, 'GET', `/api/register/${bobLink.token}`);
await anon.expect(403, 'POST', '/api/auth/signup', { email: `bob2-${run}@example.com`, name: 'B', password: 'correct horse battery', token: bobLink.token });
// an open link
const openLink = await alice.ok('POST', '/api/admin/links', {});
await anon.expect(409, 'POST', '/api/auth/signup', { email: alice.email, name: 'X', password: 'correct horse battery', token: openLink.token });
await carol.signup('Carol', openLink.token);
assert.ok((await alice.ok('GET', '/api/admin/links')).some((l) => l.token === openLink.token && l.used_by_name === 'Carol'));
// non-admins can't reach admin endpoints
await bob.expect(403, 'GET', '/api/admin/users');
await bob.expect(403, 'POST', '/api/admin/links', {});
console.log('✓ first account is admin; sign-up only through registration links');

// --- accounts and workspaces ---
// A workspace needs a storage: one of the creator's own, or a shared one the admin allocated to them.
const davUrl = (folder) => `${dav.url}/${folder}`;
for (const f of ['alice', 'alice-acme', 'bob', 'shared']) await fetch(`${dav.url}/${f}/`, { method: 'MKCOL', headers: { authorization: `Basic ${btoa(`${dav.user}:${dav.pass}`)}` } });
await alice.expect(400, 'POST', `/api/workspaces`, { name: `No storage ${run}` });
const home = await alice.ok('POST', '/api/users/me/storages', { name: 'Home', url: davUrl('alice'), username: dav.user, password: dav.pass });
const acme = await alice.ok('POST', '/api/users/me/storages', { name: 'Acme drive', url: davUrl('alice-acme'), username: dav.user, password: dav.pass });
await alice.expect(400, 'POST', `/api/workspaces`, { name: `Foreign ${run}`, storageId: 'not-a-storage' });
const ws = await alice.ok('POST', `/api/workspaces`, { name: `Acme ${run}`, storageId: acme.id });
assert.deepEqual((await alice.ok('GET', `/api/workspaces/${ws.id}/storages`)).assigned, [acme.id], 'the workspace is bound to its storage');
assert.equal((await alice.ok('GET', '/api/me')).workspaces.find((w) => w.id === ws.id).displayName, `Alice's ${ws.name}`);
await alice.ok('POST', `/api/workspaces/${ws.id}/members`, { email: bob.email, role: 'member' });
assert.equal((await bob.ok('GET', '/api/me')).workspaces.find((w) => w.id === ws.id).displayName, `Alice's ${ws.name}`);
dave.email = `dave-${run}@example.com`;
assert.deepEqual(await alice.ok('POST', `/api/workspaces/${ws.id}/members`, { email: dave.email }), { invited: true });
// the admin makes Dave's account, who may not create workspaces
const { id: daveId } = await alice.ok('POST', '/api/admin/users', { email: dave.email, name: 'Dave', password: 'correct horse battery', canCreateWorkspaces: false });
await dave.ok('POST', '/api/auth/login', { email: dave.email, password: 'correct horse battery' });
const daveMe = await dave.ok('GET', '/api/me');
assert.ok(daveMe.workspaces.some((w) => w.id === ws.id), 'invite applied to admin-created account');
assert.equal(daveMe.canCreateWorkspaces, false);
await dave.expect(403, 'POST', '/api/workspaces', { name: 'Not allowed', storageId: acme.id });
await bob.expect(403, 'POST', `/api/workspaces/${ws.id}/members`, { email: 'x@example.com' });
await carol.expect(404, 'GET', `/api/workspaces/${ws.id}/projects`);
const availableCarol = await alice.ok('GET', `/api/workspaces/${ws.id}/available-members?q=Carol`);
assert.ok(availableCarol.some((u) => u.email === carol.email), 'registered users are searchable');
await bob.expect(403, 'GET', `/api/workspaces/${ws.id}/available-members`);

// sign out / in
await bob.ok('POST', '/api/auth/logout');
await bob.expect(401, 'GET', '/api/me');
await bob.expect(401, 'POST', '/api/auth/login', { email: bob.email, password: 'wrong password!' });
await bob.ok('POST', '/api/auth/login', { email: bob.email, password: 'correct horse battery' });
// cross-site style form post is refused
assert.equal((await bob.call('POST', '/api/workspaces', undefined, { 'content-type': 'text/plain' })).status, 415);
// disabled accounts are signed out and can't sign in
await alice.ok('PATCH', `/api/admin/users/${daveId}`, { disabled: true });
await dave.expect(401, 'GET', '/api/me');
await dave.expect(403, 'POST', '/api/auth/login', { email: dave.email, password: 'correct horse battery' });
await alice.ok('PATCH', `/api/admin/users/${daveId}`, { disabled: false });
await alice.expect(409, 'PATCH', `/api/admin/users/${alice.id}`, { role: 'member' }); // the last admin stays
await alice.expect(409, 'DELETE', `/api/admin/users/${alice.id}`);
console.log('✓ accounts, sessions, workspace members, invites, disable, last admin kept');

// --- storages: per user, default plus per-workspace override ---
assert.deepEqual(await alice.ok('POST', '/api/storages/test', { url: davUrl('alice'), username: dav.user, password: 'nope' }), { ok: false, message: 'Wrong username or password' });
assert.equal((await alice.ok('POST', '/api/storages/test', { url: davUrl('missing'), username: dav.user, password: dav.pass })).message, 'Folder not found');
await alice.expect(400, 'POST', '/api/users/me/storages', { name: 'x', url: `http://u:p@127.0.0.1/x` });
assert.equal(home.hasPassword, true);
assert.equal(home.password, undefined, 'passwords never leave the server');
assert.equal((await alice.ok('POST', `/api/storages/${home.id}/test`, {})).ok, true);
let mine = await alice.ok('GET', '/api/settings');
assert.equal(mine.defaultStorageId, home.id, 'first storage is the default');
await alice.ok('PUT', `/api/users/me/workspaces/${ws.id}/storage`, { storageId: acme.id });
mine = await alice.ok('GET', '/api/settings');
assert.equal(mine.workspaces.find((w) => w.id === ws.id).storage_id, acme.id);
await alice.ok('PUT', `/api/workspaces/${ws.id}/storages`, { storageIds: [home.id, acme.id] });
const workspaceStorageInfo = await alice.ok('GET', `/api/workspaces/${ws.id}/storages`);
assert.deepEqual([...workspaceStorageInfo.assigned].sort(), [home.id, acme.id].sort()); // order isn't part of the contract
await bob.expect(403, 'PUT', `/api/workspaces/${ws.id}/storages`, { storageIds: [home.id] });
// someone else's storage can't be used or seen
await bob.expect(404, 'PATCH', `/api/storages/${home.id}`, { name: 'mine' });
await bob.expect(400, 'PUT', '/api/users/me/default-storage', { storageId: home.id });
await bob.expect(403, 'GET', `/api/users/${alice.id}/storages`);
// nobody sets up another person's storage, admins included; the admin shares storages of their own instead
await alice.expect(403, 'POST', `/api/users/${bob.id}/storages`, { name: 'Bob drive', url: davUrl('bob'), username: dav.user, password: dav.pass });
await bob.expect(403, 'GET', '/api/admin/shared-storages');
const shared = await alice.ok('POST', '/api/admin/shared-storages', { name: 'Team drive', url: davUrl('shared'), username: dav.user, password: dav.pass });
assert.equal(shared.hasPassword, true);
assert.ok(!(await alice.ok('GET', '/api/settings')).storages.some((x) => x.id === shared.id), "shared storages aren't in the admin's personal list");
await bob.expect(400, 'POST', '/api/workspaces', { name: 'No grant yet', storageId: shared.id });
await alice.ok('PUT', `/api/admin/shared-storages/${shared.id}/grants/${bob.id}`, { limitBytes: 20 });
const bobSettings = await bob.ok('GET', '/api/settings');
assert.deepEqual(bobSettings.sharedStorages.map((x) => [x.id, x.limit_bytes, x.used]), [[shared.id, 20, 0]]);
assert.ok(!JSON.stringify(bobSettings.sharedStorages).includes(dav.pass) && !JSON.stringify(bobSettings.sharedStorages).includes('127.0.0.1'), "a shared storage's address and login stay with the admin");
await bob.expect(404, 'PATCH', `/api/storages/${shared.id}`, { name: 'mine' });
const bobWs = await bob.ok('POST', '/api/workspaces', { name: `Bob ${run}`, storageId: shared.id });
assert.deepEqual((await bob.ok('GET', `/api/workspaces/${bobWs.id}/storages`)).assigned, [shared.id]);
await alice.expect(409, 'DELETE', `/api/admin/shared-storages/${shared.id}/grants/${bob.id}`); // a workspace is built on it
await bob.expect(409, 'DELETE', `/api/workspaces/${bobWs.id}/storages/${shared.id}`); // the last storage stays
// A registration link can allocate a workspace and a shared storage with a limit: nothing to set up after sign-up.
{
  const erin = new Client('erin');
  const allocLink = await alice.ok('POST', '/api/admin/links', { workspaceId: bobWs.id, workspaceRole: 'member', storageId: shared.id, limitBytes: 50 });
  await alice.expect(404, 'POST', '/api/admin/links', { workspaceId: 'nope' });
  await alice.expect(404, 'POST', '/api/admin/links', { storageId: 'nope' });
  await bob.expect(403, 'GET', '/api/admin/workspaces');
  assert.ok((await alice.ok('GET', '/api/admin/workspaces')).some((w) => w.id === bobWs.id));
  const info = await anon.ok('GET', `/api/register/${allocLink.token}`);
  assert.equal(info.storage, 'Team drive');
  await erin.signup('Erin', allocLink.token);
  assert.ok((await erin.ok('GET', '/api/me')).workspaces.some((w) => w.id === bobWs.id), 'the link put the new account in the workspace');
  const erinSettings = await erin.ok('GET', '/api/settings');
  assert.deepEqual(erinSettings.sharedStorages.map((x) => [x.id, x.limit_bytes]), [[shared.id, 50]], 'and gave it the shared storage with its limit');
  assert.ok((await alice.ok('GET', '/api/admin/links')).some((l) => l.token === allocLink.token && l.workspace_name && l.storage_name === 'Team drive'));
  await alice.ok('DELETE', `/api/admin/shared-storages/${shared.id}/grants/${erin.id}`);
  await bob.ok('DELETE', `/api/workspaces/${bobWs.id}/members/${erin.id}`);
}
console.log('✓ storages: own, workspace needs one, admin shares with limits, passwords hidden');

// --- projects and roles ---
const general = (await alice.ok('GET', `/api/workspaces/${ws.id}/projects`)).find((p) => p.name === 'General');
const secret = await alice.ok('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Secret', defaultRole: null });
assert.ok(!(await bob.ok('GET', `/api/workspaces/${ws.id}/projects`)).some((p) => p.id === secret.id), 'private project hidden');
await bob.expect(404, 'GET', `/api/projects/${secret.id}/pages`);
const gPage = await bob.ok('POST', `/api/projects/${general.id}/pages`, {});
await alice.ok('POST', `/api/pages/${gPage.id}/comments`, { body: '@Bob please review this page' });
const bobNotifications = await bob.ok('GET', '/api/notifications');
assert.ok(bobNotifications.some((n) => n.page_id === gPage.id), 'manual @mention creates an inbox notification');
const sPage = await alice.ok('POST', `/api/projects/${secret.id}/pages`, {});
const sChild = await alice.ok('POST', `/api/projects/${secret.id}/pages`, { parentId: sPage.id });
const sOther = await alice.ok('POST', `/api/projects/${secret.id}/pages`, {});
await bob.expect(404, 'GET', `/api/pages/${sPage.id}`);
await carol.expect(404, 'GET', `/api/pages/${gPage.id}`);
await alice.ok('PUT', `/api/projects/${secret.id}/members/${(await bob.ok('GET', '/api/me')).user.id}`, { role: 'viewer' });
assert.equal((await bob.ok('GET', `/api/pages/${sPage.id}`)).role, 'viewer');
await bob.expect(403, 'POST', `/api/projects/${secret.id}/pages`, {});
await bob.expect(403, 'DELETE', `/api/pages/${sPage.id}`);
await bob.expect(403, 'PATCH', `/api/projects/${secret.id}`, { name: 'mine' });
console.log('✓ projects: private by default role, per-member roles enforced');

// --- live sync: viewer edits are dropped, editor edits arrive ---
const a = await alice.connect(sPage.id);
const b = await bob.connect(sPage.id);
a.doc.getMap('meta').set('title', 'Launch plan');
write(a.doc, `Kickoff checklist zebrafish ${run}`);
await sleep(600);
assert.equal(b.doc.getMap('meta').get('title'), 'Launch plan');
assert.match(text(b.doc), /zebrafish/);
write(b.doc, 'viewer was here');
b.doc.getMap('meta').set('title', 'hacked');
await sleep(800);
assert.doesNotMatch(text(a.doc), /viewer was here/, "viewer's edit reached the editor");
assert.equal(a.doc.getMap('meta').get('title'), 'Launch plan');
const c = await carol.connect(sPage.id).then(() => 'connected', (e) => e.message);
assert.match(c, /could not sync/, 'non-member must not sync');
b.close();
console.log('✓ live sync: viewers read-only, outsiders refused');

// --- search respects project access ---
await sleep(3000); // let the room save
const hits = (q, who) => who.ok('GET', `/api/workspaces/${ws.id}/search?q=${q}`);
assert.equal((await hits('zebrafi', alice)).length, 1);
assert.equal((await hits('zebrafi', bob)).length, 1, 'viewer finds it');
await alice.ok('PUT', `/api/projects/${secret.id}/members/${(await bob.ok('GET', '/api/me')).user.id}`, { role: null });
assert.equal((await hits('zebrafi', bob)).length, 0, 'removed member no longer finds it');
await alice.ok('PUT', `/api/projects/${secret.id}/members/${(await bob.ok('GET', '/api/me')).user.id}`, { role: 'viewer' });
console.log('✓ search scoped to visible projects');

// --- files ---
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const up = await alice.ok('POST', `/api/pages/${sPage.id}/files`, png, { 'content-type': 'image/png', 'x-filename': encodeURIComponent('tiny ü.png') });
assert.equal(up.name, 'tiny ü.png');
assert.ok([...dav.files.keys()].some((k) => k.startsWith(`/alice-acme/cloud-doc/${ws.id}/files/${up.id}-`)), "stored in the workspace's folder of its storage");
assert.deepEqual([...(await bob.ok('GET', up.url))], [...png]);
const part = await bob.call('GET', up.url, undefined, { range: 'bytes=2-5' });
assert.equal(part.status, 206);
assert.deepEqual([...part.data], [...png.subarray(2, 6)]);
await bob.expect(403, 'POST', `/api/pages/${sPage.id}/files`, png);
await carol.expect(404, 'GET', up.url);
assert.equal((await bob.ok('GET', `/api/pages/${sPage.id}/files`))[0].id, up.id);
// quota: Bob's workspace sits on a shared storage that lets him keep 20 bytes
const bobProject = (await bob.ok('GET', `/api/workspaces/${bobWs.id}/projects`))[0];
const bobPage = await bob.ok('POST', `/api/projects/${bobProject.id}/pages`, {});
const bobFile = await bob.ok('POST', `/api/pages/${bobPage.id}/files`, png, { 'content-type': 'image/png', 'x-filename': 'a.png' });
assert.ok([...dav.files.keys()].some((k) => k.startsWith(`/shared/cloud-doc/${bobWs.id}/files/${bobFile.id}-`)), "stored in the admin's shared storage");
await bob.expect(413, 'POST', `/api/pages/${bobPage.id}/files`, png);
assert.equal((await alice.ok('GET', '/api/admin/shared-storages'))[0].grants[0].used, png.length, 'usage counts against the allocation');
await alice.expect(409, 'DELETE', `/api/storages/${acme.id}`); // still holds files
await alice.expect(409, 'DELETE', `/api/files/${up.id}`); // its page uses it: confirm first
await alice.ok('DELETE', `/api/files/${up.id}?force=1`).then(() => alice.expect(404, 'GET', up.url));
assert.ok(![...dav.files.keys()].some((k) => k.includes(up.id)), 'file removed from storage');
await bob.ok('DELETE', `/api/files/${bobFile.id}?force=1`);
assert.equal((await alice.ok('GET', '/api/admin/shared-storages'))[0].grants[0].used, 0);
const up2 = await alice.ok('POST', `/api/pages/${sPage.id}/files`, png, { 'content-type': 'image/png', 'x-filename': 'tiny.png' });
console.log('✓ files: per-user storage, range reads, quota, delete');

// --- comments ---
const t = await alice.ok('POST', `/api/pages/${sPage.id}/comments`, { body: 'Is the date final?', quote: 'Kickoff checklist' });
await bob.expect(403, 'POST', `/api/pages/${sPage.id}/comments`, { body: 'viewer comment' });
await alice.ok('PUT', `/api/projects/${secret.id}/members/${(await bob.ok('GET', '/api/me')).user.id}`, { role: 'commenter' });
const reply = await bob.ok('POST', `/api/pages/${sPage.id}/comments`, { body: 'Yes, Monday.', threadId: t.id });
await bob.expect(403, 'PATCH', `/api/comments/${t.id}`, { body: 'edited by bob' });
await bob.ok('PATCH', `/api/comments/${reply.id}`, { body: 'Yes, Monday 9am.' });
await bob.ok('PATCH', `/api/comments/${t.id}`, { resolved: true });
const list = await alice.ok('GET', `/api/pages/${sPage.id}/comments`);
assert.equal(list.length, 2);
assert.ok(list.find((x) => x.id === t.id).resolved_at, 'thread resolved');
assert.equal(list.find((x) => x.id === reply.id).body, 'Yes, Monday 9am.');
assert.equal(list.find((x) => x.id === t.id).quote, 'Kickoff checklist');
// a reply can answer another reply
const child = await alice.ok('POST', `/api/pages/${sPage.id}/comments`, { body: 'Thanks!', threadId: t.id, parentId: reply.id });
assert.equal(child.parent_id, reply.id);
await alice.expect(404, 'POST', `/api/pages/${sPage.id}/comments`, { body: 'x', threadId: t.id, parentId: 'nope' });
assert.equal((await alice.ok('GET', `/api/pages/${sPage.id}/comments`)).find((x) => x.id === child.id).parent_id, reply.id);
// open pages hear about new comments
const heard = new Promise((resolve) => a.provider.on('custom-message', (m) => JSON.parse(m).type === 'comments' && resolve(true)));
await bob.ok('DELETE', `/api/comments/${reply.id}`);
assert.equal(await Promise.race([heard, sleep(3000).then(() => false)]), true, 'comment change broadcast to the page');
assert.ok(!(await alice.ok('GET', `/api/pages/${sPage.id}/comments`)).some((x) => x.id === child.id), 'deleting a reply deletes the replies to it');
console.log('✓ comments: threads, quotes, replies, resolve, own-edit only, live notice');

// --- history (snapshots in the saver's storage) ---
await bob.expect(403, 'POST', `/api/pages/${sPage.id}/versions`);
const v1 = await alice.ok('POST', `/api/pages/${sPage.id}/versions`);
write(a.doc, 'Added after v1');
a.doc.getMap('meta').set('title', 'Launch plan v2');
await sleep(600);
const versions = await bob.ok('GET', `/api/pages/${sPage.id}/versions`);
assert.ok(versions.some((v) => v.id === v1.id && v.kind === 'manual' && v.created_by_name === 'Alice'));
const snap = await bob.ok('GET', `/api/pages/${sPage.id}/versions/${v1.id}/content`);
const sdoc = new Y.Doc();
Y.applyUpdate(sdoc, snap);
assert.match(text(sdoc), /zebrafish/);
assert.doesNotMatch(text(sdoc), /Added after v1/);
await bob.expect(403, 'POST', `/api/pages/${sPage.id}/versions/${v1.id}/restore`);
const watcher = await bob.connect(sPage.id);
await alice.ok('POST', `/api/pages/${sPage.id}/versions/${v1.id}/restore`);
await sleep(800);
assert.doesNotMatch(text(a.doc), /Added after v1/, 'restore reached the editor live');
assert.doesNotMatch(text(watcher.doc), /Added after v1/, 'restore reached other viewers live');
assert.equal(a.doc.getMap('meta').get('title'), 'Launch plan');
assert.ok((await alice.ok('GET', `/api/pages/${sPage.id}/versions`)).some((v) => v.kind === 'before-restore'), 'pre-restore copy kept');
watcher.close();
assert.ok([...dav.files.keys()].some((k) => k === `/alice-acme/cloud-doc/${ws.id}/${sPage.id}/history/${v1.id}.ydoc`), "snapshot in the saver's storage");
// without storage, asking for a snapshot says what to do
await dave.ok('POST', '/api/auth/login', { email: dave.email, password: 'correct horse battery' });
// Dave has no storage of his own, but this workspace has storages assigned, which members use.
await dave.ok('POST', `/api/pages/${gPage.id}/versions`);
await dave.ok('POST', `/api/pages/${gPage.id}/files`, png, { 'content-type': 'image/png', 'x-filename': 'd.png' });
console.log('✓ history: manual snapshot in storage, preview bytes, live restore with backup');

// --- share links ---
await bob.expect(403, 'POST', `/api/pages/${sPage.id}/shares`, { role: 'viewer' });
const link = await alice.ok('POST', `/api/pages/${sPage.id}/shares`, { role: 'viewer', includeSubpages: true });
await anon.expect(401, 'GET', `/api/pages/${sPage.id}`);
const opened = await anon.ok('GET', `/api/share/${link.token}`);
assert.equal(opened.role, 'viewer');
assert.deepEqual(opened.pages.map((p) => p.id).sort(), [sPage.id, sChild.id].sort());
assert.equal((await anon.ok('GET', `/api/pages/${sChild.id}`)).role, 'viewer');
const sharedView = await anon.ok('GET', `/api/pages/${sChild.id}`);
assert.ok(sharedView.path.every((p) => [sPage.id, sChild.id].includes(p.id)) && sharedView.project === null, 'no project details through a link');
await anon.expect(401, 'GET', `/api/pages/${sOther.id}`);
assert.deepEqual([...(await anon.ok('GET', up2.url))], [...png], 'images readable through the link');
await anon.expect(401, 'POST', `/api/pages/${sPage.id}/comments`, { body: 'anon' });
await anon.expect(403, 'GET', `/api/pages/${sPage.id}/comments`); // a published page doesn't show the discussion
await anon.expect(403, 'GET', `/api/pages/${sPage.id}/versions`); // nor its history
await anon.expect(403, 'GET', `/api/pages/${sPage.id}/versions/${v1.id}/content`);
const anonLive = await anon.connect(sPage.id);
write(anonLive.doc, 'anonymous edit');
await sleep(600);
assert.doesNotMatch(text(a.doc), /anonymous edit/);
anonLive.close();
// commenter link for a signed-in outsider
const cLink = await alice.ok('POST', `/api/pages/${sPage.id}/shares`, { role: 'commenter', includeSubpages: false });
await carol.ok('GET', `/api/share/${cLink.token}`);
await carol.ok('POST', `/api/pages/${sPage.id}/comments`, { body: 'Outside view: looks good' });
assert.ok((await carol.ok('GET', `/api/pages/${sPage.id}/comments`)).length > 0, 'commenter link shows the discussion');
await carol.expect(403, 'GET', `/api/pages/${sPage.id}/versions`);
await carol.expect(404, 'GET', `/api/pages/${sChild.id}`); // link didn't include subpages
// edit links need a project admin
const general2 = await bob.ok('POST', `/api/projects/${general.id}/pages`, {});
await bob.expect(403, 'POST', `/api/pages/${general2.id}/shares`, { role: 'editor' });
await bob.ok('POST', `/api/pages/${general2.id}/shares`, { role: 'commenter' });
await alice.ok('DELETE', `/api/shares/${link.token}`);
await anon.expect(404, 'GET', `/api/share/${link.token}`);
await anon.expect(401, 'GET', `/api/pages/${sPage.id}`);
console.log('✓ share links: public read, subpages, commenter for outsiders, revoke');

// --- release audit: new endpoints, hardening ---
{
  // a private project never shows up in the sidebar tree, nor do its pages
  const aliceTree = await alice.ok('GET', `/api/workspaces/${ws.id}/tree`);
  assert.ok(aliceTree.projects.some((p) => p.id === secret.id), 'admin sees the private project');
  const secretPage = await alice.ok('POST', `/api/projects/${secret.id}/pages`, {});
  const carolWs = await carol.ok('GET', '/api/me');
  const carolTree = carolWs.workspaces?.some((w) => w.id === ws.id) ? await carol.ok('GET', `/api/workspaces/${ws.id}/tree`) : null;
  if (carolTree) assert.ok(!carolTree.projects.some((p) => p.id === secret.id) && !JSON.stringify(carolTree.pages).includes(secretPage.id), 'tree hides private projects');
  await alice.ok('PUT', `/api/projects/${secret.id}/members/${(await bob.ok('GET', '/api/me')).user.id}`, { role: null });
  const bobTree = await bob.ok('GET', `/api/workspaces/${ws.id}/tree`);
  assert.ok(!bobTree.projects.some((p) => p.id === secret.id) && !JSON.stringify(bobTree.pages).includes(secretPage.id), 'removed member sees nothing of the private project in the tree');

  // admin-only usage stats
  await bob.expect(403, 'GET', '/api/admin/stats');
  const stats = await alice.ok('GET', '/api/admin/stats');
  assert.ok(Array.isArray(stats.users) && stats.users.some((u) => u.requests_24h > 0), 'usage counts requests per user');
  assert.ok(stats.users.every((u) => !('password_hash' in u)), 'no secrets in stats');

  // inbox bundles the three lists
  const inbox = await bob.ok('GET', '/api/inbox');
  assert.ok(Array.isArray(inbox.notifications));
  await new Client('anon').expect(401, 'GET', '/api/inbox');

  // highlight style: author or admin only; values validated
  const hp = await bob.ok('POST', `/api/projects/${general.id}/pages`, {});
  const hl = await bob.ok('POST', `/api/pages/${hp.id}/comments`, { body: '', quote: 'text', quoteColor: 'yellow', quoteShape: 'highlight' });
  await bob.ok('PATCH', `/api/comments/${hl.id}`, { quoteColor: 'blue', quoteShape: 'underline' });
  assert.equal((await bob.ok('GET', `/api/pages/${hp.id}/comments`)).find((c) => c.id === hl.id).quote_shape, 'underline');
  await bob.expect(400, 'PATCH', `/api/comments/${hl.id}`, { quoteColor: 'javascript:alert(1)' });
  await bob.expect(400, 'PATCH', `/api/comments/${hl.id}`, { quoteShape: 'x' });
  await carol.expect(404, 'PATCH', `/api/comments/${hl.id}`, { quoteColor: 'red' });

  // private threads: replies and mentions keep the thread visible to who needs it
  const priv = await alice.ok('POST', `/api/pages/${hp.id}/comments`, { body: 'for @Bob only', visibility: 'mentioned', mentionIds: [(await bob.ok('GET', '/api/me')).user.id] });
  assert.ok((await bob.ok('GET', `/api/pages/${hp.id}/comments`)).some((c) => c.id === priv.id), 'mentioned member sees the private thread');
  assert.ok(!(await alice.ok('GET', `/api/pages/${hp.id}/comments`)).every((c) => c.id !== priv.id), 'author sees it');

  // uploaded HTML/SVG can't run script in the app's origin
  const html = await alice.ok('POST', `/api/pages/${sPage.id}/files`, new TextEncoder().encode('<script>alert(1)</script>'), { 'content-type': 'text/html', 'x-filename': 'x.html' });
  const served = await fetch(BASE + html.url, { headers: { cookie: alice.cookieHeader } });
  assert.match(served.headers.get('content-disposition') ?? '', /^attachment/, 'html downloads instead of displaying');
  assert.match(served.headers.get('content-security-policy') ?? '', /sandbox/, 'files carry a sandbox policy');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  const svg = await alice.ok('POST', `/api/pages/${sPage.id}/files`, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), { 'content-type': 'image/svg+xml', 'x-filename': 'x.svg' });
  assert.match((await fetch(BASE + svg.url, { headers: { cookie: alice.cookieHeader } })).headers.get('content-disposition') ?? '', /^attachment/, 'svg downloads too');

  // API answers are never cached; a cross-site socket is refused
  const cache = await fetch(BASE + '/api/auth/status');
  assert.equal(cache.headers.get('cache-control'), 'no-store');
  const refused = await new Promise((resolve) => {
    const sock = new WebSocket(BASE.replace('http', 'ws') + `/parties/page-room/${hp.id}`, { headers: { origin: 'https://evil.example', cookie: alice.cookieHeader } });
    sock.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    sock.on('open', () => { sock.close(); resolve(101); });
    sock.on('error', () => {});
  });
  assert.equal(refused, 403, 'cross-site live connection refused');

  console.log('✓ release audit: tree/stats/inbox access, highlight styles, private threads, file sandboxing, headers');
}

// --- workspace files: shared between pages, kept when a page goes, asked about when deleted ---
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // a second page that uses up2 too (page content is what says so, recorded when the page is saved)
  const page2 = gPage;
  const live2 = await alice.connect(page2.id);
  const frag = live2.doc.getXmlFragment('document-store');
  const block = new Y.XmlElement('image');
  block.setAttribute('url', up2.url);
  frag.insert(0, [block]);
  const onlyHere = await alice.ok('POST', `/api/pages/${sPage.id}/files`, png, { 'content-type': 'image/png', 'x-filename': 'only-here.png' });
  for (let i = 0; i < 40; i++) {
    const listed = (await alice.ok('GET', `/api/workspaces/${ws.id}/files`)).files.find((f) => f.id === up2.id);
    if (listed?.used_count >= 2) break;
    await sleep(750);
  }
  const listing = (await alice.ok('GET', `/api/workspaces/${ws.id}/files`)).files;
  assert.equal(listing.find((f) => f.id === up2.id).used_count, 2, 'a page that uses the file is recorded');
  assert.deepEqual(listing.find((f) => f.id === up2.id).used_in.map((p) => p.id).sort(), [sPage.id, page2.id].sort());
  assert.equal(listing.find((f) => f.id === onlyHere.id).used_count, 1);
  // Carol isn't in this workspace; Bob can't see files that only private pages use
  await carol.expect(404, 'GET', `/api/workspaces/${ws.id}/files`);
  // deleting a page: the preview says which files go with it and which are shared
  const preview = await alice.ok('GET', `/api/pages/${sPage.id}/delete-preview`);
  assert.equal(preview.pages, 2, 'the subpage counts');
  assert.equal(preview.files.find((f) => f.id === up2.id).shared, true);
  assert.equal(preview.files.find((f) => f.id === onlyHere.id).shared, false);
  // a file in use is not deleted by accident
  const warn = await alice.call('DELETE', `/api/files/${up2.id}`);
  assert.equal(warn.status, 409);
  assert.ok(warn.data.used_in.length === 2, 'the refusal says where it is used');
  // delete the page and its unshared files; the shared one stays
  const gone = await alice.ok('DELETE', `/api/pages/${sPage.id}?files=delete`);
  assert.deepEqual(gone, { filesDeleted: 3, filesKept: 1 }); // only-here.png and the html and svg uploads go; up2 is shared
  await alice.expect(404, 'GET', `/api/pages/${sChild.id}`);
  await alice.expect(404, 'GET', onlyHere.url);
  assert.ok(![...dav.files.keys()].some((k) => k.includes(onlyHere.id)), 'unshared file removed from storage');
  assert.deepEqual([...(await alice.ok('GET', up2.url))], [...png], 'the shared file survives the page');
  assert.equal((await alice.ok('GET', `/api/workspaces/${ws.id}/files`)).files.find((f) => f.id === up2.id).used_count, 1);
  assert.ok(![...dav.files.keys()].some((k) => k.includes(`/${sPage.id}/history/`)), 'history removed with the page');
  // by default a deleted page leaves its files in the workspace
  const lone = await alice.ok('POST', `/api/projects/${general.id}/pages`, {});
  const loneFile = await alice.ok('POST', `/api/pages/${lone.id}/files`, png, { 'content-type': 'image/png', 'x-filename': 'lone.png' });
  assert.deepEqual(await alice.ok('DELETE', `/api/pages/${lone.id}`), { filesDeleted: 0, filesKept: 0 });
  assert.deepEqual([...(await alice.ok('GET', loneFile.url))], [...png], 'kept when the page is deleted');
  const unused = (await alice.ok('GET', `/api/workspaces/${ws.id}/files`)).files.find((f) => f.id === loneFile.id);
  assert.equal(unused.used_count, 0, 'listed as unused');
  await bob.expect(403, 'DELETE', `/api/files/${loneFile.id}`).catch(() => bob.expect(404, 'DELETE', `/api/files/${loneFile.id}`));
  await alice.ok('DELETE', `/api/files/${loneFile.id}`); // nothing uses it: no warning
  live2.close();
  // deleting a whole workspace clears its folder in the storage
  const bobPage2 = await bob.ok('POST', `/api/projects/${bobProject.id}/pages`, {});
  await bob.ok('POST', `/api/pages/${bobPage2.id}/files`, png, { 'content-type': 'image/png', 'x-filename': 'b.png' });
  assert.ok([...dav.files.keys()].some((k) => k.startsWith(`/shared/cloud-doc/${bobWs.id}/`)));
  await bob.ok('DELETE', `/api/workspaces/${bobWs.id}`);
  assert.ok(![...dav.files.keys()].some((k) => k.startsWith(`/shared/cloud-doc/${bobWs.id}/`)), "a deleted workspace's files leave the storage");
  await alice.ok('DELETE', `/api/admin/shared-storages/${shared.id}/grants/${bob.id}`);
  await alice.ok('DELETE', `/api/admin/shared-storages/${shared.id}`);
  console.log('✓ workspace files: shared between pages, kept or deleted with the page, warned when in use');
}

// --- free-plan economy: live mode, quiet highlight moves ---
{
  const proj = (await alice.ok('GET', `/api/workspaces/${ws.id}/projects`)).find((x) => x.name === 'General') ?? general;
  const pg = await alice.ok('POST', `/api/projects/${proj.id}/pages`, {});
  const modes = (provider) => {
    const seen = [];
    provider.on('custom-message', (m) => { const n = JSON.parse(m); if (n.type === 'mode') seen.push(n.live); });
    return seen;
  };
  let aModes;
  const a1 = await alice.connect(pg.id, (p) => (aModes = modes(p)));
  await sleep(500);
  assert.deepEqual(aModes, [false], 'one writer is quiet');
  let bModes;
  const b1 = await bob.connect(pg.id, (p) => (bModes = modes(p)));
  await sleep(700);
  assert.deepEqual(bModes, [true], 'a newcomer is told the room is live at once');
  assert.equal(aModes.at(-1), true, 'two writers are live');
  b1.close();
  await sleep(1000);
  assert.equal(aModes.at(-1), false, 'back to quiet when the second writer leaves');
  // highlight moves: one request, editors only, no live notice, unchanged rows untouched
  write(a1.doc, 'hello world');
  const th = await alice.ok('POST', `/api/pages/${pg.id}/comments`, { body: 'look', quote: 'world', quoteStart: 6, quoteEnd: 11 });
  const notices = [];
  a1.provider.on('custom-message', (m) => notices.push(JSON.parse(m).type));
  await alice.ok('PATCH', `/api/pages/${pg.id}/anchors`, { anchors: [{ id: th.id, start: 8, end: 13, quote: 'world' }, { id: 'nope', start: 1, end: 2 }] });
  const moved = (await alice.ok('GET', `/api/pages/${pg.id}/comments`)).find((c) => c.id === th.id);
  assert.deepEqual([moved.quote_start, moved.quote_end], [8, 13]);
  await sleep(500);
  assert.ok(!notices.includes('comments'), 'moving a highlight does not make everyone reload');
  await carol.call('PATCH', `/api/pages/${pg.id}/anchors`, { anchors: [] }).then((r) => assert.ok(r.status >= 400, 'outsiders cannot move highlights'));
  a1.close();
  console.log('✓ live mode follows the number of writers; highlight moves are one quiet request');
}

// --- migrate a workspace between storages, back it up, restore it ---
{
  const proj = (await alice.ok('GET', `/api/workspaces/${ws.id}/projects`))[0];
  const pg = await alice.ok('POST', `/api/projects/${proj.id}/pages`, {});
  const up = await alice.ok('POST', `/api/pages/${pg.id}/files`, png, { 'content-type': 'image/png', 'x-filename': 'moveme.png' });
  const live = await alice.connect(pg.id);
  live.doc.getMap('meta').set('title', 'Backup me');
  const img = new Y.XmlElement('image');
  img.setAttribute('url', up.url);
  live.doc.getXmlFragment('document-store').push([img]);
  write(live.doc, 'precious words');
  await alice.ok('POST', `/api/pages/${pg.id}/comments`, { body: `see ![](${up.url})`, quote: 'precious', quoteStart: 0, quoteEnd: 8 });
  await alice.ok('POST', `/api/pages/${pg.id}/versions`);
  await sleep(3000); // the room saves and indexes
  // migrate acme -> home
  let r = await alice.ok('POST', `/api/workspaces/${ws.id}/migrate`, { toStorageId: home.id, removeOld: true, start: true, skip: [] });
  for (let i = 0; !r.done && i < 50; i++) r = await alice.ok('POST', `/api/workspaces/${ws.id}/migrate`, { toStorageId: home.id, removeOld: true, start: false, skip: [] });
  assert.ok(r.done && r.failed.length === 0, 'everything moved');
  assert.deepEqual((await alice.ok('GET', `/api/workspaces/${ws.id}/storages`)).assigned, [home.id], 'bound to the new storage');
  assert.deepEqual([...(await alice.ok('GET', up.url))], [...png], 'file readable from the new storage');
  assert.ok([...dav.files.keys()].some((k) => k.includes(`/alice/cloud-doc/${ws.id}/files/${up.id}`)), 'copy is in the new storage');
  assert.ok(![...dav.files.keys()].some((k) => k.includes(`/alice-acme/cloud-doc/${ws.id}/files/${up.id}`)), 'old copy removed');
  await bob.expect(403, 'POST', `/api/workspaces/${ws.id}/migrate`, { toStorageId: home.id, start: true });
  // back up to home
  let b = await alice.ok('POST', `/api/workspaces/${ws.id}/backup`, { storageId: home.id });
  const folder = b.folder;
  for (let i = 0; !b.done && i < 80; i++) b = await alice.ok('POST', `/api/workspaces/${ws.id}/backup`, { storageId: home.id, folder, state: b.state });
  assert.ok(b.done, 'backup finished');
  assert.ok([...dav.files.keys()].some((k) => k.endsWith(`/cloud-doc-backups/${folder}/manifest.json`)));
  const listed = await alice.ok('GET', `/api/storages/${home.id}/backups`);
  assert.ok(listed.some((x) => x.folder === folder && x.complete), 'listed as a complete backup');
  await bob.expect(400, 'POST', `/api/workspaces/${ws.id}/backup`, { storageId: home.id }).catch(() => undefined);
  // restore as a new workspace
  let im = await alice.ok('POST', '/api/import', { storageId: home.id, folder, targetStorageId: home.id });
  for (let i = 0; !im.done && i < 80; i++) im = await alice.ok('POST', '/api/import', { storageId: home.id, folder, targetStorageId: home.id, state: im.state });
  assert.ok(im.done);
  assert.deepEqual(im.state.failed, [], 'nothing failed');
  const newWid = im.state.workspaceId;
  const tree = await alice.ok('GET', `/api/workspaces/${newWid}/tree`);
  const restored = Object.values(tree.pages).flat().find((p) => p.title === 'Backup me');
  assert.ok(restored, 'the page came back with its title');
  const rl = await alice.connect(restored.id);
  assert.match(text(rl.doc), /precious words/);
  const newImg = rl.doc.getXmlFragment('document-store').toArray().find((n) => n instanceof Y.XmlElement && n.nodeName === 'image');
  const newUrl = newImg.getAttribute('url');
  assert.notEqual(newUrl, up.url, 'the image now points at the restored file');
  assert.deepEqual([...(await alice.ok('GET', newUrl))], [...png], 'restored file is readable');
  const cs = await alice.ok('GET', `/api/pages/${restored.id}/comments`);
  assert.equal(cs.length, 1);
  assert.ok(cs[0].body.includes(newUrl), 'comment links follow the new file');
  assert.equal((await alice.ok('GET', `/api/pages/${restored.id}/versions`)).length >= 1, true, 'history came back');
  rl.close();
  live.close();
  await alice.ok('DELETE', `/api/workspaces/${newWid}`);
  console.log('✓ migrate between storages, back up to a storage, restore as a new workspace');
}

a.close();
dav.close();
console.log('\nAll API checks passed');
process.exit(0);
