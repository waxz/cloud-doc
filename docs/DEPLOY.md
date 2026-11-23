# Deploying Cloud Doc

Cloud Doc runs entirely on Cloudflare (Workers, Durable Objects, D1). One command deploys it: `wrangler deploy` builds the app and creates the D1 database and the Durable Object on the first deploy. The Worker applies its own database migrations on first use, so there is no migration step.

The [Workers Free plan](#workers-free-plan) is enough for a small team.

## Three ways to deploy

### 1. The button

Click **Deploy to Cloudflare** in the [README](../README.md). Cloudflare copies the repository to your GitHub account, creates the resources and deploys. Later pushes to your copy deploy automatically.

The button asks for the secrets listed in [`.dev.vars.example`](../.dev.vars.example). Give `STORAGE_KEY` any long random string (see [the storage key](#the-storage-key)).

### 2. From your machine

```bash
npm install
npm run deploy
```

`npm run deploy` is `wrangler deploy` plus one extra step: it creates the `STORAGE_KEY` secret if the Worker doesn't have one yet. Right after the very first deploy it is created for you; if that step can't run, add it yourself:

```bash
npx wrangler secret put STORAGE_KEY
```

### 3. From GitHub (Workers Builds)

In the Cloudflare dashboard, create a Worker from this repository and set the **deploy command** to `npm run deploy`. With the plain `npx wrangler deploy` the app works too, but the key isn't created: add it with `wrangler secret put STORAGE_KEY` before people save storages.

## First steps after deploying

1. Open the Worker's URL and **create the first account**: it becomes the instance admin. After that, sign-up is closed.
2. **Add a WebDAV storage** (your name → *Storage*), then **create a workspace** on it. A workspace needs a storage to keep its files and history.
3. **Invite people**: your name → *Admin* → *Registration links* (a link can add the person to a workspace and share a storage with them), or create accounts directly under *Users*.
4. Optional: under *Admin → Storage*, **share a storage** of yours with people and give each a limit, so they can create workspaces without a drive of their own.

## Storage

Any WebDAV server works: a [cloud-drive](https://github.com/waxz/cloud-drive) drive (`https://<host>/dav/<drive>`), Nextcloud (`https://<host>/remote.php/dav/files/<user>`), and others. Use an app password where the server offers one. Everything goes under a `cloud-doc/` folder in it:

```
cloud-doc/<workspace>/files/<file id>-<name>
cloud-doc/<workspace>/<page>/history/<version>.ydoc
```

- A page's history is removed when the page is deleted. Files stay until they are deleted, or the workspace is.
- A storage can't be removed while a workspace is bound to it or files or versions still use it.
- Files uploaded before workspace files existed stay where they are, under their page's folder.
- `wrangler.toml` sets the `global_fetch_strictly_public` compatibility flag, so a cloud-drive Worker on the same Cloudflare account is reached through its public URL like any other server.

## Configuration

| Name | Kind | Meaning |
| --- | --- | --- |
| `PASSWORD_ITERATIONS` | var | PBKDF2-SHA256 iterations for new passwords. Default 50,000 (about 5 ms of CPU, which fits the Free plan). On the paid plan use 100,000, the Workers maximum; each hash records its own count, so existing passwords keep working. |
| `STORAGE_KEY` | secret | Any long random string. Encrypts the WebDAV passwords users save (AES-256-GCM). See below. |

### The storage key

When `STORAGE_KEY` is set, WebDAV passwords are stored encrypted in D1. `npm run dev` and `npm run deploy` create it if it is missing (in `.dev.vars` locally, as a Worker secret when deploying), and they never replace one that exists.

- Set it **before** people add storages. Passwords saved earlier stay readable and are encrypted the next time they are saved.
- **Keep a copy.** Without the key, encrypted passwords can't be read and storages must be re-entered.
- Without any key the app still works; passwords are then stored as given.

## Workers Free plan

The design fits the Free plan for a small team:

- The Worker is about 90 KB gzipped (limit 3 MB); static files don't count.
- Sync messages are small, so requests stay inside the 10 ms CPU limit, and Durable Objects hibernate between messages.
- Password hashing is the one CPU-heavy step; the default iteration count is chosen for the 10 ms limit. Failed sign-ins are limited to 10 per email per 15 minutes.
- Page content is saved by the Durable Object (2 s after the last edit, at most every 10 s), so D1 sees one write per save, not per keystroke. A save that finds nothing changed writes nothing, and the search index is only rewritten when the title or text changed.
- The browser keeps its requests down: the sidebar's whole page tree is one request, and mentions, messages and to-dos are another; both are polled only while the tab is visible (every 90 s and 120 s). Comment lists are shared between the editor, the PDF viewer and the panel, live notices are batched to one refresh per 2 s, and the editor, admin and settings screens load only when first opened (the first script is about 106 KB gzipped).

The daily quotas set the ceiling: 100,000 Worker requests and 100,000 Durable Object requests per day. Incoming WebSocket messages count toward the Durable Object quota (20 messages per request), so heavy all-day editing by many people will outgrow the Free plan. *Admin → Usage* shows each user's requests and the share of the daily quota.

## Upgrading

Pull the new version and deploy again. Migrations are applied by the Worker on its first request. Nothing needs to be changed by hand.
