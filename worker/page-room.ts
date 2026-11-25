import type { Connection, ConnectionContext } from 'partyserver';
import { YServer } from 'y-partyserver';
import * as Y from 'yjs';
import { type Role, atLeast } from './access.js';
import type { Env } from './env.js';
import { useStorageKey } from './secret.js';
import { HttpError, json, newId } from './http.js';
import { WebDav, checkQuota, checkWorkspaceQuota, historyKey, maxPageBytes, resolveStorage, storageById, workspaceOfPage, pastStorageLimit } from './storage.js';
import { fileIdsIn, syncFileRefs } from './files.js';
import { deriveId, fileIdsInText, rewriteDocument } from './rewrite.js';

/** BlockNote keeps the document in this XML fragment; the title lives in `meta`. */
export const FRAGMENT = 'document-store';
/** Headers the Worker sets (after stripping client copies) before a connection reaches the room. */
export const ROLE_HEADER = 'x-wiki-role';
export const NAME_HEADER = 'x-wiki-name';

const CHUNK = 1024 * 1024; // SQLite rows are capped at 2 MB, so state is stored in chunks.
const AUTO_SNAPSHOT_EVERY = 10 * 60 * 1000;
/** How many automatic history versions a page keeps. */
const AUTO_KEEP = 30;
/**
 * Search text, title and file references go to D1 (FTS5 rows are many rows written each), so while a
 * page is open they are refreshed at most this often, and at once when the last person leaves.
 * A rename is indexed immediately; only body edits wait.
 */
const INDEX_EVERY = 60 * 1000;
/** A page's room refuses more connections than this (each one is a hibernating socket plus awareness state). */
const MAX_CONNECTIONS = 50;
/** One socket may send this many Yjs sync messages per window before it is closed as abusive. */
const SYNC_WINDOW_MS = 10_000;
const SYNC_WINDOW_MAX = 1500;
/** Awareness (cursors, presence) is dropped, not queued, above this sustained rate per socket. */
const AWARENESS_PER_SEC = 20;
const AWARENESS_BURST = 40;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** Between two saves one socket may send this many bytes of edits: a script can't grow a page faster than the size check runs. */
const SYNC_WINDOW_BYTES = 16 * 1024 * 1024;
/** The room keeps at most this much document state; a page this big is not a wiki page. */
const MAX_STATE_BYTES = 40 * 1024 * 1024;
/**
 * Only the first part of a page's text goes into the search index, which keeps each page's share of the database bounded
 * (the index holds the text again, and one database row may not pass 2 MB). Search never read past 200 KB of a page anyway.
 */
const INDEX_TEXT_MAX = 100_000;
/** The updates since the base copy are merged into it after this many rows or bytes, or on leaving after this many rows. */
const COMPACT_ROWS = 400;
const COMPACT_BYTES = 1024 * 1024;
const COMPACT_ON_LEAVE = 20;

interface ConnState {
  role: Role;
  name: string;
}

interface Meter {
  tokens: number;
  at: number;
  syncStart: number;
  syncCount: number;
  syncBytes: number;
}

/**
 * One Durable Object per page. y-partyserver handles the Yjs sync protocol
 * and awareness over hibernatable WebSockets. This class loads and saves the
 * document, makes viewer/commenter connections read-only, keeps the page's
 * title and search text in D1, and writes history snapshots to the WebDAV
 * storage of the user who saves them.
 */
export class PageRoom extends YServer<Env> {
  static options = { hibernate: true };
  static callbackOptions = { debounceWait: 2000, debounceMaxWait: 10_000, timeout: 10_000 };

  private exec(query: string, ...args: unknown[]) {
    return this.ctx.storage.sql.exec(query, ...args);
  }

  private ensureTables(): void {
    this.exec('CREATE TABLE IF NOT EXISTS doc_chunks (i INTEGER PRIMARY KEY, data BLOB NOT NULL)');
    // what changed since the doc_chunks copy was written: one small row per save (see persist)
    this.exec('CREATE TABLE IF NOT EXISTS doc_updates (i INTEGER PRIMARY KEY, data BLOB NOT NULL)');
    this.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  }

  private getKv(k: string): string | undefined {
    return this.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0]?.v as string | undefined;
  }

  private setKv(k: string, v: string): void {
    this.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, v);
  }

  /** Per-socket traffic meters (memory only: they restart when the room wakes from hibernation). */
  private meters = new Map<string, Meter>();
  private lastLive: boolean | undefined;
  /** Set when the page is deleted, so closing its sockets doesn't save it back into existence. */
  private deleted = false;

  onConnect(conn: Connection<ConnState>, ctx: ConnectionContext): void | Promise<void> {
    const role = ctx.request.headers.get(ROLE_HEADER) as Role | null;
    // Only the Worker can open a connection here, and it always sets the role.
    if (!role) {
      conn.close(4403, 'forbidden');
      return;
    }
    if ([...this.getConnections()].length > MAX_CONNECTIONS) {
      conn.close(4429, 'too many people on this page');
      return;
    }
    conn.setState({ role, name: ctx.request.headers.get(NAME_HEADER) ?? '' });
    const result = super.onConnect(conn, ctx);
    this.announceMode(conn);
    if (this.isOversize()) this.sendCustomMessage(conn, this.oversizeNotice());
    return result;
  }

  /**
   * "Live" collaboration (cursors sent as they move, edits sent as they are typed) only matters when two or
   * more people can edit. With one writer, or only readers, clients stop sending cursors and batch their
   * edits, which cuts the messages (and the rows written to save them) a lot. The room tells everyone
   * whenever the answer changes, and tells each new connection at once.
   */
  private isLive(except?: Connection): boolean {
    let writers = 0;
    for (const c of this.getConnections<ConnState>()) {
      if (c.id !== except?.id && c.state && atLeast(c.state.role, 'editor') && ++writers >= 2) return true;
    }
    return false;
  }

  private announceMode(joined?: Connection, leaving?: Connection): void {
    const live = this.isLive(leaving);
    const message = JSON.stringify({ type: 'mode', live });
    if (joined) this.sendCustomMessage(joined, message);
    if (live !== this.lastLive) {
      this.lastLive = live;
      for (const c of this.getConnections()) if (c.id !== joined?.id && c.id !== leaving?.id) this.sendCustomMessage(c, message);
    }
  }

  onClose(conn: Connection, code: number, reason: string, wasClean: boolean): void | Promise<void> {
    this.meters.delete(conn.id);
    const result = super.onClose(conn, code, reason, wasClean);
    this.announceMode(undefined, conn);
    // The last person leaving: write down what they did now rather than waiting out the throttle.
    if (!this.deleted && code !== 4404 && ![...this.getConnections()].some((c) => c.id !== conn.id)) {
      this.ctx.waitUntil(this.persist(true).catch((err) => console.error('final save failed', err)));
    }
    return result;
  }

  /**
   * Cheap guards in front of the Yjs handler. Viewers and commenters can open a socket (shared links
   * included), and every message they send is billed, so a flood is cut off here: cursor traffic over
   * the allowed rate is dropped, and a socket that keeps sending sync messages is closed.
   */
  onMessage(conn: Connection, message: string | ArrayBuffer | ArrayBufferView): void | Promise<void> {
    if (typeof message !== 'string') {
      const size = message.byteLength;
      if (size > MAX_MESSAGE_BYTES) return void conn.close(4413, 'message too large');
      const first = message instanceof ArrayBuffer ? new Uint8Array(message)[0] : new Uint8Array(message.buffer, message.byteOffset, 1)[0];
      const now = Date.now();
      const m = this.meters.get(conn.id) ?? { tokens: AWARENESS_BURST, at: now, syncStart: now, syncCount: 0, syncBytes: 0 };
      this.meters.set(conn.id, m);
      if (first === 1) {
        m.tokens = Math.min(AWARENESS_BURST, m.tokens + ((now - m.at) / 1000) * AWARENESS_PER_SEC);
        m.at = now;
        if (m.tokens < 1) return; // dropped: the next cursor position replaces this one anyway
        m.tokens -= 1;
      } else {
        if (now - m.syncStart > SYNC_WINDOW_MS) {
          m.syncStart = now;
          m.syncCount = 0;
          m.syncBytes = 0;
        }
        m.syncBytes += size;
        if (++m.syncCount > SYNC_WINDOW_MAX || m.syncBytes > SYNC_WINDOW_BYTES) return void conn.close(4429, 'too many messages');
      }
    }
    return super.onMessage(conn, message);
  }

  /**
   * Viewers and commenters receive the document but their edits are ignored. So are an editor's, on a page past the size
   * limit; admins can still edit it, so that someone can cut it back down (a locked page nobody can trim would be stuck).
   */
  isReadOnly(conn: Connection): boolean {
    const state = (conn as Connection<ConnState>).state;
    return !state || !atLeast(state.role, 'editor') || (this.isOversize() && !atLeast(state.role, 'admin'));
  }

  /**
   * A page whose document passed the admin's size limit stops taking edits from editors (what's there is kept), and everyone is
   * told, so nobody types into something that would not be saved. Admins can still edit it to trim it, and restoring an earlier
   * version brings it back under the limit.
   */
  private oversize: boolean | undefined;
  private limitCache: { at: number; bytes: number } | undefined;

  private isOversize(): boolean {
    if (this.oversize === undefined) {
      this.ensureTables();
      this.oversize = this.getKv('oversize') === '1';
    }
    return this.oversize;
  }

  private async pageLimit(): Promise<number> {
    if (!this.limitCache || Date.now() - this.limitCache.at > 60_000) this.limitCache = { at: Date.now(), bytes: await maxPageBytes(this.env) };
    return this.limitCache.bytes;
  }

  private oversizeNotice(): string {
    return JSON.stringify({ type: 'oversize', over: this.isOversize(), limit: Number(this.getKv('oversize_limit') ?? 0) });
  }

  private async checkSize(bytes: number): Promise<void> {
    const limit = await this.pageLimit();
    const over = bytes > limit;
    if (over === this.isOversize()) return;
    this.oversize = over;
    this.setKv('oversize', over ? '1' : '0');
    this.setKv('oversize_limit', String(limit));
    this.broadcastCustomMessage(this.oversizeNotice());
  }

  /** What the room has written down: the base copy, the updates since, and the document as of the last save. */
  private persisted: { sv: Uint8Array; hash: string; baseBytes: number; updateBytes: number; updateRows: number } | undefined;

  async onLoad(): Promise<void> {
    this.ensureTables();
    const base = this.exec('SELECT data FROM doc_chunks ORDER BY i').toArray() as { data: ArrayBuffer }[];
    let baseBytes = 0;
    if (base.length) {
      const state = new Uint8Array(base.reduce((n, r) => n + r.data.byteLength, 0));
      let off = 0;
      for (const r of base) {
        state.set(new Uint8Array(r.data), off);
        off += r.data.byteLength;
      }
      baseBytes = state.byteLength;
      Y.applyUpdate(this.document, state);
    }
    const updates = this.exec('SELECT data FROM doc_updates ORDER BY i').toArray() as { data: ArrayBuffer }[];
    let updateBytes = 0;
    for (const u of updates) {
      updateBytes += u.data.byteLength;
      Y.applyUpdate(this.document, new Uint8Array(u.data));
    }
    this.persisted = { sv: Y.encodeStateVector(this.document), hash: this.stateVector(), baseBytes, updateBytes, updateRows: updates.length };
  }

  async onSave(): Promise<void> {
    await this.persist(false);
  }

  /** The throttled index/refs work runs from an alarm when a body edit had to wait. */
  async onAlarm(): Promise<void> {
    this.ensureTables();
    await this.reindex(true);
  }

  /**
   * Saves the document to the room's own storage when it changed, then refreshes the D1 copy
   * (title, search text, file references) and the history. `force` skips the D1 throttle.
   * Saves are triggered by document edits only; unchanged state writes nothing.
   */
  private async persist(force: boolean): Promise<void> {
    if (this.deleted) return; // a save still pending when the page was deleted must not bring it back
    this.ensureTables();
    const saved = (this.persisted ??= { sv: new Uint8Array([0]), hash: '', baseBytes: 0, updateBytes: 0, updateRows: 0 });
    const hash = this.stateVector();
    if (saved.hash !== hash) {
      // Only what changed since the last save is written: one small row, instead of the whole document again (which for a
      // big page is many rows and megabytes each time). Every so often (and when the last person leaves) the pieces are
      // merged back into one copy, so that loading a page never has to read a long list.
      const update = Y.encodeStateAsUpdate(this.document, saved.sv);
      const approx = saved.baseBytes + saved.updateBytes + update.byteLength; // an upper bound: updates repeat some of what the copy holds
      if (approx > Math.min(await this.pageLimit(), MAX_STATE_BYTES)) {
        // Near a limit the estimate isn't good enough (many small updates, or a page that has been cut back): measure the
        // real document, and write it whole, which also merges the updates.
        const state = Y.encodeStateAsUpdate(this.document);
        await this.checkSize(state.byteLength);
        if (state.byteLength > MAX_STATE_BYTES) {
          console.error('page state is too large to save', this.name, state.byteLength);
          return;
        }
        this.compact(state);
      } else {
        await this.checkSize(approx);
        this.exec('INSERT INTO doc_updates (data) VALUES (?)', update);
        saved.updateBytes += update.byteLength;
        saved.updateRows++;
        if (saved.updateRows >= COMPACT_ROWS || saved.updateBytes >= COMPACT_BYTES) this.compact();
      }
      saved.sv = Y.encodeStateVector(this.document);
      saved.hash = hash;
    }
    // The last person leaving: tidy up a long list of updates now, so the next load reads one copy.
    if (force && saved.updateRows >= COMPACT_ON_LEAVE) this.compact();
    await this.reindex(force);

    // Automatic history: at most every 10 minutes, and only if something changed.
    const last = Number(this.getKv('last_snapshot_at') ?? 0);
    if (Date.now() - last >= AUTO_SNAPSHOT_EVERY && this.getKv('last_snapshot_sv') !== this.stateVector()) {
      // The page itself is already saved; a missed snapshot is retried on the next save.
      await this.snapshot('auto', null, null).catch((err) => {
        // The page was deleted while this save was in flight: nothing to keep.
        if (!(err instanceof HttpError && err.status === 404)) console.error('auto snapshot failed', err);
      });
    }
  }

  /**
   * Mirrors title, icon, search text and file references into D1. Each of those writes several rows
   * (the search index is FTS5), so body edits are folded together: at most one refresh per INDEX_EVERY
   * while people keep typing, the rest by an alarm, and the final one when the last person leaves.
   * A new title or icon is written straight away so the sidebar follows renames.
   */
  private async reindex(force: boolean): Promise<void> {
    const title = this.title();
    const icon = String(this.document.getMap('meta').get('icon') ?? '').slice(0, 16);
    const fullText = fragmentText(this.document.getXmlFragment(FRAGMENT));
    const body = fullText.length > INDEX_TEXT_MAX ? fullText.slice(0, INDEX_TEXT_MAX) : fullText;
    const headSig = hashText(`${title}\u0000${icon}`);
    const sig = hashText(`${headSig}\u0000${body}`);
    const used = fileIdsIn(this.document.getXmlFragment(FRAGMENT).toString());
    const refsSig = used.join(',');
    const indexChanged = this.getKv('indexed_sig') !== sig;
    const refsChanged = this.getKv('refs_sig') !== refsSig;
    if (!indexChanged && !refsChanged) return;

    const since = Date.now() - Number(this.getKv('indexed_at') ?? 0);
    const renamed = this.getKv('head_sig') !== headSig;
    if (!force && !renamed && since < INDEX_EVERY) {
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + (INDEX_EVERY - since));
      return;
    }
    if (indexChanged) {
      await this.env.DB.batch([
        this.env.DB.prepare('UPDATE pages SET title = ?, icon = ?, updated_at = ? WHERE id = ?').bind(title, icon, Date.now(), this.name),
        this.env.DB.prepare('DELETE FROM pages_fts WHERE page_id = ?').bind(this.name),
        this.env.DB.prepare(
          'INSERT INTO pages_fts (page_id, project_id, title, body) SELECT id, project_id, ?, ? FROM pages WHERE id = ?'
        ).bind(title, body, this.name),
      ]);
      this.setKv('indexed_sig', sig);
      this.setKv('head_sig', headSig);
      this.setKv('indexed_at', String(Date.now()));
    }
    // Which files the page uses, so a file can be shared by several pages and survive them.
    if (refsChanged) {
      await syncFileRefs(this.env, this.name, used).then(() => this.setKv('refs_sig', refsSig), (err) => console.error('file refs failed', err));
    }
  }

  /** Writes the whole document as the base copy and drops the updates it now contains. Returns the document's size in bytes. */
  private compact(known?: Uint8Array): number {
    const state = known ?? Y.encodeStateAsUpdate(this.document);
    this.ctx.storage.transactionSync(() => {
      this.exec('DELETE FROM doc_chunks');
      for (let i = 0, off = 0; off < state.byteLength; i++, off += CHUNK) {
        this.exec('INSERT INTO doc_chunks (i, data) VALUES (?, ?)', i, state.subarray(off, off + CHUNK));
      }
      this.exec('DELETE FROM doc_updates');
    });
    if (this.persisted) Object.assign(this.persisted, { baseBytes: state.byteLength, updateBytes: 0, updateRows: 0, sv: Y.encodeStateVector(this.document) });
    return state.byteLength;
  }

  private title(): string {
    return String(this.document.getMap('meta').get('title') ?? '');
  }

  /** A short fingerprint of what the document holds (its state vector can be large, and spreading it into one call overflows the stack). */
  private stateVector(): string {
    const sv = Y.encodeStateVector(this.document);
    let text = '';
    for (let i = 0; i < sv.length; i += 0x2000) text += String.fromCharCode(...sv.subarray(i, i + 0x2000));
    return hashText(text);
  }

  /**
   * The user whose storage holds a snapshot: whoever asked for it, or for
   * automatic snapshots the page's creator, else the workspace owner.
   */
  private async snapshotOwner(userId: string | null): Promise<string | null> {
    if (userId) return userId;
    const row = await this.env.DB.prepare(
      `SELECT COALESCE(p.created_by, (SELECT m.user_id FROM workspace_members m WHERE m.workspace_id = pr.workspace_id AND m.role = 'owner' LIMIT 1)) AS uid
       FROM pages p JOIN projects pr ON pr.id = p.project_id WHERE p.id = ?`
    )
      .bind(this.name)
      .first<{ uid: string | null }>();
    return row?.uid ?? null;
  }

  /**
   * Writes the current document to the owner's storage and records it in
   * page_versions. Automatic snapshots are skipped (returning null) when the
   * owner has no storage or no room; asked-for ones throw.
   */
  private async snapshot(kind: 'auto' | 'manual' | 'before-restore', by: string | null, userId: string | null) {
    useStorageKey(this.env.STORAGE_KEY);
    const state = Y.encodeStateAsUpdate(this.document) as Uint8Array<ArrayBuffer>;
    const owner = await this.snapshotOwner(userId);
    const workspaceId = await workspaceOfPage(this.env, this.name);
    const storage = owner ? await resolveStorage(this.env, owner, workspaceId) : null;
    if (!storage) {
      if (kind === 'auto') return null;
      throw new HttpError(409, 'no storage set up for history: add one in Settings → Storage');
    }
    try {
      await checkQuota(this.env, storage, owner!, workspaceId, state.byteLength);
      await checkWorkspaceQuota(this.env, workspaceId, state.byteLength);
    } catch (err) {
      if (kind === 'auto') return null;
      throw err;
    }
    const id = newId();
    const key = historyKey(workspaceId, this.name, id);
    await new WebDav(storage).put(key, state, 'application/octet-stream', String(state.byteLength));
    const version = { id, kind, title: this.title(), created_by_name: by, size: state.byteLength, created_at: Date.now() };
    await this.env.DB.prepare(
      `INSERT INTO page_versions (id, page_id, kind, title, created_by_name, size, storage_key, storage_id, owner_id, created_at)
       SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ? FROM pages WHERE id = ?`
    )
      .bind(id, kind, version.title, by, version.size, key, storage.id, owner, version.created_at, this.name)
      .run();
    // Concurrent writes can each pass the check and together not: look again, and take this one back if so.
    if (await pastStorageLimit(this.env, workspaceId, 'version', id)) {
      await this.env.DB.prepare('DELETE FROM page_versions WHERE id = ?').bind(id).run();
      await new WebDav(storage).delete(key).catch(() => undefined);
      if (kind === 'auto') return null;
      throw new HttpError(413, "this workspace's storage limit is reached");
    }
    if (kind === 'auto') await this.pruneAuto().catch((err) => console.error('pruning history failed', err));
    this.ensureTables();
    this.setKv('last_snapshot_at', String(version.created_at));
    this.setKv('last_snapshot_sv', this.stateVector());
    this.broadcastCustomMessage(JSON.stringify({ type: 'history' }));
    return version;
  }

  /**
   * Automatic history is a rolling window: only the newest AUTO_KEEP automatic versions stay (named versions and
   * the copy kept before a restore stay for ever), so a page being edited for a year doesn't fill the storage.
   */
  private async pruneAuto(): Promise<void> {
    const { results } = await this.env.DB.prepare(
      "SELECT id, storage_key, storage_id FROM page_versions WHERE page_id = ? AND kind = 'auto' ORDER BY created_at DESC LIMIT 10 OFFSET ?"
    )
      .bind(this.name, AUTO_KEEP)
      .all<{ id: string; storage_key: string; storage_id: string | null }>();
    for (const old of results) {
      const storage = await storageById(this.env, old.storage_id);
      if (storage) await new WebDav(storage).delete(old.storage_key).catch(() => undefined);
      await this.env.DB.prepare('DELETE FROM page_versions WHERE id = ?').bind(old.id).run();
    }
  }

  /**
   * Internal endpoints, reached only through the Worker after its permission
   * checks (the Worker owns all routing to this class):
   *   POST /snapshot      save a manual version        { by, userId }
   *   POST /restore       restore a saved version       { versionId, by, userId }
   *   POST /notify        tell open pages to refresh    { type, from? }
   *   GET  /export        the document as Yjs bytes (workspace backup)
   *   PUT  /load          merge Yjs bytes into the document (workspace import)
   *   DELETE /            wipe the page
   */
  async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    useStorageKey(this.env.STORAGE_KEY);
    try {
      if (request.method === 'DELETE') {
        this.deleted = true;
        for (const conn of this.getConnections()) conn.close(4404, 'page deleted');
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        return new Response(null, { status: 204 });
      }
      // Workspace backups: the page's current document as Yjs bytes, and the way back in.
      if (request.method === 'GET' && path === '/export') {
        return new Response(Y.encodeStateAsUpdate(this.document) as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'application/octet-stream' } });
      }
      if (request.method === 'PUT' && path === '/load') {
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength > MAX_STATE_BYTES) throw new HttpError(413, 'page is too large to import');
        // An import (`wid` = the new workspace) gets this page's file links and own id pointed at their new ids.
        const url = new URL(request.url);
        const wid = url.searchParams.get('wid');
        const old = url.searchParams.get('old');
        if (wid && old) {
          const scratch = new Y.Doc();
          Y.applyUpdate(scratch, bytes);
          const map = new Map<string, string>();
          for (const id of fileIdsInText(scratch.getXmlFragment(FRAGMENT).toString())) map.set(id, await deriveId(wid, id));
          rewriteDocument(scratch, FRAGMENT, map, old, this.name);
          Y.applyUpdate(this.document, Y.encodeStateAsUpdate(scratch));
        } else Y.applyUpdate(this.document, bytes);
        await this.persist(true);
        return new Response(null, { status: 204 });
      }
      const body = (await request.json().catch(() => ({}))) as {
        by?: string;
        userId?: string;
        versionId?: string;
        type?: string;
        from?: string;
      };
      if (request.method === 'POST' && path === '/snapshot') {
        return json(await this.snapshot('manual', body.by ?? null, body.userId ?? null), 201);
      }
      if (request.method === 'POST' && path === '/restore') {
        const row = await this.env.DB.prepare('SELECT storage_key, storage_id FROM page_versions WHERE id = ? AND page_id = ?')
          .bind(body.versionId ?? '', this.name)
          .first<{ storage_key: string; storage_id: string | null }>();
        if (!row) throw new HttpError(404, 'no such version');
        const storage = await storageById(this.env, row.storage_id);
        if (!storage) throw new HttpError(410, 'the storage holding this version was removed');
        const res = await new WebDav(storage).get(row.storage_key);
        if (!res.ok) throw new HttpError(502, `version not available in storage (${res.status})`);
        const snapshot = new Uint8Array(await res.arrayBuffer());
        // Keep what's being replaced, so a restore can be undone.
        await this.snapshot('before-restore', body.by ?? null, body.userId ?? null);
        // Applied as ordinary edits, so everyone on the page sees the restore live.
        const saved = new Y.Doc();
        Y.applyUpdate(saved, snapshot);
        if (saved.share.size === 0) {
          // A version of a page that was still empty has no content to put back, and the replace helper can't cope with
          // that: restoring it means clearing the page.
          this.document.transact(() => {
            const body = this.document.getXmlFragment(FRAGMENT);
            body.delete(0, body.length);
            this.document.getMap('meta').clear();
            this.document.getMap('layouts').clear();
          });
        } else this.unstable_replaceDocument(snapshot, (key) => (key === FRAGMENT ? 'XmlFragment' : 'Map'));
        saved.destroy();
        await this.persist(true);
        return new Response(null, { status: 204 });
      }
      if (request.method === 'POST' && path === '/notify') {
        // `from` is the browser tab that made the change: it already has the result and skips the refresh.
        this.broadcastCustomMessage(JSON.stringify({ type: body.type ?? 'refresh', ...(body.from ? { from: body.from } : {}) }));
        return new Response(null, { status: 204 });
      }
      return new Response('Not Found', { status: 404 });
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      throw err;
    }
  }
}

/** Small non-cryptographic hash (cyrb53), to tell whether text changed without storing it. */
function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${text.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/** Plain text of a BlockNote document, one line per block, for search. */
export function fragmentText(node: Y.XmlFragment | Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) {
    return (node.toDelta() as { insert: unknown }[])
      .map((d) => (typeof d.insert === 'string' ? d.insert : ''))
      .join('');
  }
  const parts: string[] = [];
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText || child instanceof Y.XmlElement) {
      const text = fragmentText(child);
      if (text) parts.push(text);
    }
  }
  return parts.join('\n');
}
