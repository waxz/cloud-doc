// Browser walk-through of the main flows with Playwright, on desktop and on a
// phone, against a running Cloud Doc with an EMPTY database (the first
// account made here becomes the admin). Starts its own WebDAV server.
// Usage: WIKI_URL=http://127.0.0.1:8787 SHOTS=/tmp/x node test/ui.cjs
const { chromium, devices } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const B = process.env.WIKI_URL ?? 'http://127.0.0.1:8787';
const SHOTS = process.env.SHOTS ?? '.test-output';
fs.mkdirSync(SHOTS, { recursive: true });
const run = Date.now().toString(36);
const opened = []; // pages, for a screenshot of each when something fails

(async () => {
  const { startWebDav } = await import('./webdav-server.mjs');
  const dav = await startWebDav();
  await fetch(`${dav.url}/alice/`, { method: 'MKCOL', headers: { authorization: `Basic ${btoa(`${dav.user}:${dav.pass}`)}` } });

  // CHROMIUM_PATH: use an existing Chromium instead of Playwright's download.
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const errors = [];
  const ctx = async (label, options = { viewport: { width: 1280, height: 820 } }) => {
    const c = await browser.newContext(options);
    await c.grantPermissions(['clipboard-read', 'clipboard-write']);
    const p = await c.newPage();
    p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    opened.push([label, p]);
    return p;
  };
  const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${name}.png` });
  const btn = (p, name) => p.getByRole('button', { name, exact: true });
  const nav = (p) => p.locator('.navbar');
  const treeRow = (p, title) => nav(p).locator('.tree-row').filter({ hasText: title });
  /** Clicks "New page" in a project and waits until the new, empty page is the one on screen. */
  const newPage = async (p, project) => {
    const before = p.url();
    await p.getByRole('button', { name: `New page in ${project}` }).first().click();
    await p.waitForURL((u) => u.href !== before && /\/p\//.test(u.pathname));
    await p.waitForFunction(() => {
      const t = document.querySelector('.title');
      return t && !t.readOnly && t.value === '';
    });
  };
  const editorHas = (p, text) => p.waitForFunction((t) => document.querySelector('.bn-editor')?.textContent.includes(t), text, { timeout: 10000 });
  const userMenu = async (p, item) => {
    await p.locator('.me-button').click();
    await p.getByRole('menuitem', { name: item }).click();
  };

  // Files to upload: a screenshot as the image and a printed page as the PDF.
  const scratch = await ctx('scratch');
  await scratch.setContent('<body style="margin:0;background:#1971c2;color:#fff;font:600 40px system-ui;display:grid;place-items:center;height:100vh">Launch diagram</body>');
  await scratch.setViewportSize({ width: 640, height: 280 });
  fs.writeFileSync(`${SHOTS}/diagram.png`, await scratch.screenshot());
  await scratch.setContent('<h1 style="font-family:system-ui">Beta checklist</h1><p>1. Docs<br>2. Pricing<br>3. Launch post</p>');
  fs.writeFileSync(`${SHOTS}/checklist.pdf`, await scratch.pdf({ format: 'A5' }));
  await scratch.context().close();

  // --- the first account is the admin ---
  const alice = await ctx('alice');
  const aliceEmail = `alice-${run}@example.com`, bobEmail = `bob-${run}@example.com`;
  await alice.goto(B);
  await alice.getByRole('heading', { name: 'Set up Cloud Doc' }).waitFor();
  await shot(alice, 'ui-setup');
  await alice.getByLabel('Email').fill(aliceEmail);
  await alice.getByLabel(/^Name/).fill('Alice');
  await alice.getByRole('textbox', { name: 'Password' }).fill('correct horse battery');
  await btn(alice, 'Create account').click();
  // a workspace needs a storage: Alice adds hers right there, tests it, then creates the workspace
  await alice.getByLabel('Workspace name').fill('Acme');
  assert.equal(await btn(alice, 'Create').isDisabled(), true, 'no storage, no workspace');
  await btn(alice, 'Add a storage').click();
  const dlg = alice.getByRole('dialog');
  await dlg.getByPlaceholder('My drive').fill('Home drive');
  await dlg.getByLabel('Server URL').fill(`${dav.url}/alice`);
  await dlg.getByLabel('Username').fill(dav.user);
  await dlg.getByLabel('Password', { exact: true }).fill(dav.pass);
  await btn(alice, 'Test').click();
  await dlg.getByText('Connected').waitFor();
  await btn(alice, 'Save').click();
  await dlg.getByText('Default', { exact: true }).waitFor();
  await shot(alice, 'ui-storage');
  await alice.keyboard.press('Escape');
  await btn(alice, 'Create').click();
  await nav(alice).getByText('General', { exact: true }).waitFor();
  console.log('✓ first account set up as admin; storage added and tested; workspace created on it');

  // --- a page with an emoji, text and uploads from the tree ---
  await newPage(alice, 'General');
  await alice.fill('.title', 'Roadmap');
  await alice.getByRole('button', { name: 'Add icon' }).click();
  await alice.locator('.emoji', { hasText: '🚀' }).click();
  await treeRow(alice, 'Roadmap').locator('.tree-icon', { hasText: '🚀' }).waitFor();
  await alice.click('.bn-editor');
  await alice.keyboard.type('Ship the beta in March.');
  await treeRow(alice, 'Roadmap').hover();
  await alice.getByRole('button', { name: 'Actions for Roadmap' }).click();
  const chooser = alice.waitForEvent('filechooser');
  await alice.getByRole('menuitem', { name: 'Upload file…' }).click();
  await (await chooser).setFiles([`${SHOTS}/diagram.png`, `${SHOTS}/checklist.pdf`]);
  await alice.waitForFunction(() => [...document.querySelectorAll('.bn-editor img')].some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 });
  await alice.locator('.bn-editor .pdf-reader').waitFor({ timeout: 10000 });
  assert.ok([...dav.files.keys()].some((k) => k.startsWith('/alice/cloud-doc/') && k.endsWith('diagram.png')), 'image stored in her WebDAV');
  await alice.waitForTimeout(800);
  await shot(alice, 'ui-page-media');
  console.log('✓ emoji icon; image and PDF uploaded from the tree render in the page');

  // --- admin: a registration link for Bob ---
  await userMenu(alice, 'Admin');
  await alice.getByRole('tab', { name: 'Registration links' }).click();
  await alice.getByLabel('For email (optional)').fill(bobEmail);
  await btn(alice, 'Create link').click();
  const regUrl = await alice.locator('.link-url').first().textContent();
  assert.match(regUrl, /\/register\//);
  await shot(alice, 'ui-admin-links');
  await alice.getByRole('tab', { name: 'Users' }).click();
  await alice.locator('.user-card').filter({ hasText: 'Alice' }).waitFor();
  await shot(alice, 'ui-admin-users');
  await alice.keyboard.press('Escape');
  console.log('✓ admin: registration link, users list');

  // --- Bob registers through the link ---
  const bob = await ctx('bob');
  await bob.goto(B);
  await bob.getByRole('heading', { name: 'Sign in' }).waitFor();
  assert.equal(await bob.getByRole('tab', { name: 'Create account' }).count(), 0, 'no open sign-up');
  await bob.goto(regUrl);
  await bob.getByRole('heading', { name: 'Create your account' }).waitFor();
  assert.equal(await bob.getByLabel('Email').inputValue(), bobEmail);
  await bob.getByLabel(/^Name/).fill('Bob');
  await bob.getByRole('textbox', { name: 'Password' }).fill('correct horse battery');
  await btn(bob, 'Create account').click();
  // Registering doesn't join a workspace: Alice adds Bob, then his sidebar fills in.
  await alice.getByRole('button', { name: 'Workspace settings' }).click();
  await alice.getByRole('combobox', { name: 'Add registered member' }).fill('Bob');
  await alice.getByRole('option', { name: new RegExp('Bob') }).click();
  await btn(alice, 'Add').click();
  await alice.getByText('Bob', { exact: true }).waitFor();
  await alice.keyboard.press('Escape');
  await bob.reload();
  await treeRow(bob, 'Roadmap').click();
  await editorHas(bob, 'Ship the beta in March.');
  await bob.waitForFunction(() => [...document.querySelectorAll('.bn-editor img')].some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 10000 });
  await bob.click('.bn-editor p >> nth=0');
  await bob.keyboard.press('End');
  await bob.keyboard.press('Enter');
  await bob.keyboard.type('Bob: docs need a pass first.');
  await editorHas(alice, 'docs need a pass');
  console.log('✓ registered member selected from searchable dropdown');
  console.log('✓ registration link → account → workspace; images readable; live co-editing');

  // --- highlight comment from the formatting toolbar, then a reply and resolve ---
  await bob.locator('.bn-editor').getByText('Ship the beta in March.').dblclick();
  await bob.locator('.bn-formatting-toolbar').getByRole('button', { name: 'Comment' }).click();
  const panel = bob.locator('.side-panel');
  await panel.getByText('Highlights').first().waitFor();
  await panel.locator('.composer .comment-editor .bn-editor').click();
  await bob.keyboard.type('Is March realistic?');
  await panel.getByRole('button', { name: 'Comment', exact: true }).click();
  await alice.getByRole('button', { name: 'Highlights', exact: true }).click();
  await alice.getByText('Is March realistic?').waitFor({ timeout: 8000 });
  await alice.locator('.dthread-actions').getByRole('button', { name: 'Reply', exact: true }).first().click();
  await alice.locator('.thread-composer .bn-editor').click();
  await alice.keyboard.type('Yes if docs land by Feb.');
  await alice.locator('.thread-composer').getByRole('button', { name: 'Reply', exact: true }).click();
  await bob.getByText('Yes if docs land by Feb.').waitFor({ timeout: 8000 });
  await shot(bob, 'ui-comments');
  await btn(alice, 'Resolve').click();
  await alice.getByRole('button', { name: /Resolved · 1/ }).click();
  await alice.getByText(/Resolved by/).waitFor();
  // and a page-level discussion
  await alice.getByRole('button', { name: 'Discussion', exact: true }).click();
  await alice.locator('.composer .comment-editor .bn-editor').click();
  await alice.keyboard.type('Kickoff #plan with https://example.com');
  await btn(alice, 'Post').click();
  await alice.locator('.comment-token-tag', { hasText: '#plan' }).waitFor();
  await alice.locator('.comment-link', { hasText: 'https://example.com' }).waitFor();
  // a reply to a reply nests under it
  await alice.getByRole('button', { name: 'Reply', exact: true }).first().click();
  await alice.locator('.thread-composer .bn-editor').click();
  await alice.keyboard.type('First answer');
  await alice.locator('.thread-composer').getByRole('button', { name: 'Reply', exact: true }).click();
  await alice.getByText('First answer').waitFor();
  await alice.locator('.dnode').getByRole('button', { name: 'Reply', exact: true }).first().click();
  await alice.locator('.thread-composer .bn-editor').click();
  await alice.keyboard.type('Answer to the answer');
  await alice.locator('.thread-composer').getByRole('button', { name: 'Reply', exact: true }).click();
  await alice.locator('.dnode .dnode', { hasText: 'Answer to the answer' }).waitFor();
  console.log('✓ comments: highlight from the toolbar, live reply, resolve, discussion with tag and link');

  // --- history in Alice's storage ---
  await alice.getByRole('button', { name: 'History' }).click();
  await btn(alice, 'Save a version now').click();
  await alice.locator('.version').first().waitFor();
  await alice.click('.bn-editor p >> nth=0', { position: { x: 4, y: 8 } }); // not on the highlighted word, which would open its comment
  await alice.keyboard.press('End');
  await alice.keyboard.press('Enter');
  await alice.keyboard.type('Temporary note to undo.');
  await editorHas(bob, 'Temporary note to undo.');
  await alice.locator('.version').filter({ hasText: 'Saved' }).first().click();
  await alice.getByRole('dialog').locator('.bn-editor').getByText('Ship the beta in March.').waitFor();
  await btn(alice, 'Restore this version').click();
  await bob.waitForFunction(() => !document.querySelector('.bn-editor')?.textContent.includes('Temporary note to undo.'), null, { timeout: 10000 });
  assert.ok([...dav.files.keys()].some((k) => k.endsWith('.ydoc')), 'history stored in her WebDAV');
  console.log('✓ history: save, preview, restore reaches other editors');

  // --- files panel ---
  await alice.getByRole('button', { name: 'Files', exact: true }).click();
  await alice.locator('.side-panel').getByText('diagram.png').waitFor();
  await alice.locator('.side-panel').getByText('checklist.pdf').waitFor();
  // the workspace's Files window lists them too, with where they are used
  await alice.getByRole('button', { name: 'All files of the workspace…' }).click();
  const filesDialog = alice.getByRole('dialog');
  await filesDialog.getByText('diagram.png').waitFor();
  await filesDialog.getByText('Used in 1 page').first().waitFor();
  await shot(alice, 'ui-workspace-files');
  await alice.keyboard.press('Escape');
  console.log('✓ files panel lists the uploads; the workspace Files window shows where they are used');

  // --- tree: drag a page into another, reorder ---
  await newPage(alice, 'General');
  await alice.fill('.title', 'Launch notes');
  await treeRow(alice, 'Launch notes').waitFor();
  await treeRow(alice, 'Launch notes').dragTo(treeRow(alice, 'Roadmap'));
  await alice.waitForFunction(() => {
    const roadmap = [...document.querySelectorAll('.navbar [role=treeitem]')].find((e) => e.querySelector('.tree-title')?.textContent === 'Roadmap');
    return roadmap?.querySelector('[role=group] .tree-title')?.textContent === 'Launch notes';
  });
  await shot(alice, 'ui-tree');
  await alice.reload();
  await treeRow(alice, 'Launch notes').waitFor();
  assert.equal(await alice.locator('[role=treeitem]:has(> .tree-row:has-text("Roadmap")) [role=group]').getByText('Launch notes').count(), 1, 'move saved');
  console.log('✓ tree: drag and drop moves a page under another, kept after reload');

  // --- private project hidden from Bob, shared by link ---
  await btn(alice, 'New project').click();
  await alice.getByRole('dialog').getByLabel('Name').fill('Leadership');
  await alice.getByRole('dialog').getByLabel('Who has access').click();
  await alice.getByRole('option', { name: 'Private: only people added below' }).click();
  await alice.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await nav(alice).getByText('Leadership', { exact: true }).waitFor();
  await newPage(alice, 'Leadership');
  await alice.fill('.title', 'Hiring plan');
  await alice.click('.bn-editor');
  await alice.keyboard.type('Two engineers in Q2.');
  await bob.reload();
  await nav(bob).getByText('General', { exact: true }).waitFor();
  assert.equal(await nav(bob).getByText('Leadership', { exact: true }).count(), 0, 'private project hidden from Bob');
  await btn(alice, 'Share').click();
  await btn(alice, 'Create link').click();
  const url = await alice.getByRole('dialog').locator('input[value^="http"]').first().inputValue();
  await alice.keyboard.press('Escape');
  const visitor = await ctx('visitor');
  await visitor.goto(url);
  await editorHas(visitor, 'Two engineers in Q2.');
  assert.equal(await visitor.getAttribute('.bn-editor', 'contenteditable'), 'false', 'visitor is read-only');
  assert.equal(await btn(visitor, 'Share').count(), 0);
  assert.equal(await visitor.getByRole('button', { name: 'History' }).count(), 0, 'no history through a link');
  console.log('✓ private project hidden; public link is read-only');

  // --- explorer: fold a project, search titles, workspace buttons on top, dark mode in the page header ---
  await alice.goto(alice.url()); // a fresh load of the page Alice is on
  await nav(alice).getByText('Hiring plan').first().waitFor();
  const order = await alice.evaluate(() => {
    const y = (sel) => document.querySelector(sel)?.getBoundingClientRect().top ?? -1;
    return { settings: y('button[aria-label="Workspace settings"]'), files: y('button[aria-label="Workspace files"]'), search: y('input[placeholder^="Search pages"]'), tree: y('.tree-row') };
  });
  assert.ok(order.settings > 0 && order.settings < order.search && order.files < order.search && order.search < order.tree, 'workspace settings and files sit above the search and the tree');
  await alice.locator('.me-button').click();
  assert.equal(await alice.getByRole('menuitem', { name: /Dark mode|Light mode/ }).count(), 0, 'no dark mode in the account menu');
  assert.equal(await alice.getByRole('menuitem', { name: 'Storage', exact: true }).count(), 0, 'storage lives inside Settings');
  await alice.keyboard.press('Escape');
  const schemeBefore = await alice.evaluate(() => document.documentElement.getAttribute('data-mantine-color-scheme'));
  await alice.getByRole('button', { name: /^(Dark|Light) mode$/ }).first().click();
  assert.notEqual(await alice.evaluate(() => document.documentElement.getAttribute('data-mantine-color-scheme')), schemeBefore, 'the switch in the page header changes the theme');
  await alice.getByRole('button', { name: /^(Dark|Light) mode$/ }).first().click();
  // fold a project: its pages go, its name and count stay
  await alice.getByRole('button', { name: 'Collapse Leadership' }).click();
  assert.equal(await nav(alice).getByText('Hiring plan').count(), 0, 'a folded project hides its pages');
  await nav(alice).getByText('(1)').waitFor();
  await alice.reload();
  await nav(alice).getByText('(1)').waitFor(); // remembered
  await alice.getByRole('button', { name: 'Expand Leadership' }).click();
  await nav(alice).getByText('Hiring plan').first().waitFor();
  // title search needs no request and finds by title only
  await nav(alice).getByText('Titles', { exact: true }).click();
  let searchRequests = 0;
  alice.on('request', (r) => r.url().includes('/search') && searchRequests++);
  await alice.getByPlaceholder(/Find a page by title/).fill('hiring');
  await nav(alice).locator('.hit-title', { hasText: 'Hiring plan' }).waitFor();
  await alice.getByPlaceholder(/Find a page by title/).fill('engineers');
  await nav(alice).getByText('No page with that title').waitFor();
  assert.equal(searchRequests, 0, 'title search asks the server for nothing');
  await nav(alice).getByText('Text', { exact: true }).click();
  // The page is saved and indexed a couple of seconds after the last edit (its body within a minute).
  for (let i = 0; ; i++) {
    const found = await alice.evaluate(async () => (await (await fetch(`/api/workspaces/${location.pathname.split('/')[2]}/search?q=hiring`)).json()).length);
    if (found > 0) break;
    assert.ok(i < 20, 'the page reaches the search index');
    await alice.waitForTimeout(1000);
  }
  await alice.getByPlaceholder(/Search pages/).fill('hiring');
  await nav(alice).locator('.hit-title', { hasText: 'Hiring plan' }).waitFor();
  await alice.getByRole('button', { name: 'Exit search' }).click();
  console.log('✓ explorer: projects fold, title search is local, workspace buttons on top, theme switch in the header');

  // --- block layout: any block can be floated and sized; everyone sees it ---
  await alice.locator('.bn-editor').getByText('Two engineers in Q2.').first().click({ clickCount: 3 });
  await alice.locator('[data-test^="blocklayout"]').click();
  await alice.getByText('Float left', { exact: true }).click();
  await alice.getByText('50%', { exact: true }).click();
  const placed = (page) => page.evaluate(() => {
    const outer = [...document.querySelectorAll('.bn-block-outer')].find((o) => o.textContent.includes('Two engineers in Q2.'));
    const column = outer.parentElement.getBoundingClientRect().width;
    return { float: getComputedStyle(outer).float, share: Math.round((outer.getBoundingClientRect().width / column) * 100) };
  });
  const mine = await placed(alice);
  assert.equal(mine.float, 'left', 'the block floats left');
  assert.ok(mine.share >= 45 && mine.share <= 52, `and takes about half the column (got ${mine.share}%)`);
  await visitor.waitForFunction(() => [...document.querySelectorAll('.bn-block-outer')].some((o) => o.textContent.includes('Two engineers in Q2.') && getComputedStyle(o).float === 'left'), null, { timeout: 10000 });
  assert.equal((await placed(visitor)).float, 'left', "a reader sees the arrangement live, from the shared document");
  await alice.locator('[data-test^="blocklayout"]').click().catch(() => {}); // reopen if the menu closed
  await alice.getByRole('button', { name: 'Reset' }).click();
  await alice.waitForFunction(() => ![...document.querySelectorAll('.bn-block-outer')].some((o) => o.textContent.includes('Two engineers in Q2.') && getComputedStyle(o).float !== 'none'));
  console.log('✓ block layout: float and width for a text block, shared live, reset');

  // --- phone ---
  const phone = await ctx('phone', { ...devices['iPhone 13'] });
  await phone.goto(B);
  await phone.getByLabel('Email').fill(bobEmail);
  await phone.getByRole('textbox', { name: 'Password' }).fill('correct horse battery');
  await btn(phone, 'Sign in').click();
  await btn(phone, 'Pages').click();
  await treeRow(phone, 'Roadmap').waitFor();
  await phone.waitForTimeout(300);
  await shot(phone, 'ui-phone-tree');
  await treeRow(phone, 'Roadmap').locator('.tree-title').click();
  await editorHas(phone, 'Ship the beta in March.');
  await phone.waitForFunction(() => [...document.querySelectorAll('.bn-editor img')].some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 10000 });
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scrolling');
  await phone.waitForTimeout(500);
  await shot(phone, 'ui-phone-page');
  await phone.getByRole('button', { name: 'Page actions' }).click();
  await phone.getByRole('menuitem', { name: 'Highlights' }).click();
  await phone.getByRole('dialog').locator('.comments-panel').waitFor();
  await phone.waitForTimeout(400);
  await shot(phone, 'ui-phone-comments');
  // Safari zooms into fields under 16px, and a toolbar wider than the screen stretches the page.
  const small = await phone.evaluate(() => [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]),textarea,select,[contenteditable="true"]')]
    .filter((e) => e.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => `${e.tagName}.${e.className}`.slice(0, 50)));
  assert.deepEqual(small, [], 'every field is at least 16px on a phone');
  await phone.getByRole('button', { name: 'Close panel' }).click().catch(() => phone.keyboard.press('Escape'));
  await phone.waitForTimeout(500);
  await phone.locator('.bn-editor').getByText('Ship the beta in March.').first().click({ clickCount: 3 });
  await phone.locator('.bn-formatting-toolbar').waitFor({ timeout: 5000 });
  const bar = await phone.locator('.bn-formatting-toolbar').boundingBox();
  assert.ok(bar.x >= 0 && bar.x + bar.width <= 391, 'the formatting toolbar stays on the screen');
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'selecting text does not widen the page');
  console.log('✓ phone: drawer navigation, page with media, panels as bottom sheets, fields 16px, toolbar fits');

  console.log('errors:', errors);
  assert.equal(errors.length, 0);
  console.log('\nUI walk-through passed');
  dav.close();
  await browser.close();
})().catch(async (e) => {
  console.error('FAILED:', e.message.split('\n').slice(0, 8).join('\n'));
  for (const [label, p] of opened) await p.screenshot({ path: `${SHOTS}/failed-${label}.png` }).catch(() => {});
  process.exit(1);
});
