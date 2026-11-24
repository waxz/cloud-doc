# Performance and safety audit

Scope: the Worker, the page room (Durable Object), D1 usage and the browser's request behaviour, measured against Cloudflare's **free plan** (100,000 Worker requests/day, 100,000 D1 rows written/day, 100,000 Durable Object rows written/day, 10 ms CPU and 50 outgoing requests per invocation). Status says whether this release fixed it.

## Request and write cost

| # | Finding | Status |
|---|---|---|
| 1 | Every cursor move and keystroke was a message to the room, with one or more people on a page, even when nobody else could see them. | **Fixed.** The room counts writers and tells clients "live" (two or more) or "quiet". Quiet: no cursor traffic, edits batched about 1 s; readers never send cursors. |
| 2 | Each autosave (every 2–10 s while typing) rewrote the title, the FTS5 search rows and file references in D1: many rows written per save. | **Fixed.** Body changes are folded to at most once a minute (by alarm), written at once when the last person leaves; a rename still lands immediately. |
| 3 | Moving highlights sent one `PATCH` per highlight, from **every** connected browser (viewers too), and each one broadcast "comments changed", so every peer reloaded the comment list: a request storm after one edit. | **Fixed.** One batched, quiet `PATCH /api/pages/:id/anchors` (editors only, unchanged rows not written, no live notice, 5 s debounce, flushed when leaving). |
| 4 | Remote comment notices refreshed the side panel but not the page's own highlights. | **Fixed.** A notice reloads highlights, panels and open threads from one shared request; the tab that made the change skips it (`x-tab-id`). |
| 5 | The sidebar polled the page tree every 90 s per visible tab, even in a workspace of one person. | **Fixed.** 2 min with other members, 15 min alone (still refreshes when you return to the tab). |
| 6 | Usage counters are per isolate and flushed about once a minute. | Kept: already economical; figures are estimates. |
| 7 | Document state is rewritten whole (delete + insert chunks) on each change. | Open, low: about 3–4 rows per save; incremental update logs would cut it for very large pages. |

## Safety

| # | Finding | Status |
|---|---|---|
| 1 | A viewer or share-link visitor could open many sockets or flood cursor/sync messages (each billed) with no limit. | **Fixed.** At most 50 connections per page, 16 MB per message, cursor traffic above 20/s per socket is dropped, and a socket sending over 1,500 sync messages per 10 s is closed (4429). |
| 2 | Any commenter could rewrite the position and quoted text of other people's highlights through `PATCH /api/comments/:id`. | **Fixed.** Moving highlights needs editor access. |
| 3 | `btoa(String.fromCharCode(...stateVector))` in the room overflows the call stack for a large state vector. | **Fixed.** Chunked and hashed. |
| 4 | A page's room had no cap on saved state. | **Fixed.** Saves above 40 MB are refused and logged (import too). |
| 5 | Awareness (name, colour) is accepted from any connection, so a client can show a made-up identity next to its cursor. | Open, low: cosmetic; real identity is the server-set role and name on the connection. |
| 6 | There is still no general API rate limit (only failed sign-ins). | Open: use Cloudflare rate-limiting rules (see [Security](SECURITY.md)). |
| 7 | Storage URLs are user supplied and fetched by the Worker. | Accepted: `global_fetch_strictly_public` stops it reaching private addresses; only http(s) is allowed and credentials are not echoed back. |
| 8 | Backup/import read untrusted JSON from a storage. | **Handled.** Size caps, field validation, enums re-checked by the database, every inserted row must belong to the new workspace, and backups go only to storages the owner owns (so they cannot bypass a shared allocation). |

## Workspace migration and backup

- *Move* copies each file and history snapshot to the chosen storage, repoints its row, then optionally deletes the old copy, so any interruption leaves every item readable from one place.
- *Back up* writes a folder `cloud-doc-backups/<name>-<time>/` (readable files: `manifest.json`, `meta/*.json` chains, `pages/*.ydoc`, `files/*`, `history/*.ydoc`) in a storage you own; the manifest is written last.
- *Restore* creates a **new** workspace with derived ids (so it can sit beside the original), re-points file links in documents, comments and PDF blocks to the new file ids, and can add the people listed (existing accounts, otherwise invites).
- All three run as many short requests (a few items each) to stay inside the free plan's per-request limits; a stopped run can be started again.
