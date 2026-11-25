# Developing Cloud Doc

## Run it locally

```bash
npm install
npm run dev
```

opens the app on `http://localhost:8787`. Wrangler builds the client first and rebuilds when `client/` changes. `npm run dev` also creates a random `STORAGE_KEY` in `.dev.vars` (kept out of git) if there isn't one.

For storage, run the small in-memory WebDAV server the tests use:

```bash
node test/webdav-server.mjs
```

and add `http://127.0.0.1:8793` (user `dav`, password `davpass`) in *Settings → Storage*, or point it at a local cloud-drive. Open the app in two browsers to see live editing.

Other scripts: `npm run typecheck`, `npm run build`, and `npm run check:browsers` (after a build): it fails when the built app uses syntax older iPhones can't read, such as regular-expression lookbehind (Safari before 16.4), because Safari rejects a whole file for one unreadable pattern and the page then fails to render on an old phone while working on a new one. The build targets Safari 15 syntax, and the browser test suite runs this check first. The suite also runs its phone session **without the newest browser features** (`Iterator`, `Promise.withResolvers`, `Promise.try`, Set methods, …, none of which iOS 16 has), PDF viewer included, so a dependency on one of them fails the tests. The PDF viewer is loaded only when a PDF is shown, from PDF.js's *legacy* build, with a one-function polyfill (`client/src/pdf-polyfills.ts`) in the page and in the worker.

## Tests

Both suites need a running app with an **empty** database (the first account they create must become the admin), and start their own WebDAV server. For example:

```bash
npx wrangler dev --persist-to /tmp/cloud-doc-test
```

Add `--var STORAGE_KEY:some-long-secret` to run them with encrypted storage passwords. Run each suite against its own fresh database.

```bash
npm run test:api
```

Accounts, admin and registration links, storages and shared storages with allocations, workspaces needing a storage, invites, project privacy and roles, read-only live sync, search scoping, workspace files (shared between pages, kept or deleted with a page, warned when in use), uploads (range reads, limits, deletes), comments, history in the saver's storage with live restore, share links, file sandboxing, response headers and delete cascades into storage. `WIKI_URL` points it at the app.

```bash
npm run test:ui
```

The same flows in a browser, on a desktop window and an iPhone-sized one: setup, adding a storage, emoji, uploading an image and a PDF, registration links, co-editing, comments (highlights, replies, discussion, tags and links), history, the Files panel and the workspace Files window, drag and drop in the tree, and the phone's menu and bottom sheets. Set `CHROMIUM_PATH` to use an existing Chromium (otherwise run `npx playwright install chromium` first), and `SHOTS` to a folder for screenshots (default `.test-output`).

## Screenshots

The pictures in the README come from `scripts/screenshots.mjs`. It builds a small demo team (accounts, a workspace, pages, files, highlights and comments) in an empty database and drives a browser:

```bash
npx wrangler dev --port 8799 --persist-to /tmp/cloud-doc-shots
WIKI_URL=http://127.0.0.1:8799 node scripts/screenshots.mjs
```

The results go to `docs/screenshots/`.

## Layout

| Path | What it is |
| --- | --- |
| `worker/index.ts` | Router and live-sync entry (sets the role for the page's room), response headers |
| `worker/migrate.ts` | Applies bundled D1 migrations on first use |
| `worker/auth.ts` | Accounts, first-account setup, registration links, password hashing, sessions |
| `worker/settings.ts` | Profile, storages, admin (users, shared storages and allocations, registration links) |
| `worker/access.ts` | Roles: workspace, project, share link → effective page role |
| `worker/workspaces.ts` | Workspaces, members, invites, projects, project members, workspace storages |
| `worker/pages.ts` | Pages, search, history, comments, share links |
| `worker/files.ts` | Workspace files: upload, download, listing, which pages use a file, deleting |
| `worker/storage.ts` | WebDAV client, picking a workspace's storage, shared-storage allocations |
| `worker/secret.ts` | Optional encryption of saved storage passwords |
| `worker/usage.ts` | Per-user request counting for *Admin → Usage* |
| `worker/page-room.ts` | `PageRoom` Durable Object: sync, read-only roles, save, snapshots, restore |
| `scripts/` | `ensure-storage-key.mjs` (creates `STORAGE_KEY`), `screenshots.mjs` |
| `migrations/` | D1 schema (also listed in `worker/migrate.ts`) |
| `client/src/` | React app: shell, page tree, editor (PDF block, toolbar), page view, comments, files, history, share, settings, admin |
| `client/public/_headers` | Security headers for the static app |
| `test/` | `api.mjs` (API and permissions), `ui.cjs` (browser walk-through), `webdav-server.mjs` (in-memory WebDAV for tests and local use) |
| `.npmrc` | `legacy-peer-deps`: y-partyserver still declares the old workers-types 4 as a peer while Wrangler wants 5 (types only) |
