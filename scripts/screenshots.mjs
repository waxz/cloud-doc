// Takes the screenshots in docs/screenshots from a running app with an EMPTY database:
// it makes a small demo team (accounts, a workspace, pages, files, highlights and comments) and drives a browser.
//   npx wrangler dev --port 8799 --persist-to /tmp/cloud-doc-shots     (a fresh database each time)
//   WIKI_URL=http://127.0.0.1:8799 node scripts/screenshots.mjs
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import WebSocket from 'ws';
import { chromium, devices } from 'playwright';
import YProvider from 'y-partyserver/provider';
import * as Y from 'yjs';
import { startWebDav } from '../test/webdav-server.mjs';

const BASE = process.env.WIKI_URL ?? 'http://127.0.0.1:8799';
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const PASSWORD = 'correct horse battery';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- a tiny API client ----------
class Client {
  cookies = new Map();
  constructor(name) { this.name = name; }
  get cookie() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  async call(method, path, body, headers = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: { cookie: this.cookie, ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); this.cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
    const data = res.status === 204 ? null : (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : null;
    if (res.status >= 300) throw new Error(`${this.name} ${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
    return data;
  }
  async connect(pageId) {
    const cookie = this.cookie;
    class CookieWS extends WebSocket { constructor(url, protocols) { super(url, protocols, { headers: { cookie } }); } }
    const doc = new Y.Doc();
    const provider = new YProvider(new URL(BASE).host, pageId, doc, { party: 'page-room', protocol: 'ws', WebSocketPolyfill: CookieWS });
    await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('sync timeout')), 8000); provider.on('sync', (s) => s && (clearTimeout(t), resolve())); });
    return { doc, close: () => (provider.destroy(), doc.destroy()) };
  }
}

// ---------- the demo team ----------
const dav = await startWebDav();
const auth = { authorization: `Basic ${btoa(`${dav.user}:${dav.pass}`)}` };
for (const f of ['ada', 'team', 'ben']) await fetch(`${dav.url}/${f}/`, { method: 'MKCOL', headers: auth });
const davUrl = (f) => `${dav.url}/${f}`;

const ada = new Client('ada'), ben = new Client('ben'), chloe = new Client('chloe'), dana = new Client('dana');
const EMAIL = { ada: 'ada@acme.example', ben: 'ben@acme.example', chloe: 'chloe@acme.example', dana: 'dana@acme.example' };
await ada.call('POST', '/api/auth/signup', { email: EMAIL.ada, name: 'Ada Okafor', password: PASSWORD });
for (const [c, name] of [[ben, 'Ben Carter'], [chloe, 'Chloe Martin'], [dana, 'Dana Reyes']]) {
  const key = c.name;
  await ada.call('POST', '/api/admin/users', { email: EMAIL[key], name, password: PASSWORD });
  await c.call('POST', '/api/auth/login', { email: EMAIL[key], password: PASSWORD });
}
const adaDrive = await ada.call('POST', '/api/users/me/storages', { name: 'Ada’s cloud drive', url: davUrl('ada'), username: dav.user, password: dav.pass });
const teamDrive = await ada.call('POST', '/api/admin/shared-storages', { name: 'Team drive', url: davUrl('team'), username: dav.user, password: dav.pass });
for (const [c, mb] of [[ben, 2048], [chloe, 512], [dana, 1024]]) {
  const me = await c.call('GET', '/api/me');
  await ada.call('PUT', `/api/admin/shared-storages/${teamDrive.id}/grants/${me.user.id}`, { limitBytes: mb * 1048576 });
}
const ws = await ada.call('POST', '/api/workspaces', { name: 'Acme product team', storageId: adaDrive.id });
for (const key of ['ben', 'chloe', 'dana']) await ada.call('POST', `/api/workspaces/${ws.id}/members`, { email: EMAIL[key], role: 'member' });
const general = (await ada.call('GET', `/api/workspaces/${ws.id}/projects`))[0];
const eng = await ada.call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Engineering', defaultRole: 'editor' });
const mkt = await ada.call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Marketing', defaultRole: 'editor' });

// Ben's own workspace on the shared storage, with something stored there (for the admin screens)
const benWs = await ben.call('POST', '/api/workspaces', { name: 'Design lab', storageId: teamDrive.id });
const benProject = (await ben.call('GET', `/api/workspaces/${benWs.id}/projects`))[0];
const benPage = await ben.call('POST', `/api/projects/${benProject.id}/pages`, {});
const blob = new Uint8Array(randomBytes(1_700_000));
await ben.call('POST', `/api/pages/${benPage.id}/files`, blob, { 'content-type': 'application/zip', 'x-filename': 'brand-assets.zip' });

// pages, with titles and emoji set the way the editor does (in the page's live document)
const pages = {};
async function makePage(client, project, key, title, icon, parent = null) {
  const page = await client.call('POST', `/api/projects/${project.id}/pages`, parent ? { parentId: parent } : {});
  const live = await client.connect(page.id);
  live.doc.getMap('meta').set('title', title);
  if (icon) live.doc.getMap('meta').set('icon', icon);
  await sleep(3200);
  live.close();
  pages[key] = page.id;
  return page.id;
}
await makePage(ada, general, 'launch', 'Q3 launch plan', '🚀');
await makePage(ada, general, 'timeline', 'Timeline', '🗓️', pages.launch);
await makePage(ada, general, 'risks', 'Risks and open questions', '⚠️', pages.launch);
await makePage(ada, general, 'notes', 'Weekly sync notes', '📝');
await makePage(ada, general, 'onboard', 'Onboarding guide', '👋');
await makePage(ada, eng, 'arch', 'Architecture overview', '🧩');
await makePage(ada, eng, 'api', 'API reference', '📚');
await makePage(ada, eng, 'runbook', 'Incident runbook', '🛟');
await makePage(ada, mkt, 'checklist', 'Launch checklist', '✅');
await makePage(ada, mkt, 'brand', 'Brand guidelines', '🎨');

// files for the workspace: a diagram, a PDF and a few more
const browser = await chromium.launch();
const scratch = await (await browser.newContext({ viewport: { width: 960, height: 330 }, deviceScaleFactor: 2 })).newPage();
await scratch.setContent(`<body style="margin:0;font:600 15px system-ui,sans-serif;background:#f4f6fb;color:#1f2937">
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:28px;align-items:center;padding:30px 48px 22px;height:250px;position:relative">
${[['Browser','React + BlockNote','#e7f0ff','#1971c2'],['Worker','Auth · access rules','#e6fcf5','#0ca678'],['Durable Object','One live room per page','#fff4e6','#f08c00'],['Your storage','Files + history over WebDAV','#f3f0ff','#7048e8']]
 .map(([a,b,c,d]) => `<div style="background:${c};border:2px solid ${d};border-radius:16px;padding:26px 18px;text-align:center;box-shadow:0 8px 24px rgb(0 0 0/6%)"><div style="font-size:19px;color:${d}">${a}</div><div style="font-weight:400;font-size:13px;margin-top:8px;color:#4b5563">${b}</div></div>`).join('')}
</div><div style="text-align:center;color:#6b7280;font-weight:400">Everything runs on Cloudflare; the files stay in drives you choose.</div></body>`);
const diagram = await scratch.screenshot();
await scratch.setContent('<h1 style="font-family:Georgia,serif">Brand guidelines</h1><p style="font-family:Georgia,serif;font-size:18px">Logo, colour and tone of voice for the launch.</p>');
const pdf = await scratch.pdf({ format: 'A5' });
const up = (client, pageId, name, mime, bytes) => client.call('POST', `/api/pages/${pageId}/files`, new Uint8Array(bytes), { 'content-type': mime, 'x-filename': encodeURIComponent(name) });
const diagramFile = await up(ada, pages.launch, 'architecture-diagram.png', 'image/png', diagram);
await up(ada, pages.brand, 'Brand guidelines.pdf', 'application/pdf', pdf);
await up(ada, pages.checklist, 'Pricing model Q3.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', new Uint8Array(randomBytes(48_000)));
await up(chloe, pages.checklist, 'Launch announcement.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', new Uint8Array(randomBytes(212_000)));
await up(dana, pages.arch, 'load-test-results.csv', 'text/csv', new TextEncoder().encode('run,rps,p95\n1,820,210\n2,905,198\n'));
await up(dana, pages.arch, 'team-offsite.jpg', 'image/jpeg', new Uint8Array(randomBytes(640_000)));

// ---------- the browser ----------
const login = async (page, who, phone = false) => {
  await page.goto(BASE);
  await page.getByLabel('Email').fill(EMAIL[who]);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: /Sign in/ }).first().click();
  // on a phone the page tree is behind a "Pages" button
  await (phone ? page.getByRole('button', { name: 'Pages', exact: true }) : page.locator('.navbar')).waitFor({ timeout: 15000 });
};
const mkctx = async (opts = {}) => (await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts })).newPage();
const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png` });
const openPage = async (page, key) => {
  await page.goto(`${BASE}/w/${ws.id}/p/${pages[key]}`);
  await page.locator('.page:not(.is-loading) .title').waitFor({ timeout: 15000 });
  await sleep(600);
};
const pageUrl = (key) => `${BASE}/w/${ws.id}/p/${pages[key]}`;

const adaPage = await mkctx();
await login(adaPage, 'ada');

// ---- write the launch plan in the editor ----
await openPage(adaPage, 'launch');
const type = async (text, opts) => adaPage.keyboard.type(text, opts);
const enter = () => adaPage.keyboard.press('Enter');
await adaPage.click('.title'); await adaPage.keyboard.press('Enter');
await type('Everything the team needs to ship Cloud Doc 2.0 on 12 September. Owners and dates are below; questions go in the comments.'); await enter();
await type('## Goals'); await enter();
await type('- Ship collaborative comments to every workspace'); await enter();
await type('Cut the time to open a page below one second'); await enter();
await type('Move the team’s files to shared storage'); await enter(); await enter();
await type('## Open questions'); await enter();
await type('Is the beta date realistic if the design review slips by a week? We still need sign-off on pricing before we announce anything.'); await enter();
await type('## Timeline'); await enter();
await type('/table'); await sleep(500); await enter(); await sleep(400);
for (const cell of ['Milestone', 'Owner', 'Date', 'Beta to customers', 'Ben', '1 Sep']) {
  await type(cell); await adaPage.keyboard.press('Tab'); await sleep(60);
}
await sleep(1500);
console.log('typed');

// ---- put files in pages through the Workspace files window ----
const insertFromFiles = async (page, name) => {
  await page.getByRole('button', { name: 'Workspace files' }).click();
  await page.getByRole('dialog').getByLabel(`Add ${name} to the open page`).click();
  await page.keyboard.press('Escape'); await sleep(700);
};
await insertFromFiles(adaPage, 'architecture-diagram.png');
await sleep(500);
await openPage(adaPage, 'checklist');
await adaPage.click('.bn-editor');
await adaPage.keyboard.type('Everything that has to be true before 12 September.'); await adaPage.keyboard.press('Enter');
await insertFromFiles(adaPage, 'architecture-diagram.png');
await insertFromFiles(adaPage, 'Pricing model Q3.xlsx');
await sleep(14000); // let both pages save, so the files know where they are used

// ---- highlights on the launch plan, in read mode ----
await openPage(adaPage, 'launch');
await adaPage.getByText('Read', { exact: true }).first().click({ force: true }); await sleep(600);
const selectText = async (phrase) => {
  const found = await adaPage.evaluate((phrase) => {
    const walker = document.createTreeWalker(document.querySelector('.page .bn-editor'), NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const i = n.textContent.indexOf(phrase);
      if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + phrase.length); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); return true; }
    }
    return false;
  }, phrase);
  if (!found) throw new Error(`text not found: ${phrase}`);
  await sleep(600);
};
const highlight = async (phrase, color, shape) => {
  await selectText(phrase);
  if (shape) await adaPage.getByRole('button', { name: shape, exact: true }).click();
  await adaPage.locator('.selection-highlight-palette button').nth(color).click();
  await sleep(900);
};
// (the panel lists the newest first, so the thread with the longest conversation goes last)
await highlight('below one second', 5, 'Underline');
await highlight('collaborative comments', 6);
await highlight('sign-off on pricing', 3);
await highlight('design review slips by a week', 0);
await sleep(1200);

const found = await ada.call('GET', `/api/pages/${pages.launch}/comments`);
const thread = (quote) => found.find((c) => c.quote === quote && c.id === c.thread_id).id;
const reviewThread = thread('design review slips by a week');
const pricingThread = thread('sign-off on pricing');
const goalThread = thread('collaborative comments');
await ben.call('POST', `/api/pages/${pages.launch}/comments`, { threadId: reviewThread, body: '**Risk:** the design review slipped twice last quarter. We can only hold **1 Sep** if sign-off lands by Friday, @Ada Okafor.' });
await chloe.call('POST', `/api/pages/${pages.launch}/comments`, { threadId: reviewThread, body: 'Agreed. I will flag it in the sync and add it to the [launch checklist](' + pageUrl('checklist') + '). #launch #q3' });
await chloe.call('POST', `/api/pages/${pages.launch}/comments`, { threadId: pricingThread, body: 'Waiting on finance for the final numbers. #pricing #blocker' });
const danaReply = await dana.call('POST', `/api/pages/${pages.launch}/comments`, { threadId: goalThread, body: 'Comments are done on the backend; the UI work is tracked in:\n- [ ] threads and replies\n- [x] highlights in four shapes\n- [x] `@mentions` and `#tags`' });
await ben.call('POST', `/api/pages/${pages.launch}/comments`, { threadId: goalThread, parentId: danaReply.id, body: 'Nice. Added a screenshot to the checklist.' });
// a discussion about the page as a whole
const disc = await ben.call('POST', `/api/pages/${pages.launch}/comments`, { body: '**Kick-off notes**\n\n| Area | Owner | Status |\n| --- | --- | --- |\n| Design | @Chloe Martin | in review |\n| Backend | @Dana Reyes | done |\n| Launch plan | @Ada Okafor | draft |\n\nThe architecture sketch is in [Architecture overview](' + pageUrl('arch') + '). #launch #kickoff' });
const thanks = await ada.call('POST', `/api/pages/${pages.launch}/comments`, { threadId: disc.id, body: 'Thanks Ben. Pricing is the open item: tracking it as #pricing.' });
await ben.call('POST', `/api/pages/${pages.launch}/comments`, { threadId: disc.id, parentId: thanks.id, body: 'Agreed. I will bring the numbers on Thursday.' });
await dana.call('POST', `/api/pages/${pages.launch}/comments`, { body: 'Load test finished: p95 under 200 ms at 900 req/s ✅ #performance #launch' });

// Ben is on the page too, so Ada sees his avatar
const benBrowser = await mkctx(); await login(benBrowser, 'ben'); await benBrowser.goto(pageUrl('launch')); await benBrowser.locator('.page:not(.is-loading)').waitFor(); await sleep(800);

// ---- the shots ----
await openPage(adaPage, 'launch');
await adaPage.getByText('Read', { exact: true }).first().click({ force: true }); await sleep(500);
await adaPage.getByRole('button', { name: 'Highlights', exact: true }).click(); await sleep(1500);
await adaPage.locator('.thread').first().click(); await sleep(1800);
await shot(adaPage, 'highlights');
await adaPage.getByRole('button', { name: 'Discussion', exact: true }).click(); await sleep(1200);
await shot(adaPage, 'discussion');
await adaPage.getByRole('button', { name: 'Close panel' }).click(); await sleep(400);
await adaPage.getByText('Edit', { exact: true }).first().click({ force: true }); await sleep(2500);
await adaPage.mouse.move(700, 450);
await shot(adaPage, 'editor');
console.log('page shots');

// ---- workspace files ----
await adaPage.getByRole('button', { name: 'Workspace files' }).click(); await sleep(1200);
await adaPage.getByRole('dialog').getByText('Used in 2 pages').first().click(); await sleep(500);
await shot(adaPage, 'files');
await adaPage.keyboard.press('Escape'); await sleep(500);

// ---- search ----
await adaPage.getByPlaceholder(/Search pages/).fill('beta'); await sleep(2200);
await shot(adaPage, 'search');
await adaPage.getByRole('button', { name: 'Exit search' }).click(); await sleep(400);

// ---- deleting a page that has files ----
await openPage(adaPage, 'checklist');
await adaPage.locator('.navbar .tree-row', { hasText: 'Launch checklist' }).hover();
await adaPage.getByRole('button', { name: 'Actions for Launch checklist' }).click();
await adaPage.getByRole('menuitem', { name: /Delete/ }).click();
await adaPage.getByRole('dialog').getByText('only here').waitFor(); await sleep(400);
await shot(adaPage, 'delete');
await adaPage.getByRole('button', { name: 'Cancel' }).click(); await sleep(400);

// ---- admin: shared storage and usage ----
for (const c of [ben, chloe, dana, ada]) for (let i = 0; i < 30; i++) await c.call('GET', `/api/workspaces/${ws.id}/tree`).catch(() => undefined);
await adaPage.locator('.me-button').click(); await adaPage.getByRole('menuitem', { name: 'Admin' }).click();
await adaPage.getByRole('tab', { name: 'Storage' }).click(); await sleep(1200);
await shot(adaPage, 'admin-storage');
await adaPage.getByRole('tab', { name: 'Usage' }).click(); await sleep(1800);
await shot(adaPage, 'admin-usage');
await adaPage.keyboard.press('Escape'); await sleep(400);

// ---- dark theme ----
const darkPage = await mkctx({ colorScheme: 'dark' });
await login(darkPage, 'ada'); await openPage(darkPage, 'launch');
await darkPage.getByText('Read', { exact: true }).first().click({ force: true }); await sleep(500);
await darkPage.getByRole('button', { name: 'Highlights', exact: true }).click(); await sleep(1500);
await darkPage.locator('.thread').first().click(); await sleep(1800);
await shot(darkPage, 'dark');

// ---- phone ----
const phoneShot = async (open) => {
  const phone = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();
  await login(phone, 'ada', true);
  await phone.goto(pageUrl('launch')); await phone.locator('.page:not(.is-loading) .title').waitFor(); await sleep(1200);
  if (open) {
    await phone.getByRole('button', { name: 'Page actions' }).click();
    await phone.getByRole('menuitem', { name: 'Highlights' }).click(); await sleep(1500);
  }
  return phone.screenshot();
};
const phoneA = (await phoneShot(false)).toString('base64');
const phoneB = (await phoneShot(true)).toString('base64');
const comp = await (await browser.newContext({ viewport: { width: 1180, height: 880 }, deviceScaleFactor: 1 })).newPage();
await comp.setContent(`<body style="margin:0;background:linear-gradient(135deg,#e7f0ff,#f3f0ff);display:flex;gap:56px;justify-content:center;align-items:center;height:880px">
${[phoneA, phoneB].map((b) => `<img src="data:image/png;base64,${b}" style="height:780px;border-radius:38px;border:10px solid #1f2937;box-shadow:0 30px 60px rgb(31 41 55/30%)">`).join('')}</body>`);
await comp.screenshot({ path: `${OUT}phone.png` });
console.log('all shots');
await browser.close(); dav.close();
process.exit(0);
