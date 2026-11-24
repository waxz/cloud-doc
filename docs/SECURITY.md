# Security

What Cloud Doc does, and what it leaves to you.

## What the app does

- **Access is checked on the server** for every request (roles per project, workspace roles, share links). The sidebar tree, search, comments, files and usage figures only ever contain what the caller may see. Live sync takes the role from the Worker, never from the client, and refuses connections that come from another site.
- **Sessions** are random tokens in an `HttpOnly; Secure; SameSite=Lax` cookie, stored hashed. Passwords are PBKDF2-SHA256 with a per-password salt, and failed sign-ins are limited. The API accepts only `application/json` bodies, which together with `SameSite` shuts out cross-site form posts.
- **Uploaded files are untrusted.** They are served from the app's own origin, so HTML, SVG and XML download instead of displaying, every file carries a `sandbox` content-security policy and `nosniff`, and pictures, video and PDFs show only inside pages.
- **Browser hardening** (`client/public/_headers`): a content-security policy (scripts only from the app itself), `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` and a same-origin opener policy. API answers are `Cache-Control: no-store`.
- **Live rooms are bounded**: at most 50 connections per page, oversized messages are refused, cursor floods are dropped and sync floods close the socket. Moving highlights needs editor access.
- **Comments** are rendered by a small Markdown renderer that builds elements (no raw HTML). Links are limited to http, https and mailto, and LaTeX goes through KaTeX without `trust`.
- **WebDAV passwords** are encrypted at rest when `STORAGE_KEY` is set (see [Deploying](DEPLOY.md#the-storage-key)) and are never sent back to the browser. Use an app password where the storage offers one. Shared storages keep their address and login away from the users they are shared with.
- **Who can read a file:** its uploader, workspace owners and admins, and anyone who can view a page that uses it. Pages can only use files of their own workspace.
- **Dependencies:** `npm audit --omit=dev` reports no known vulnerabilities as of this release.

## What it leaves to you

- There is **no email verification or password reset** (the app sends no email) and **no two-factor sign-in**. Admins hand out registration links and reset passwords in the admin panel.
- There is **no rate limit on the API** beyond failed sign-ins. If the instance is public, use Cloudflare's rate-limiting rules or WAF in front of it.
- Keep a copy of `STORAGE_KEY`: without it, saved storage passwords can't be read.

## Limits worth knowing

- Lowering someone's role takes effect on new connections; a page they already have open keeps its live connection until they reload or reconnect.
- Pictures in comments (Markdown `![](https://…)`) are fetched by each reader's browser from that address, which tells that site the reader's IP address. Only https pictures and this site's own files are shown.
- Guests (not signed in) read a page through a one-off snapshot over HTTP; they open no live connection, so they are never listed as present and see no avatars.
- A highlight finds its text again by position and by the words it quotes. If the quoted words are edited away entirely, the highlight can no longer be drawn (its comment stays in the panel).
- Request figures in *Admin → Usage* are estimates: counts are kept in memory and written about once a minute.

## Reporting a problem

Please open a private security advisory on the repository rather than a public issue.
