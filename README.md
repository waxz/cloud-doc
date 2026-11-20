# Cloud Doc

A collaborative wiki that runs entirely on Cloudflare: workspaces and
projects, accounts and permissions, several people editing a page at once
with live cursors, comments, page history, and pages you can share or
publish with a link. Each user keeps their uploads and page history in their
own WebDAV storage, such as a [cloud-drive](https://github.com/waxz/cloud-drive)
drive or Nextcloud. Works on laptops and phones.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/waxz/cloud-doc)

| Piece | Built with |
| --- | --- |
| Editor and UI | [BlockNote](https://www.blocknotejs.org/) (MPL-2.0) with Yjs collaboration; [Mantine](https://mantine.dev/) and [Tabler icons](https://tabler.io/icons) |
| Live sync | One Durable Object per page ([`y-partyserver`](https://github.com/cloudflare/partykit/tree/main/packages/y-partyserver)), hibernating WebSockets |
| Page content | The page's Yjs document, in its Durable Object's SQLite storage |
| Accounts, workspaces, projects, permissions, storages, comments, share links, search | D1 (search uses FTS5) |
| Images, video, PDFs, files, page history | Each user's WebDAV storage |

```
 browser ──HTTP──▶ Worker ── checks access ──▶ D1
    │                 └──────────────────────▶ the user's WebDAV storage (files)
    └─WebSocket─▶ Worker ── role ──▶ PageRoom Durable Object (one per page)
                                       ├─ Yjs sync + presence (read-only below editor)
                                       ├─ saves state to its SQLite storage
                                       ├─ on save: title + text → D1 search
                                       └─ snapshots → the saver's WebDAV storage
```

## Features

- **Accounts.** The first account created on a new install is the instance
  admin. After that, sign-up is closed: the admin creates accounts directly,
  or sends registration links (optionally tied to an email, with a role and an
  expiry; each works once). Admins set each user's role (admin or member),
  whether they may create workspaces, a storage limit, their WebDAV storage,
  and can disable or delete accounts.
- **Storage per user.** In *Settings → Storage* each user adds one or more
  WebDAV folders, tests the connection, and picks a default plus, optionally,
  a different one per workspace. Their uploads and the history versions they
  save go there; the usage counts against their storage limit.
- **Workspaces** with owners, admins and members. Admins add people by email;
  someone without an account joins when they sign up with that email.
- **Projects** inside a workspace, each with a page tree. A project either
  gives everyone in the workspace a default role or is private to the people
  added to it.
- **Roles per project:** *viewer*, *commenter*, *editor*, *admin*. Workspace
  owners and admins administer every project.
- **Page tree** like Docmost's: fold/unfold (remembered per browser), emoji
  icons, drag and drop to reorder or nest (drop on the top or bottom edge of a
  page to place it before or after, on the middle to put it inside), and a ⋯
  menu with *Add subpage*, *Upload file…*, *Move to…* (handy on phones),
  *Copy link* and *Delete*.
- **Real-time editing** with live cursors and avatars. The title and emoji
  sync like the body. Viewers and commenters get the page live but read-only.
- **Images, video, audio, PDFs and files** in pages: drop or paste them into
  the editor, use `/image`, `/video`, `/pdf` or `/file`, upload from the tree's
  ⋯ menu, or from the page's *Files* panel. PDFs show inline. Files are
  streamed from the uploader's storage to anyone who can read the page (with
  range requests, so video seeks).
- **Phones and tablets:** the page tree is a slide-out menu, panels open as
  bottom sheets, and page actions sit in a ⋯ menu.
- **Comments** in a side panel: threads with replies, a quote of the selected
  text (select text and press *Comment* in the formatting toolbar; commenters
  get a *Comment* button over their selection), resolve/reopen, edit or delete your own. Open pages refresh
  when someone comments.
- **Page history:** a snapshot of the page is saved at most every 10 minutes
  while it changes, plus *Save a version now*. A saved version goes to the
  storage of whoever saved it; automatic ones go to the page creator's storage
  (or the workspace owner's), and are skipped if they have none or are over
  their limit. Preview any
  version and restore it; the restore reaches everyone on the page live, and
  the replaced content is kept as a *before restore* version.
- **Share and publish:** links that grant *can view*, *can comment* or *can
  edit* on a page, optionally with its subpages and an expiry. View links work
  signed out, which publishes the page. Comment and edit links ask people to
  sign in. Links show only the pages they cover.
- **Search** across the projects you can see: accent-insensitive, prefix
  matching, highlighted snippets.

## Who can do what

| | Viewer | Commenter | Editor | Admin |
| --- | --- | --- | --- | --- |
| Read pages, see comments | ✓ | ✓ | ✓ | ✓ |
| Comment, reply, resolve | | ✓ | ✓ | ✓ |
| Edit, upload, create/move/delete pages | | | ✓ | ✓ |
| Save and restore versions | | | ✓ | ✓ |
| Create view/comment links | | | ✓ | ✓ |
| Create edit links, manage project, delete others' comments | | | | ✓ |

Every rule is checked on the server. Live sync gets the role from the Worker
(never from the client), and the page's Durable Object drops edits from
viewer and commenter connections.

Through a share link: signed-out visitors only ever read, and an edit link
lets people change page content but not create, move or delete pages. A view-only link
shows the page but not its comments; no link shows history (it can contain
content that was removed on purpose).

## Deploy

Everything deploys with one command: `wrangler deploy` builds the app, and
creates the D1 database and the Durable Object on the first deploy. The
Worker applies database migrations itself on its first request, so there's
no separate migration step.

**Deploy to Cloudflare button.** Click the button at the top. Cloudflare
copies the repository to your GitHub account, creates the resources and
deploys. Later pushes to that copy deploy automatically.

**From your machine:**

```bash
npm install
```

```bash
npx wrangler deploy
```

**From GitHub (Workers Builds).** In the Cloudflare dashboard, create a
Worker from this repository. The default deploy command (`npx wrangler
deploy`) is all it needs; no build command.

Then open the Worker's URL and create the first account: it becomes the
admin. Add your WebDAV storage under *your name → Storage*, and invite people
from *your name → Admin → Registration links*. The Free plan is enough; see
[Workers Free plan](#workers-free-plan).

### Storage

Any WebDAV server works: a [cloud-drive](https://github.com/waxz/cloud-drive)
drive (`https://<host>/dav/<drive>`), Nextcloud
(`https://<host>/remote.php/dav/files/<user>`), and others. Use an app
password where the server offers one. Everything goes under a `cloud-doc/`
folder in it:

```
cloud-doc/<workspace>/<page>/files/<file id>-<name>
cloud-doc/<workspace>/<page>/history/<version>.ydoc
```

A page's folder is removed from every storage that holds part of it when the
page is deleted. A storage can't be removed while files or versions still use
it. Storage passwords are kept in D1 and never sent back to the browser.

`wrangler.toml` sets the `global_fetch_strictly_public` compatibility flag,
so a cloud-drive Worker on the same Cloudflare account is reached through its
public URL like any other server.

## Configuration

| Name | Kind | Meaning |
| --- | --- | --- |
| `PASSWORD_ITERATIONS` | var | PBKDF2-SHA256 iterations for new passwords. Default 50,000. |

## Develop locally

```bash
npm install
```

```bash
npm run dev
```

opens the app on `http://localhost:8787` (Wrangler builds the client first
and rebuilds when `client/` changes). For storage, run the small in-memory
WebDAV server the tests use:

```bash
node test/webdav-server.mjs
```

and add `http://127.0.0.1:8793` (user `dav`, password `davpass`) in
*Settings → Storage*; or point it at a local cloud-drive. Open the app in two
browsers to see live editing.

### Tests

Both suites need a running app with an **empty** database (the first account
they create must become the admin), and start their own WebDAV server. For
example:

```bash
npx wrangler dev --persist-to /tmp/cloud-doc-test
```

```bash
npm run test:api
```

checks the first-account admin, closed sign-up and registration links,
admin-created and disabled accounts, storages (testing, default,
per-workspace, admin-managed, passwords hidden), invites, project privacy and
roles, read-only live sync, search scoping, uploads (range reads, storage
limits, deletes), comments, history in the saver's storage with live restore,
share links and delete cascades into storage. `WIKI_URL` points it at the app.

```bash
npm run test:ui
```

walks through the same flows in a browser, on a desktop window and an
iPhone-sized one: setup, storage, emoji, uploading an image and a PDF from the
tree, registration links, co-editing, the toolbar's Comment button, history,
the Files panel, drag and drop in the tree and the phone's menu and bottom
sheets. Set `CHROMIUM_PATH` to use an existing Chromium (otherwise run
`npx playwright install chromium` first), and `SHOTS` to a folder for
screenshots. Run each suite against its own fresh database.

## Workers Free plan

The design fits the Free plan for a small team:

- The Worker is about 90 KB gzipped (limit 3 MB); static files don't count.
- Sync messages are small, so requests stay inside the 10 ms CPU limit, and
  Durable Objects hibernate between messages.
- Password hashing is the one CPU-heavy step. Measured in local workerd,
  50,000 PBKDF2 iterations take about 5 ms and 100,000 (the Workers maximum)
  about 13 ms, so the default is 50,000. On the paid plan, set
  `PASSWORD_ITERATIONS` to 100,000; each hash records its own count, so
  existing passwords keep working. Failed sign-ins are limited to 10 per email
  per 15 minutes.
- Page content is saved by the Durable Object (2 s after the last edit, at
  most every 10 s), so D1 sees one write per save, not per keystroke.

The daily quotas set the ceiling: 100,000 Worker requests and 100,000
Durable Object requests per day. Incoming WebSocket messages count toward the
Durable Object quota (20 messages per request), so heavy all-day editing by
many people will outgrow the Free plan.

## Limits worth knowing

- Lowering someone's role takes effect on new connections; a page they
  already have open keeps its live connection until they reload or reconnect.
- No email sending: no address verification, password reset or invite emails.
  Admins send registration links themselves, and reset passwords in the
  admin panel.
- Comments sit in a side panel with an optional quote; they aren't anchored to
  a position in the text.
- On a published page, signed-out readers see the avatars of people currently
  editing it.

## Layout

| Path | What it is |
| --- | --- |
| `worker/index.ts` | Router and live-sync entry (sets the role for the page's room) |
| `worker/migrate.ts` | Applies bundled D1 migrations on first use |
| `worker/auth.ts` | Accounts, first-account setup, registration links, password hashing, sessions |
| `worker/settings.ts` | Profile, storages, admin (users and registration links) |
| `worker/access.ts` | Roles: workspace, project, share link → effective page role |
| `worker/workspaces.ts` | Workspaces, members, invites, projects, project members |
| `worker/pages.ts` | Pages, search, files, history, comments, share links |
| `worker/storage.ts` | WebDAV client, picking a user's storage, storage limits |
| `worker/page-room.ts` | `PageRoom` Durable Object: sync, read-only roles, save, snapshots, restore |
| `.npmrc` | `legacy-peer-deps`: y-partyserver still declares the old workers-types 4 as a peer while Wrangler wants 5 (types only) |
| `migrations/` | D1 schema (also listed in `worker/migrate.ts`) |
| `client/src/` | React app: shell, page tree, editor (PDF block, toolbar), page view, comments, files, history, share, settings, admin |
| `test/` | `api.mjs` (API and permissions), `ui.cjs` (browser walk-through), `webdav-server.mjs` (in-memory WebDAV for tests and local use) |
