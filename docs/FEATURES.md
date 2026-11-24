# Features in detail

A tour of what Cloud Doc does. For the short version, see the [README](../README.md).

- [Writing](#writing)
- [Comments](#comments)
- [Files](#files)
- [Finding things](#finding-things)
- [Sharing and access](#sharing-and-access)
- [Storage](#storage)
- [Administration](#administration)

## Writing

- **Real-time editing** with live cursors and avatars. The title and emoji sync like the body. Viewers and commenters get the page live but read-only.
- **A block editor** ([BlockNote](https://www.blocknotejs.org/)): headings, lists, tables, code, quotes, LaTeX, PDFs, images, video and audio, from the `/` menu.
- **Page tree:** fold and unfold (remembered per browser), emoji icons, drag and drop to reorder or nest (drop on the top or bottom edge of a page to place it before or after, on the middle to put it inside), and a ⋯ menu with *Add subpage*, *Upload file…*, *Move to…* (handy on phones), *Copy link* and *Delete*.
- **Page history:** a snapshot is saved at most every 10 minutes while the page changes, plus *Save a version now*. A saved version goes to the workspace's storage. You can preview any version and restore it; the restore reaches everyone on the page live, and the replaced content is kept as a *before restore* version.
- **Undo and save:** `Ctrl/Cmd+Z` undoes and `Ctrl/Cmd+Shift+Z` (or `Y`) redoes your own changes in the body and the title, never other people's. `Ctrl/Cmd+S` flushes pending work and saves a named version.
- **Outline and word count:** the *Outline* panel lists a page's headings (click to jump) and counts words.
- **Favorites:** star a page; starred pages sit at the top of the sidebar (kept in the browser).
- **Export:** download a page as Markdown or HTML, or print it / save it as a PDF (the print view hides the app chrome).
- **Room to work:** the sidebar can be hidden (the button beside the workspace name, or `Ctrl/Cmd+\`), and the page can switch from a reading column to **full width** (the arrows in the page header). Both are remembered per browser.
- **Phones and tablets:** the page tree is a slide-out menu, panels open as bottom sheets, and page actions sit in a ⋯ menu.

## Comments

The screen is three columns: the explorer on the left (hide it with the button beside the workspace name), the page in the middle, and a right column that shows either the margin comments or, when you open one, the Highlights or Discussion panel (or Outline, Files, History), which covers them. The page does not move when the panel opens. Below 1100 px there is no right column: the panel floats over the page and the margin shows numbered bubbles.

- **Highlights** holds the threads attached to text, in the order of the page (PDF pages included, grouped by page). Select text and pick a colour for an instant highlight (four shapes: highlight, underline, strikethrough, box; seven colours, changeable later from the comment's card), or press *Comment* to add words. Highlights that have written comments show a short preview in the right column (the number of comments in a bubble, then who said what), level with their text. Clicking a preview, a highlight or a PDF mark opens that thread as a card beside it, where you can reply, resolve, edit and delete; its *Open all comments* button opens the panel on that thread (Escape or a click elsewhere closes the card). Clicking a card in the panel jumps to its text.
- **Discussion** holds conversations about the page as a whole, one card per thread, the most recently active first.
- Both have replies, resolve/reopen (resolved threads fold into a *Resolved* list at the bottom), edit and delete, and one search box; click an `@member` or `#tag` to see only the threads with it. Typing `@` lists the people you can mention.
- **Rich comments:** bold, italic, code, lists, tables, images, quotes and LaTeX, with links (also plain web addresses and links to other pages of the wiki) that are clickable.
- **`@member` and `#keyword`** in a comment are links: click one to show only the threads that mention that person or use that tag; click it again, or the chip, to clear.
- **Links to comments:** a card's link icon copies one. Opening it shows the right panel, focuses the card and scrolls the page to the highlighted text.
- The comment box is compact, with small type to suit the narrow panel, and `Ctrl/Cmd+Enter` posts. Open pages refresh when someone comments.

## Files

- **Images, video, audio, PDFs and other files** go into pages: drop or paste them into the editor, use `/image`, `/video`, `/pdf` or `/file`, upload from the tree's ⋯ menu, or from the page's *Files* panel. PDFs show inline at the page's width with every page one after another (no scrolling inside the viewer), and a toolbar under the page header zooms in and out, fits to the width or to a whole page, and jumps to a page (previous, next, or type a number), and you can highlight and comment on PDF text with the same four shapes and seven colours; those highlights get margin previews too. Files are streamed from the workspace's storage to anyone who can read a page that uses them (with range requests, so video seeks).
- **Files belong to the workspace, not to one page.** The same image or PDF can be used by many pages and survives them. The sidebar's *Workspace files* window lists every file with who uploaded it, its size and the pages that use it (or *Unused*), and lets you search, filter, copy a link, add a file to the open page, or delete it. Deleting a file that pages still use asks first and names those pages. Which pages use a file is recorded whenever a page is saved.
- **Deleting a page asks about its files.** The dialog lists them, marks the ones other pages also use (always kept), and offers to delete the ones only this page used; otherwise they stay in the workspace, unused. Its subpages and saved versions are deleted with it. Deleting a workspace removes its files and history from its storages.

## Finding things

- **Search** across the projects you can see: accent-insensitive, prefix matching. Each page lists up to four matches with the text around them; clicking one opens the page, scrolls to that spot and marks it. The results stay up while you visit them, until you press the exit button (or Esc).
- `Ctrl/Cmd+K` jumps to search from anywhere.

## Sharing and access

- **Workspaces** with owners, admins and members. Admins add people by email; someone without an account joins when they sign up with that email.
- **Projects** inside a workspace, each with a page tree. A project either gives everyone in the workspace a default role or is private to the people added to it.
- **Roles per project:** *viewer*, *commenter*, *editor*, *admin*. Workspace owners and admins administer every project.
- **Share and publish:** links that grant *can view*, *can comment* or *can edit* on a page, optionally with its subpages and an expiry. View links work signed out, which publishes the page. Comment and edit links ask people to sign in. Links show only the pages they cover.

| | Viewer | Commenter | Editor | Admin |
| --- | --- | --- | --- | --- |
| Read pages, see comments | ✓ | ✓ | ✓ | ✓ |
| Comment, reply, resolve | | ✓ | ✓ | ✓ |
| Edit, upload, create/move/delete pages | | | ✓ | ✓ |
| Save and restore versions | | | ✓ | ✓ |
| Create view/comment links | | | ✓ | ✓ |
| Create edit links, manage project, delete others' comments | | | | ✓ |

Every rule is checked on the server. Through a share link, signed-out visitors only ever read, and an edit link lets people change page content but not create, move or delete pages. A view-only link shows the page but not its comments; no link shows history (it can contain content that was removed on purpose).

## Storage

- **Storage is owned by people, and a workspace needs one.** Everything a workspace keeps (its files and its page history) lives in a WebDAV folder, such as a [cloud-drive](https://github.com/waxz/cloud-drive) drive or Nextcloud. When you create a workspace you pick the storage for it: one of your own (you can add it right in the create dialog), or a shared one the admin allocated to you. No storage, no new workspace.
- **Members use the workspace's storage.** People you add need none of their own, and can still create workspaces of their own once they have one. A workspace's owners and admins can add more storages to it or swap them, but it always keeps at least one.
- **Shared storages (admin).** *Admin → Storage*: the admin adds WebDAV storages of their own and shares each with chosen users (or everyone), each with a limit in MB. What a user's workspaces keep on a shared storage counts against that user's limit and is refused when full. The user sees only the storage's name, limit and use, never its address or login. The admin does not set up anyone else's storage and cannot read other people's storages.

## Administration

- **Accounts.** The first account created on a new install is the instance admin. After that, sign-up is closed: the admin creates accounts directly, or sends registration links (optionally tied to an email, with a role and an expiry; each works once). A link can also put the new account into a workspace and give it a shared storage with a limit, so the person can start working right after signing up. Admins set each user's role and whether they may create workspaces, and can disable or delete accounts.
- **Usage.** *Admin → Usage* shows, per user, what they store, their use of any shared storage against their limit, requests over 24 h / 7 d / 30 d, the request rate, errors and traffic, plus an hourly chart and the share of the Free plan's daily quota.


## Free-plan economy

- **Live vs quiet collaboration.** With two or more people able to edit a page, cursors and edits are live. With one writer, or only readers, cursors are not sent and edits are batched (about a second), which cuts the messages Cloudflare bills.
- **Event-driven comments.** A new comment, reply, resolve or delete tells everyone on the page, and highlights and the Discussion panel reload together from a single request.
- **Quiet housekeeping.** Search text and file references are refreshed at most once a minute while a page is open; the sidebar polls slowly, and not at all for a workspace of one.

## Move, back up, restore a workspace

In *Workspace settings* (owner): move all files and history to another storage, save a full backup to one of your storages, or restore a backup as a new workspace (also from another instance, by adding its storage). See the [audit](AUDIT.md) for the format.

## Storage address

A storage is a **server URL** (the WebDAV address of your account) plus a **folder** under it. *Test* checks the server and your login first, then the folder, and says which one is wrong; a missing folder can be created from the test result, and saving creates it too. A storage saved as a single URL before keeps working unchanged.

## Phones

Fields are 16px on touch screens so Safari doesn't zoom in when they get focus, and the formatting toolbar stays on screen and scrolls sideways instead of stretching the page.

## Page layout, like an article

- **Article** (the *Page layout* button above the page, for editors) sets the page in a serif reading layout with roomy lines and clear links. It is saved with the page, so everyone sees it.
- **Columns**, as in Anytype: drag any block (by its handle) to the **left or right edge** of another block and the two sit side by side; do it again for up to four columns. Drag the **gap** between columns to resize them (snapping to twelfths), and drag a block back between rows to stack it again. The selection toolbar's *Columns* button does the same without dragging (beside the block above or below, equal widths, full width again). It works for every kind of block, nothing wraps around anything, and everyone sees it live. A row is stored in the page by block id, so pages that never use columns are untouched. On a phone the Columns button (now called *Layout*, with Move up / Move down) still works, and a row's blocks stack with a bar on the left marking the group; the columns appear side by side on wider screens.
- **Shared read-only pages** show no editing toolbar and keep no empty column for comments. The reading column is the same width in every mode (editing, reading, shared, panel open or not, sidebar shown or hidden); *Full width* is the one setting that changes it.
- **The outline floats.** It opens as a card over the top right of the page (Esc or its close button dismisses it), so opening it never moves or resizes the text, in edit or guest mode. The other panels (discussion, highlights, history, files) still open in the column beside the page; on a phone all panels are bottom sheets.
- **Guests read a snapshot.** Someone opening a share link without signing in gets the page over HTTP (refreshed when they come back to the tab) and opens no live connection: no requests to the live room, and they never appear in anyone's list of who is on the page. The avatars at the top show up to three people, then "+N".
- **Picture size**: with a picture or video selected, **S / M / L / XL** set its width (240 px, 400 px, 640 px, the full width). Dragging its edges still gives any size in between.

## The explorer

- *Workspace settings* and *Files* are the first buttons in the sidebar.
- Each project folds shut from its header (remembered per browser, with a count of its pages).
- Search has two modes: **Text** (words inside pages, on the server) and **Titles** (an instant filter of page titles, which asks the server for nothing).
- The light/dark switch is in the page header; the account menu is just Settings (with the Storage tab), Admin and Sign out.
