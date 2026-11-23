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
