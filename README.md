# Cloud Doc

A collaborative wiki that runs entirely on Cloudflare: workspaces and
projects, accounts and permissions, several people editing a page at once
with live cursors, comments, page history, and pages you can share or
publish with a link. Files and page history are stored in
[cloud-drive](https://github.com/waxz/cloud-drive).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/waxz/cloud-doc)

| Piece | Built with |
| --- | --- |
| Editor | [BlockNote](https://www.blocknotejs.org/) (React, MPL-2.0) with Yjs collaboration, Mantine UI |
| Live sync | One Durable Object per page ([`y-partyserver`](https://github.com/cloudflare/partykit/tree/main/packages/y-partyserver)), hibernating WebSockets |
| Page content | The page's Yjs document, in its Durable Object's SQLite storage |
| Accounts, workspaces, projects, permissions, comments, share links, search | D1 (search uses FTS5) |
| Images, files, page history | cloud-drive, over its WebDAV API (optional) |

```
 browser ──HTTP──▶ Worker ── checks access ──▶ D1
    │                 └──────────────────────▶ cloud-drive (files, history)
    └─WebSocket─▶ Worker ── role ──▶ PageRoom Durable Object (one per page)
                                       ├─ Yjs sync + presence (read-only below editor)
                                       ├─ saves state to its SQLite storage
                                       ├─ on save: title + text → D1 search
                                       └─ snapshots → cloud-drive history/
```

## Features

- **Workspaces** with owners, admins and members. Admins add people by email;
  someone without an account joins when they sign up with that email.
- **Projects** inside a workspace, each with a page tree. A project either
  gives everyone in the workspace a default role or is private to the people
  added to it.
- **Roles per project:** *viewer*, *commenter*, *editor*, *admin*. Workspace
  owners and admins administer every project.
- **Real-time editing** with live cursors and avatars. The title syncs like
  the body. Viewers and commenters get the page live but read-only.
- **Comments** in a side panel: threads with replies, an optional quote of the
  selected text, resolve/reopen, edit or delete your own. Open pages refresh
  when someone comments.
- **Page history:** a snapshot of the page is written to cloud-drive at most
  every 10 minutes while it changes, plus *Save a version now*. Preview any
  version and restore it; the restore reaches everyone on the page live, and
  the replaced content is kept as a *before restore* version.
- **Share and publish:** links that grant *can view*, *can comment* or *can
  edit* on a page, optionally with its subpages and an expiry. View links work
  signed out, which publishes the page. Comment and edit links ask people to
  sign in. Links show only the pages they cover.
- **Search** across the projects you can see: accent-insensitive, prefix
  matching, highlighted snippets.
- Images and files added in the editor are stored in cloud-drive under the
  page, and readable by whoever can read the page.

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

Then open the Worker's URL and create the first account. The Free plan is
enough; see [Workers Free plan](#workers-free-plan).

### Connect cloud-drive (files and history)

Without cloud-drive the wiki runs normally, but image/file uploads are off
(the editor offers images by URL instead) and the History panel says it isn't
connected. To turn them on:

1. Deploy [cloud-drive](https://github.com/waxz/cloud-drive) and create a user
   with a drive (e.g. `drive`) they can write to.
2. In `wrangler.toml`, uncomment the `[[services]]` block and set `service`
   to the cloud-drive Worker's name (`cf-drive` by default). A Worker can't
   reach another Worker on the same account through its `workers.dev` URL, so
   use the binding rather than `CLOUD_DRIVE_URL`. (A cloud-drive on another
   account or a custom domain works with `CLOUD_DRIVE_URL` instead.)
3. Set `CLOUD_DRIVE_DRIVE` if the drive isn't called `drive`, and the user's
   credentials:

   ```bash
   npx wrangler secret put CLOUD_DRIVE_USER
   ```

   ```bash
   npx wrangler secret put CLOUD_DRIVE_PASSWORD
   ```

4. Deploy again.

In cloud-drive the wiki uses `wiki/files/<page>/…` for uploads and
`wiki/history/<page>/<version>.ydoc` for snapshots; both are removed when the
page is deleted.

## Configuration

| Name | Kind | Meaning |
| --- | --- | --- |
| `PASSWORD_ITERATIONS` | var | PBKDF2-SHA256 iterations for new passwords. Default 50,000. |
| `CLOUD_DRIVE` | service binding, optional | The cloud-drive Worker. |
| `CLOUD_DRIVE_URL` | var, optional | cloud-drive base URL, when not using the binding. Empty = not connected. |
| `CLOUD_DRIVE_DRIVE` | var | cloud-drive drive for files and history (under `wiki/`). Default `drive`. |
| `CLOUD_DRIVE_USER`, `CLOUD_DRIVE_PASSWORD` | secret | cloud-drive user with write access to that drive. |

## Develop locally

```bash
npm install
```

```bash
npm run dev
```

opens the app on `http://localhost:8787` (Wrangler builds the client first
and rebuilds when `client/` changes). It runs without cloud-drive. To use a
local cloud-drive (its own `wrangler dev` on port 8792):

```bash
cp .dev.vars.example .dev.vars
```

and fill in the cloud-drive user. Open the app in two browsers to see live
editing.

### Tests

With `npm run dev` and a local cloud-drive running:

```bash
npm run test:api
```

checks accounts, invites, project privacy and roles, read-only live sync,
search scoping, files, comments, history in cloud-drive with live restore,
share links and delete cascades. It talks to cloud-drive directly as the
`ww` / `wwpass123` user by default (override with `DRIVE_USER`,
`DRIVE_PASS`, `DRIVE_NAME`, `DRIVE_URL`; the wiki's own server via
`WIKI_URL`).

```bash
npx playwright install chromium
```

```bash
npm run test:ui
```

walks through the same flows in a browser (two users and a signed-out
visitor). Set `CHROMIUM_PATH` to use an existing Chromium instead, and
`SHOTS` to a folder for screenshots.

## Workers Free plan

The design fits the Free plan for a small team:

- The Worker is about 80 KB gzipped (limit 3 MB); static files don't count.
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
  Admins add people by email and tell them to sign up.
- Comments sit in a side panel with an optional quote; they aren't anchored to
  a position in the text.
- On a published page, signed-out readers see the avatars of people currently
  editing it.

## Layout

| Path | What it is |
| --- | --- |
| `worker/index.ts` | Router and live-sync entry (sets the role for the page's room) |
| `worker/migrate.ts` | Applies bundled D1 migrations on first use |
| `worker/auth.ts` | Accounts, password hashing, sessions |
| `worker/access.ts` | Roles: workspace, project, share link → effective page role |
| `worker/workspaces.ts` | Workspaces, members, invites, projects, project members |
| `worker/pages.ts` | Pages, search, files, history, comments, share links |
| `worker/page-room.ts` | `PageRoom` Durable Object: sync, read-only roles, save, snapshots, restore |
| `worker/drive.ts` | cloud-drive WebDAV client |
| `migrations/` | D1 schema (also listed in `worker/migrate.ts`) |
| `client/src/` | React app: shell and sidebar, page view, comments, history, share, settings |
| `test/` | `api.mjs` (API and permissions), `ui.cjs` (browser walk-through) |
