import type { Connection, ConnectionContext } from 'partyserver';
import { YServer } from 'y-partyserver';
import * as Y from 'yjs';
import { type Role, atLeast } from './access.js';
import type { Env } from './env.js';
import { useStorageKey } from './secret.js';
import { HttpError, json, newId } from './http.js';
import { WebDav, checkQuota, historyKey, resolveStorage, storageById, workspaceOfPage } from './storage.js';
import { fileIdsIn, syncFileRefs } from './files.js';

/** BlockNote keeps the document in this XML fragment; the title lives in `meta`. */
export const FRAGMENT = 'document-store';
/** Headers the Worker sets (after stripping client copies) before a connection reaches the room. */
export const ROLE_HEADER = 'x-wiki-role';
export const NAME_HEADER = 'x-wiki-name';

const CHUNK = 1024 * 1024; // SQLite rows are capped at 2 MB, so state is stored in chunks.
const AUTO_SNAPSHOT_EVERY = 10 * 60 * 1000;

interface ConnState {
  role: Role;
  name: string;
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
    this.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  }

  private getKv(k: string): string | undefined {
    return this.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0]?.v as string | undefined;
  }

  private setKv(k: string, v: string): void {
    this.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, v);
  }

  onConnect(conn: Connection<ConnState>, ctx: ConnectionContext): void | Promise<void> {
    const role = ctx.request.headers.get(ROLE_HEADER) as Role | null;
    // Only the Worker can open a connection here, and it always sets the role.
    if (!role) {
      conn.close(4403, 'forbidden');
      return;
    }
    conn.setState({ role, name: ctx.request.headers.get(NAME_HEADER) ?? '' });
    return super.onConnect(conn, ctx);
  }

  /** Viewers and commenters receive the document but their edits are ignored. */
  isReadOnly(conn: Connection): boolean {
    const state = (conn as Connection<ConnState>).state;
    return !state || !atLeast(state.role, 'editor');
  }

  async onLoad(): Promise<void> {
    this.ensureTables();
    const rows = this.exec('SELECT data FROM doc_chunks ORDER BY i').toArray() as { data: ArrayBuffer }[];
    if (rows.length === 0) return;
    const state = new Uint8Array(rows.reduce((n, r) => n + r.data.byteLength, 0));
    let off = 0;
    for (const r of rows) {
      state.set(new Uint8Array(r.data), off);
      off += r.data.byteLength;
    }
    Y.applyUpdate(this.document, state);
  }

  async onSave(): Promise<void> {
    this.ensureTables();
    // Saves are triggered by any traffic on the document (cursors, reconnects), not just edits.
    // Writing the whole state and re-indexing the page each time costs rows written in both
    // the room's storage and D1, so do only the parts whose input actually changed.
    const sv = this.stateVector();
    if (this.getKv('saved_sv') !== sv) {
      const state = Y.encodeStateAsUpdate(this.document);
      this.ctx.storage.transactionSync(() => {
        this.exec('DELETE FROM doc_chunks');
        for (let i = 0, off = 0; off < state.byteLength; i++, off += CHUNK) {
          this.exec('INSERT INTO doc_chunks (i, data) VALUES (?, ?)', i, state.subarray(off, off + CHUNK));
        }
        this.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', 'saved_sv', sv);
      });

      const title = this.title();
      const icon = String(this.document.getMap('meta').get('icon') ?? '').slice(0, 16);
      const body = fragmentText(this.document.getXmlFragment(FRAGMENT));
      const sig = hashText(`${title}\u0000${icon}\u0000${body}`);
      if (this.getKv('indexed_sig') !== sig) {
        await this.env.DB.batch([
          this.env.DB.prepare('UPDATE pages SET title = ?, icon = ?, updated_at = ? WHERE id = ?').bind(title, icon, Date.now(), this.name),
          this.env.DB.prepare('DELETE FROM pages_fts WHERE page_id = ?').bind(this.name),
          this.env.DB.prepare(
            'INSERT INTO pages_fts (page_id, project_id, title, body) SELECT id, project_id, ?, ? FROM pages WHERE id = ?'
          ).bind(title, body, this.name),
        ]);
        this.setKv('indexed_sig', sig);
      }
      // Which files the page uses, so a file can be shared by several pages and survive them.
      const used = fileIdsIn(this.document.getXmlFragment(FRAGMENT).toString());
      const refsSig = used.join(',');
      if (this.getKv('refs_sig') !== refsSig) {
        await syncFileRefs(this.env, this.name, used).then(() => this.setKv('refs_sig', refsSig), (err) => console.error('file refs failed', err));
      }
    }

    // Automatic history: at most every 10 minutes, and only if something changed.
    const last = Number(this.getKv('last_snapshot_at') ?? 0);
    if (Date.now() - last >= AUTO_SNAPSHOT_EVERY && this.getKv('last_snapshot_sv') !== this.stateVector()) {
      // The page itself is already saved; a missed snapshot is retried on the next save.
      await this.snapshot('auto', null, null).catch((err) => console.error('auto snapshot failed', err));
    }
  }

  private title(): string {
    return String(this.document.getMap('meta').get('title') ?? '');
  }

  private stateVector(): string {
    return btoa(String.fromCharCode(...Y.encodeStateVector(this.document)));
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
    this.ensureTables();
    this.setKv('last_snapshot_at', String(version.created_at));
    this.setKv('last_snapshot_sv', this.stateVector());
    this.broadcastCustomMessage(JSON.stringify({ type: 'history' }));
    return version;
  }

  /**
   * Internal endpoints, reached only through the Worker after its permission
   * checks (the Worker owns all routing to this class):
   *   POST /snapshot      save a manual version        { by, userId }
   *   POST /restore       restore a saved version       { versionId, by, userId }
   *   POST /notify        tell open pages to refresh    { type }
   *   DELETE /            wipe the page
   */
  async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    useStorageKey(this.env.STORAGE_KEY);
    try {
      if (request.method === 'DELETE') {
        for (const conn of this.getConnections()) conn.close(4404, 'page deleted');
        await this.ctx.storage.deleteAll();
        return new Response(null, { status: 204 });
      }
      const body = (await request.json().catch(() => ({}))) as {
        by?: string;
        userId?: string;
        versionId?: string;
        type?: string;
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
        this.unstable_replaceDocument(snapshot, (key) => (key === FRAGMENT ? 'XmlFragment' : 'Map'));
        await this.onSave();
        return new Response(null, { status: 204 });
      }
      if (request.method === 'POST' && path === '/notify') {
        this.broadcastCustomMessage(JSON.stringify({ type: body.type ?? 'refresh' }));
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
