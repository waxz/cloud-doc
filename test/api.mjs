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
  async connect(pageId) {
    const cookie = this.cookieHeader;
    class CookieWS extends WebSocket {
      constructor(url, protocols) {
        super(url, protocols, { headers: { cookie } });
      }
    }
    const doc = new Y.Doc();
    const provider = new YProvider(new URL(BASE).host, pageId, doc, { party: 'page-room', protocol: 'ws', WebSocketPolyfill: CookieWS });
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
assert.deepEqual(await anon.ok('GET', `/api/register/${bobLink.token}`), { email: `bob-${run}@example.com` });
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
const ws = await alice.ok('POST', `/api/workspaces`, { name: `Acme ${run}` });
await alice.ok('POST', `/api/workspaces/${ws.id}/members`, { email: bob.email, role: 'member' });
dave.email = `dave-${run}@example.com`;
assert.deepEqual(await alice.ok('POST', `/api/workspaces/${ws.id}/members`, { email: dave.email }), { invited: true });
// the admin makes Dave's account, who may not create workspaces
const { id: daveId } = await alice.ok('POST', '/api/admin/users', { email: dave.email, name: 'Dave', password: 'correct horse battery', canCreateWorkspaces: false });
await dave.ok('POST', '/api/auth/login', { email: dave.email, password: 'correct horse battery' });
const daveMe = await dave.ok('GET', '/api/me');
assert.ok(daveMe.workspaces.some((w) => w.id === ws.id), 'invite applied to admin-created account');
assert.equal(daveMe.canCreateWorkspaces, false);
await dave.expect(403, 'POST', '/api/workspaces', { name: 'Not allowed' });
await bob.expect(403, 'POST', `/api/workspaces/${ws.id}/members`, { email: 'x@example.com' });
await carol.expect(404, 'GET', `/api/workspaces/${ws.id}/projects`);

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
const davUrl = (folder) => `${dav.url}/${folder}`;
for (const f of ['alice', 'alice-acme', 'bob']) await fetch(`${dav.url}/${f}/`, { method: 'MKCOL', headers: { authorization: `Basic ${btoa(`${dav.user}:${dav.pass}`)}` } });
assert.deepEqual(await alice.ok('POST', '/api/storages/test', { url: davUrl('alice'), username: dav.user, password: 'nope' }), { ok: false, message: 'Wrong username or password' });
assert.equal((await alice.ok('POST', '/api/storages/test', { url: davUrl('missing'), username: dav.user, password: dav.pass })).message, 'Folder not found');
await alice.expect(400, 'POST', '/api/users/me/storages', { name: 'x', url: `http://u:p@127.0.0.1/x` });
const home = await alice.ok('POST', '/api/users/me/storages', { name: 'Home', url: davUrl('alice'), username: dav.user, password: dav.pass });
assert.equal(home.hasPassword, true);
assert.equal(home.password, undefined, 'passwords never leave the server');
assert.equal((await alice.ok('POST', `/api/storages/${home.id}/test`, {})).ok, true);
const acme = await alice.ok('POST', '/api/users/me/storages', { name: 'Acme drive', url: davUrl('alice-acme'), username: dav.user, password: dav.pass });
let mine = await alice.ok('GET', '/api/settings');
assert.equal(mine.defaultStorageId, home.id, 'first storage is the default');
await alice.ok('PUT', `/api/users/me/workspaces/${ws.id}/storage`, { storageId: acme.id });
mine = await alice.ok('GET', '/api/settings');
assert.equal(mine.workspaces.find((w) => w.id === ws.id).storage_id, acme.id);
// someone else's storage can't be used or seen
await bob.expect(404, 'PATCH', `/api/storages/${home.id}`, { name: 'mine' });
await bob.expect(400, 'PUT', '/api/users/me/default-storage', { storageId: home.id });
await bob.expect(403, 'GET', `/api/users/${alice.id}/storages`);
// the admin sets up Bob's WebDAV server and a 20-byte limit
const bobStore = await alice.ok('POST', `/api/users/${bob.id}/storages`, { name: 'Bob drive', url: davUrl('bob'), username: dav.user, password: dav.pass });
await alice.ok('PATCH', `/api/admin/users/${bob.id}`, { storageLimit: 20 });
assert.equal((await bob.ok('GET', '/api/settings')).defaultStorageId, bobStore.id);
assert.equal((await bob.ok('GET', '/api/settings')).storageLimit, 20);
console.log('✓ storages: test, default, workspace override, admin-managed, passwords hidden');

// --- projects and roles ---
const general = (await alice.ok('GET', `/api/workspaces/${ws.id}/projects`)).find((p) => p.name === 'General');
const secret = await alice.ok('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Secret', defaultRole: null });
assert.ok(!(await bob.ok('GET', `/api/workspaces/${ws.id}/projects`)).some((p) => p.id === secret.id), 'private project hidden');
await bob.expect(404, 'GET', `/api/projects/${secret.id}/pages`);
const gPage = await bob.ok('POST', `/api/projects/${general.id}/pages`, {});
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
assert.ok([...dav.files.keys()].some((k) => k.startsWith(`/alice-acme/cloud-doc/${ws.id}/${sPage.id}/files/${up.id}-`)), "stored in the uploader's storage for this workspace");
assert.deepEqual([...(await bob.ok('GET', up.url))], [...png]);
const part = await bob.call('GET', up.url, undefined, { range: 'bytes=2-5' });
assert.equal(part.status, 206);
assert.deepEqual([...part.data], [...png.subarray(2, 6)]);
await bob.expect(403, 'POST', `/api/pages/${sPage.id}/files`, png);
await carol.expect(404, 'GET', up.url);
assert.equal((await bob.ok('GET', `/api/pages/${sPage.id}/files`))[0].id, up.id);
// quota: Bob may store 20 bytes
const bobFile = await bob.ok('POST', `/api/pages/${gPage.id}/files`, png, { 'content-type': 'image/png', 'x-filename': 'a.png' });
assert.ok([...dav.files.keys()].some((k) => k.startsWith('/bob/cloud-doc/')));
await bob.expect(413, 'POST', `/api/pages/${gPage.id}/files`, png);
await alice.expect(409, 'DELETE', `/api/storages/${acme.id}`); // still holds files
await alice.ok('DELETE', `/api/files/${up.id}`).then(() => alice.expect(404, 'GET', up.url));
assert.ok(![...dav.files.keys()].some((k) => k.includes(up.id)), 'file removed from storage');
await alice.ok('DELETE', `/api/files/${bobFile.id}`); // a workspace owner can remove anyone's
assert.equal((await alice.ok('GET', '/api/admin/users')).find((u) => u.id === bob.id).usage, 0);
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
// open pages hear about new comments
const heard = new Promise((resolve) => a.provider.on('custom-message', (m) => JSON.parse(m).type === 'comments' && resolve(true)));
await bob.ok('DELETE', `/api/comments/${reply.id}`);
assert.equal(await Promise.race([heard, sleep(3000).then(() => false)]), true, 'comment change broadcast to the page');
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
assert.match((await dave.expect(409, 'POST', `/api/pages/${gPage.id}/versions`)).error, /Settings → Storage/);
assert.match((await dave.expect(409, 'POST', `/api/pages/${gPage.id}/files`, png)).error, /Settings → Storage/);
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

// --- delete cascades to storage ---
await alice.ok('DELETE', `/api/pages/${sPage.id}`);
await alice.expect(404, 'GET', `/api/pages/${sChild.id}`);
await alice.expect(404, 'GET', up2.url);
assert.equal([...dav.files.keys()].filter((k) => k.includes(sPage.id)).length, 0, 'files and history removed from storage');
a.close();
dav.close();
console.log('✓ deleting a page removes subpages, files and history');
console.log('\nAll API checks passed');
process.exit(0);
