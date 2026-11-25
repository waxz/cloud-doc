<div align="center">

# Cloud Doc

**A collaborative wiki that runs on Cloudflare, with comments you can think with, and files that stay in drives you choose.**

Real-time editing · Notion-style highlights and discussion · Article layouts and columns · Workspaces and permissions · A limited playground for recruiting users · Zero servers to run

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/waxz/cloud-doc)

[Features](docs/FEATURES.md) · [Deploy](docs/DEPLOY.md) · [Security](docs/SECURITY.md) · [Develop](docs/DEVELOPMENT.md)

<br>

<img src="docs/screenshots/highlights.png" alt="Cloud Doc: a page with colour highlights and the Highlights panel showing a conversation" width="920">

</div>

<br>

## Why Cloud Doc

<table>
<tr>
<td width="50%" valign="top">

### 🪶 Nothing to host
Workers, Durable Objects and D1: no server, no database to patch, no Redis. One command deploys it, and the **Free plan** is enough for a small team.

</td>
<td width="50%" valign="top">

### 🗂️ Your files, your drives
Files and page history live in **WebDAV storage** that people own (cloud-drive, Nextcloud, …), or that the admin shares with a limit per person. No storage, no workspace; no lock-in.

</td>
</tr>
<tr>
<td valign="top">

### 💬 Comments that work
Select text, pick a colour, and you have a **highlight**. Add words and it becomes a thread. A separate **discussion** panel handles the page as a whole, with `@mentions`, `#tags`, tables and links.

</td>
<td valign="top">

### 🔒 Careful by default
Every rule is checked on the server. Uploaded files are sandboxed, storage passwords are encrypted at rest, the app ships a strict content-security policy, and nothing leaves your Cloudflare account.

</td>
</tr>
</table>

## Take a tour

### Write together

Live cursors, a block editor with tables, code, LaTeX, PDFs and media, favorites, an outline, export to Markdown or PDF, history you can restore. Highlights that carry comments show a short preview in the margin; click it to open the full thread.

<img src="docs/screenshots/editor.png" alt="The editor with the page tree, highlights and a teammate's avatar" width="920">

### Comment on anything

Click a comment beside the text to open its thread as a card right there, or open the whole panel, which takes the place of the margin comments in a right column of its own. The column is always reserved, so the page you are reading never shifts when a panel opens or closes; hide the page tree (`Ctrl/Cmd+\`) when you want the page wider. Click `#pricing` to see only the threads tagged with it; click a link to a highlight and the page scrolls to it.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/highlights.png" alt="Highlights panel"></td>
<td width="50%"><img src="docs/screenshots/discussion.png" alt="Discussion panel with a table, mentions and tags"></td>
</tr>
<tr>
<td align="center"><sub><b>Highlights</b>: bound to the page, four shapes, seven colours</sub></td>
<td align="center"><sub><b>Discussion</b>: one card per thread, tables, <code>@members</code>, <code>#tags</code></sub></td>
</tr>
</table>

### Files that belong to the team, not to one page

A file can be used by many pages and survives them. The workspace's **Files** window shows who uploaded what and where it is used. Deleting a page asks what to do with its files; shared ones are never lost by accident.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/files.png" alt="Workspace files window"></td>
<td width="50%"><img src="docs/screenshots/delete.png" alt="Delete page dialog listing its files"></td>
</tr>
</table>

### Lay a page out like an article

Switch a page to the **Article** layout (serif reading style, roomy lines) from the *Page layout* button. Then arrange it the way Anytype does: drag any block by its handle to the **left or right edge** of another block and the two sit **side by side**, up to four columns; drag the gap between columns to resize them. Pictures have **S / M / L / XL** size buttons. It works for every kind of block, nothing wraps around anything, everyone sees it live, and on a phone the columns simply stack. The reading column keeps the same width in every mode.

### Find it fast

Search across everything you can see. Each page shows the matches with their context; click one and you land on that exact spot. `Ctrl/Cmd+K` from anywhere.

<img src="docs/screenshots/search.png" alt="Search results with highlighted matches" width="920">

### Run it your way

The admin shares storage of their own with chosen people, each with a limit, and watches usage per user against the Free plan's daily quota.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/admin-storage.png" alt="Admin: shared storage with per-user limits"></td>
<td width="50%"><img src="docs/screenshots/admin-usage.png" alt="Admin: usage per user"></td>
</tr>
</table>

### Run a limited playground

Want people to try Cloud Doc without risking your storage or your Cloudflare allowance? In **Admin → Settings** switch on **open registration**, pick the *playground workspace* new accounts join, and set the limits:

- **Per workspace** (also in *Workspace settings*): a storage limit for files and page history, and a page limit. Limits are enforced for uploads, history, imports and page creation, and hold under parallel bursts.
- **One file** may not weigh more than the size you set, nor one page more than the largest page you allow (past it the page is locked for editors; admins can trim it); a workspace can have a **comment limit** too; automatic history keeps only the newest 30 versions per page, and a page's *History* panel shows what it takes and has buttons to clear it.
- **Per person**: requests per minute (default 600) and per hour; guests are limited by address; the admin is exempt.
- **Sign-up**: five accounts an hour per address, an optional cap on accounts, and new accounts are plain members who **cannot create workspaces**.
- **Read-only projects**: mark a *Demo* project read only and members can read but not edit it, while every other project stays editable by any member.

Guests who open a share link read a **snapshot** over HTTP: no live connection, no cost to the live room, and they never appear in anyone's list of who is on the page.

### Your data stays portable

A storage is a **server URL plus a folder**; *Test* checks the server and then the folder, and creates the folder if it is missing. From *Workspace settings* the owner can **move** all files and history to another storage, **back up** a whole workspace to one of their storages (readable JSON, page documents and your files), and **restore** it as a new workspace, even on another instance.

### On every screen

A phone-first layout (slide-out page tree, bottom-sheet panels), a hideable page tree and full-width mode on the desktop, and a dark theme that follows your system.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/phone.png" alt="Cloud Doc on a phone"></td>
<td width="50%"><img src="docs/screenshots/dark.png" alt="Dark theme"></td>
</tr>
</table>

## Features at a glance

| | |
| --- | --- |
| **Editing** | Real-time collaboration with live cursors · block editor · tables, code, LaTeX · inline PDFs that fit the page, with zoom, fit and page-jump tools (and highlights drawn on them), images, video, audio · undo/redo of your own changes · `Ctrl+S` versions · outline and word count |
| **Comments** | Highlights (4 shapes, 7 colours) in page order and a page-level discussion by thread · replies, resolve, search · rich text with links, tables and images · `@members` and `#tags` as filters · links that jump to the highlighted text |
| **Files** | Workspace-level files shared between pages · usage tracking · warnings before deleting something in use · delete-with-the-page choice |
| **Layout** | Article (serif) page style · drag blocks side by side into columns, drag to resize · picture sizes · one reading width everywhere · columns stack on phones |
| **Structure** | Workspaces → projects → nested pages · collapsible projects · drag and drop · emoji icons · favorites · roles per project (viewer, commenter, editor, admin) · **read-only projects** |
| **Sharing** | Links for view, comment or edit, with subpages and expiry · view links publish a page without sign-in |
| **History** | Automatic and named versions, preview and restore, kept in your storage |
| **Search** | Accent-insensitive prefix search with in-context matches that jump to the spot · or an instant filter by page title |
| **Scale** | Only the first 100 KB of a page is indexed for search · pages are saved by appending small updates, merged now and then · a big sidebar loads one level at a time · limits on page size, comments, pages and files |
| **Storage** | Per-workspace WebDAV storage (server URL + folder, created for you) · shared storages with per-user limits · **per-workspace storage and page limits** · move, back up and restore a workspace · encrypted credentials |
| **Admin** | Accounts and registration links that can add people to a workspace with a shared storage · shared storages · per-user usage, request rate and errors · **open registration switch for a playground** with limits, request limits and an account cap · contact email on the sign-in page |
| **Sign-in** | Admin contact email for forgotten passwords · **recovery mode** (a `RECOVERY_SECRET` you set in the Cloudflare dashboard) for a forgotten admin password · guests read a snapshot with no live connection |
| **Everywhere** | Responsive layout for phones and tablets · dark theme · export to Markdown, HTML or PDF |

The full tour is in **[docs/FEATURES.md](docs/FEATURES.md)**.

## Cloud Doc and Docmost

[Docmost](https://github.com/docmost/docmost) (AGPL-3.0; Node, Postgres and Redis) is the closest open-source wiki, and a much more mature one. Cloud Doc takes a different route: no servers to run, files in drives that people own, and the Cloudflare Free plan as the target.

✅ yes · ➖ not yet (Cloud Doc) / not listed in its documentation (Docmost)

| | Cloud Doc | Docmost |
| --- | :---: | :---: |
| **Platform** | | |
| Runs without a server of your own | ✅ Cloudflare | ➖ Node + Postgres + Redis |
| Fits a free hosting tier | ✅ Workers Free | ➖ |
| Self-hostable, source on GitHub | ✅ | ✅ AGPL-3.0 core |
| **Writing** | | |
| Real-time collaboration, live cursors | ✅ | ✅ |
| Page history and restore | ✅ | ✅ |
| Tables, code, LaTeX, PDFs, media | ✅ | ✅ |
| Diagrams (draw.io, Excalidraw, Mermaid) | ➖ | ✅ |
| Embeds (Airtable, Loom, Miro, …) | ➖ | ✅ |
| Columns: drag a block beside another, resize | ✅ | ✅ |
| Callouts, tabs, table-of-contents block | ➖ | ✅ |
| Outline panel, favorites, Markdown / PDF export | ✅ | ✅ |
| **Comments** | | |
| Comments and replies, resolve | ✅ | ✅ |
| Coloured highlights in four shapes, with a short preview in the margin | ✅ | ➖ |
| `@member` / `#tag` as clickable filters | ✅ | ➖ |
| **Files and storage** | | |
| File attachments | ✅ | ✅ |
| Workspace file library (shared between pages, usage shown) | ✅ | ➖ |
| Files live in drives people own (WebDAV) | ✅ | ➖ server storage |
| Admin shares storage with per-person limits | ✅ | ➖ |
| **People and access** | | |
| Workspaces, projects/spaces, roles | ✅ | ✅ |
| Share and publish links | ✅ | ✅ |
| Groups | ➖ | ✅ |
| SSO / enterprise sign-in | ➖ | ✅ (some in the Enterprise edition) |
| Admin usage panel (storage, requests, rate per user) | ✅ | ➖ |
| Read-only projects | ✅ | ➖ |
| Limited playground: open sign-up, workspace quotas, request limits | ✅ | ➖ |
| Move or back up a workspace between storages | ✅ | ➖ |
| **Polish** | | |
| Translations | ➖ English | ✅ 10+ |
| Page covers, labels, trash, duplicate page, templates | ➖ | ✅ |
| Email notifications and invites | ➖ no email sending | ✅ |

> The Docmost column follows its public README and documentation at the time of writing, and "not listed" means just that: please check [docmost.com](https://docmost.com) for the current feature set. Cloud Doc's gaps are on the roadmap below.

## Get started

1. **Deploy**: click the button at the top, or run `npm run deploy` from a clone ([deploy guide](docs/DEPLOY.md)).
2. **Create the first account**: it becomes the admin.
3. **Add a WebDAV storage** and create a workspace on it, then invite people.

```bash
git clone https://github.com/waxz/cloud-doc && cd cloud-doc
npm install
npm run deploy
```

Optional, but worth doing once: set a `RECOVERY_SECRET` (16+ characters) in the Cloudflare dashboard so a forgotten admin password can be recovered from the sign-in page ([how](docs/DEPLOY.md#recovery-mode-a-forgotten-admin-password)).

Run it locally with `npm run dev` ([developer guide](docs/DEVELOPMENT.md)).

## How it works

```
 browser ──HTTP──▶ Worker ── checks access ──▶ D1   (accounts, permissions, comments, search)
    │                 └──────────────────────▶ the workspace's WebDAV storage (files, history)
    │                 (every /api request first passes a per-person rate limit)
    ├─guests (no account)──▶ one HTTP snapshot of the page: no live connection
    └─WebSocket─▶ Worker ── role ──▶ PageRoom Durable Object (one per page)
                                       ├─ Yjs sync + presence (read-only for viewers)
                                       ├─ saves the page to its own SQLite storage
                                       ├─ one editor or readers only: cursors off, edits batched; two editors: live
                                       ├─ title + text → D1 search, file usage (at most once a minute)
                                       └─ snapshots → the workspace's storage
```

| Piece | Built with |
| --- | --- |
| Editor and UI | [BlockNote](https://www.blocknotejs.org/) with Yjs collaboration · [Mantine](https://mantine.dev/) · [Tabler icons](https://tabler.io/icons) |
| Live sync | One Durable Object per page ([`y-partyserver`](https://github.com/cloudflare/partykit/tree/main/packages/y-partyserver)), hibernating WebSockets |
| Page content | The page's Yjs document, in its Durable Object's SQLite storage |
| Accounts, workspaces, permissions, comments, share links, search | D1 (search uses FTS5) |
| Files and page history | The workspace's WebDAV storage |

## Roadmap

Cloud Doc is young. What's done, and what comes next, roughly in order.

**Shipped**
- [x] Real-time editing, workspaces, projects, roles, share and publish links
- [x] Highlights and discussion with rich comments, tags and mentions
- [x] Workspace files, usage tracking and safe deleting
- [x] Storage per workspace, shared storages with per-user limits, encrypted credentials
- [x] Search with in-context matches, outline, favorites, export, undo/redo, dark theme, phone layout
- [x] Admin usage panel, security headers, sandboxed uploads
- [x] Article layout, columns by drag and drop, picture sizes, read-only projects
- [x] **Limited playground**: open registration switch, workspace storage and page limits, file cap, request limits, history usage and clearing
- [x] Move, back up and restore a workspace between storages; storage as server URL + folder
- [x] Admin contact email on the sign-in page and a recovery mode for the admin password
- [x] Fewer requests for the Free plan: live/quiet collaboration, guests on snapshots, quiet housekeeping

**Next**
- [ ] **Trash**: restore deleted pages (deleting is permanent today)
- [ ] **Diagrams**: Mermaid and draw.io blocks
- [ ] **Callout** and **table-of-contents** blocks
- [ ] **Page duplication**, **labels**, recent pages
- [ ] **Groups**: give access to many people at once

**Later**
- [ ] Email: invites, automatic password reset and notifications (through Cloudflare Email or an SMTP relay)
- [ ] Single sign-on (OIDC) and two-factor sign-in
- [ ] Page templates and covers
- [ ] Translations (the interface is English only today)
- [ ] API tokens and webhooks
- [ ] Comment on images and diagrams

Have an idea or a missing piece? Open an issue.

## Security

Access is checked on the server for every request; live sync gets its role from the Worker, never from the client. Uploaded files are served sandboxed, comments never render raw HTML, the app ships a strict content-security policy, and saved storage passwords are encrypted with a key only your Worker holds. Requests are limited per person, rooms refuse floods, and guests never open a live connection. What the app leaves to you (no email verification or two-factor sign-in) is spelled out in **[docs/SECURITY.md](docs/SECURITY.md)**.

## Documentation

| | |
| --- | --- |
| [docs/FEATURES.md](docs/FEATURES.md) | Everything it does, in detail |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Deploying, configuration, the storage key, the Free plan |
| [docs/SECURITY.md](docs/SECURITY.md) | What is protected and what is left to you |
| [docs/AUDIT.md](docs/AUDIT.md) | Performance and safety audit, and what was fixed for the Free plan |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Running locally, tests, project layout, regenerating screenshots |
