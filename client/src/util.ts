const COLORS = ['#e8590c', '#2f9e44', '#1971c2', '#9c36b5', '#c2255c', '#0c8599', '#f08c00', '#5f3dc4'];

/** A stable cursor/avatar color per person. */
export function colorFor(key: string): string {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) | 0;
  return COLORS[Math.abs(h) % COLORS.length]!;
}

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}

/**
 * Calls `fn` every `ms` while the tab is visible, and when the tab comes back or the window
 * is focused, but never twice within `minGap` ms. Keeps background tabs from burning the
 * Worker request quota. Returns a cleanup function.
 */
export function pollWhenVisible(fn: () => void, ms: number, minGap = ms / 2): () => void {
  let last = Date.now();
  const run = () => {
    if (document.visibilityState === 'hidden' || Date.now() - last < minGap) return;
    last = Date.now();
    fn();
  };
  const timer = window.setInterval(run, ms);
  document.addEventListener('visibilitychange', run);
  window.addEventListener('focus', run);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', run);
    window.removeEventListener('focus', run);
  };
}

/** Trailing-edge debounce: bursts of calls become one, `ms` after the last. */
export function debounced<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/** Pages the user starred, kept in this browser. */
const FAVORITES_KEY = 'cloud-doc-favorites';
export function getFavorites(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
export function toggleFavorite(pageId: string): boolean {
  const list = getFavorites();
  const on = !list.includes(pageId);
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(on ? [...list, pageId] : list.filter((id) => id !== pageId)));
  } catch {
    /* storage unavailable: the star just won't stick */
  }
  window.dispatchEvent(new CustomEvent('cloud-doc-favorites'));
  return on;
}

/** Saves text as a file download. */
export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A search result to jump to once its page is open: which occurrence of the words, plus context to check it. */
export interface FindRequest {
  pageId: string;
  words: string[];
  n: number;
  before: string;
  text: string;
}
let pendingFind: FindRequest | null = null;
export function requestFind(request: FindRequest): void {
  pendingFind = request;
  window.dispatchEvent(new CustomEvent('cloud-doc-find'));
}
export function takeFind(pageId: string): FindRequest | null {
  if (!pendingFind || pendingFind.pageId !== pageId) return null;
  const request = pendingFind;
  pendingFind = null;
  return request;
}

/** Where each highlight thread sits in the open page (px from the top of the document), for ordering the Highlights panel. */
export const highlightPositions: { current: Record<string, number> } = { current: {} };

export type HighlightOrder = 'newest' | 'oldest' | 'position';
const ORDER_KEY = 'cloud-doc-highlight-order';
export function getHighlightOrder(): HighlightOrder {
  try {
    const v = localStorage.getItem(ORDER_KEY);
    return v === 'oldest' || v === 'position' ? v : 'newest';
  } catch {
    return 'newest';
  }
}
export function setHighlightOrder(order: HighlightOrder): void {
  try {
    localStorage.setItem(ORDER_KEY, order);
  } catch {
    /* the choice just won't be remembered */
  }
}
