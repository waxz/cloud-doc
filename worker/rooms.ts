import { getServerByName } from 'partyserver';
import type { Env } from './env.js';

/** The live-editing room (Durable Object) of a page. */
export const room = (env: Env, pageId: string) => getServerByName(env.PageRoom, pageId);

/** Sends an internal request to a page's room (see PageRoom.onRequest). */
export async function tellRoom(env: Env, pageId: string, path: string, body: unknown): Promise<Response> {
  const stub = await room(env, pageId);
  return stub.fetch(
    new Request(`http://room${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

/** The page's document as Yjs bytes (for workspace backups). */
export async function exportRoom(env: Env, pageId: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await (await room(env, pageId)).fetch(new Request('http://room/export'));
  if (!res.ok) throw new Error(`room export failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Fills a (new) page's room with Yjs bytes from a backup. */
export async function loadRoom(env: Env, pageId: string, state: Uint8Array, from?: { workspaceId: string; oldPageId: string }): Promise<void> {
  const q = from ? `?wid=${from.workspaceId}&old=${encodeURIComponent(from.oldPageId)}` : '';
  const res = await (await room(env, pageId)).fetch(new Request(`http://room/load${q}`, { method: 'PUT', body: state as Uint8Array<ArrayBuffer> }));
  if (!res.ok) throw new Error(`room import failed (${res.status})`);
}
