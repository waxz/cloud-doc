import * as Y from 'yjs';
import type YProvider from 'y-partyserver/provider';

/**
 * Live vs quiet collaboration on one page.
 *
 * Every message a browser sends to a page's room is a billed request on Cloudflare's free plan, and
 * most of them are cursor moves and one-per-keystroke edits. They only pay off when two or more people
 * can edit at once. The room counts the writers and tells every connection ("live" or not):
 *
 *  - live (two or more writers): edits go out as they happen and each writer's cursor is shared;
 *  - quiet (one writer, or only readers): edits are gathered for a moment and sent together, and
 *    cursors are not sent at all. Presence (who is on the page) still is, once per join.
 *
 * Readers never send cursors, whatever the mode. Edits are never dropped, only delayed, and are sent
 * at once when the tab is hidden or closed.
 */
const QUIET_BATCH_MS = 1200;

export interface LiveMode {
  setLive(live: boolean): void;
  isLive(): boolean;
  /** Sends gathered edits now. */
  flush(): void;
  dispose(): void;
}

type Handler = (update: Uint8Array, origin: unknown) => void;

export function attachLiveMode(provider: YProvider, doc: Y.Doc, canEdit: boolean): LiveMode {
  const awareness = provider.awareness;
  const sendNow = (provider as unknown as { _updateHandler?: Handler })._updateHandler;
  let live = false;
  let pending: Uint8Array | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!pending || !sendNow) return;
    const update = pending;
    pending = null;
    sendNow(update, null);
  };

  // Take over how local edits are sent (the provider's own handler becomes the "send now" path).
  const onUpdate: Handler = (update, origin) => {
    if (origin === provider) return; // came from the server
    if (live || !sendNow) return sendNow?.(update, origin);
    pending = pending ? Y.mergeUpdates([pending, update]) : update;
    timer ??= setTimeout(flush, QUIET_BATCH_MS);
  };
  if (sendNow) {
    doc.off('update', sendNow);
    doc.on('update', onUpdate);
  }

  // Cursor positions are the chattiest thing awareness carries; presence (the `user` field) is kept.
  const setField = awareness.setLocalStateField.bind(awareness);
  awareness.setLocalStateField = (field: string, value: unknown) => {
    if (field === 'cursor' && (!live || !canEdit)) return;
    setField(field, value);
  };

  const onHide = () => document.visibilityState === 'hidden' && flush();
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);

  return {
    isLive: () => live,
    flush,
    setLive(next) {
      if (next === live) return;
      live = next;
      if (live) flush();
      // Leaving live mode: stop showing a stale cursor to others.
      else if (awareness.getLocalState()?.cursor) setField('cursor', null);
    },
    dispose() {
      flush();
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
      if (sendNow) {
        doc.off('update', onUpdate);
        doc.on('update', sendNow);
      }
      awareness.setLocalStateField = setField;
    },
  };
}
