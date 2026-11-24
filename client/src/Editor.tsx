import { type BlockNoteEditor, insertOrUpdateBlockForSlashMenu } from '@blocknote/core';
import { filterSuggestionItems } from '@blocknote/core/extensions';
import { withCollaboration } from '@blocknote/core/yjs';
import { BlockNoteView } from '@blocknote/mantine';
import {
  FormattingToolbar,
  FormattingToolbarController,
  getDefaultReactSlashMenuItems,
  getFormattingToolbarItems,
  useBlockNoteEditor,
  useSelectedBlocks,
  SuggestionMenuController,
  useComponentsContext,
  useCreateBlockNote,
} from '@blocknote/react';
import { ActionIcon, Avatar, Button, Checkbox, Group, Loader, Popover, SegmentedControl, SimpleGrid, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconFileTypePdf, IconMessagePlus, IconMoodSmile } from '@tabler/icons-react';
import { useMediaQuery } from '@mantine/hooks';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import YProvider from 'y-partyserver/provider';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { api, TAB_ID, type Comment } from './api';
import { attachLiveMode } from './liveMode';
import { IconArticle, IconLayoutColumns } from '@tabler/icons-react';
import { COMMENT_COLORS, HIGHLIGHT_SHAPES, PageContext, type HighlightShape, schema, type Schema } from './blocks';
import { errorText, highlightPositions, pollWhenVisible, takeFind } from './util';

export interface Person {
  accountId?: string;
  name: string;
  color: string;
}

export type Editor = BlockNoteEditor<Schema['blockSchema'], Schema['inlineContentSchema'], Schema['styleSchema']>;

interface Props {
  pageId: string;
  me: Person;
  canEdit: boolean;
  /** Commenters get a "Comment" button on selected text. */
  canComment: boolean;
  dark: boolean;
  onTitle?: (title: string) => void;
  onIcon?: (icon: string) => void;
  /** Notices from the page's room, e.g. `comments`, `history`, `files`. */
  onMessage?: (type: string) => void;
  onEditor?: (editor: Editor | null) => void;
  /** Start a comment on the selected text. */
  onComment?: (quote: string, anchor?: { page?: number; rects?: number[][]; pdfUrl?: string; start?: number; end?: number }, color?: string, shape?: string) => void;
  onError: (message: string) => void;
}

interface Peer extends Person {
  id: number;
  accountId?: string;
}

const EMOJI = [
  '📄', '📝', '📌', '📎', '📚', '📖', '🗂️', '📁', '🗃️', '📊', '📈', '🧾',
  '✅', '☑️', '⭐', '🔥', '💡', '🎯', '🚀', '⚙️', '🛠️', '🔧', '🧪', '🐛',
  '🔒', '🔑', '🌐', '🏠', '🏢', '👥', '🙋', '💬', '📣', '📅', '⏰', '🗓️',
  '🎨', '🖼️', '🎬', '🎵', '📷', '🧭', '🗺️', '🌱', '🍀', '☕', '🎉', '❤️',
];

/** A comment's text for a short preview: formatting marks and links reduced to the words. */
function briefText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(#{1,3}\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+\.\s+|>\s?)/gm, '')
    .replace(/[|*_`~$]|---+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

export function getEditorFullText(root: HTMLElement): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = '';
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    text += node.textContent ?? '';
  }
  return text;
}

function getTextNodeAndOffset(container: Node, offset: number, isEnd: boolean): { node: Text; offset: number } | null {
  if (container.nodeType === Node.TEXT_NODE) {
    return { node: container as Text, offset };
  }
  if (offset < container.childNodes.length) {
    const child = container.childNodes[offset];
    if (child.nodeType === Node.TEXT_NODE) return { node: child as Text, offset: 0 };
    const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
    const textNode = walker.nextNode() as Text | null;
    if (textNode) return { node: textNode, offset: 0 };
  } else if (container.childNodes.length > 0) {
    const child = container.childNodes[container.childNodes.length - 1];
    if (child.nodeType === Node.TEXT_NODE) return { node: child as Text, offset: child.textContent?.length ?? 0 };
    const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
    let lastText: Text | null = null;
    let curr: Text | null;
    while ((curr = walker.nextNode() as Text | null)) lastText = curr;
    if (lastText) return { node: lastText, offset: lastText.textContent?.length ?? 0 };
  }
  return null;
}

export function getSelectionOffsets(root: HTMLElement, range: Range): { start: number; end: number; text: string } | null {
  const startTarget = getTextNodeAndOffset(range.startContainer, range.startOffset, false);
  const endTarget = getTextNodeAndOffset(range.endContainer, range.endOffset, true);
  if (!startTarget || !endTarget) return null;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let currentOffset = 0;
  let start = -1;
  let end = -1;
  let node: Text | null;

  while ((node = walker.nextNode() as Text | null)) {
    const len = node.textContent?.length ?? 0;
    if (start === -1 && node === startTarget.node) {
      start = currentOffset + startTarget.offset;
    }
    if (end === -1 && node === endTarget.node) {
      end = currentOffset + endTarget.offset;
      break;
    }
    currentOffset += len;
  }

  if (start >= 0 && end >= 0) {
    const fullText = getEditorFullText(root);
    return { start, end, text: fullText.slice(start, end) };
  }
  return null;
}

export function createRangeFromOffsets(root: HTMLElement, start: number, end: number): Range | null {
  if (start < 0 || end <= start) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let currentOffset = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;
  let node: Text | null;

  while ((node = walker.nextNode() as Text | null)) {
    const len = node.textContent?.length ?? 0;
    if (!startNode && currentOffset + len >= start) {
      startNode = node;
      startOffset = Math.max(0, start - currentOffset);
    }
    if (!endNode && currentOffset + len >= end) {
      endNode = node;
      endOffset = Math.min(len, end - currentOffset);
      break;
    }
    currentOffset += len;
  }

  if (startNode && endNode) {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }
  return null;
}

function findTextChange(oldText: string, newText: string) {
  let start = 0;
  while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) {
    start++;
  }
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const delta = (newEnd - start) - (oldEnd - start);
  return { start, oldEnd, newEnd, delta };
}

function findClosestMatch(text: string, query: string, targetIndex: number, maxDist = 2000): { start: number; end: number } | null {
  if (!query || !text) return null;
  const qLower = query.toLowerCase();
  const tLower = text.toLowerCase();
  let bestPos = -1;
  let bestDist = Infinity;
  let from = 0;

  while (from < tLower.length) {
    const idx = tLower.indexOf(qLower, from);
    if (idx === -1) break;
    const dist = Math.abs(idx - targetIndex);
    if (dist < bestDist && dist <= maxDist) {
      bestDist = dist;
      bestPos = idx;
    }
    from = idx + 1;
  }

  if (bestPos >= 0) {
    return { start: bestPos, end: bestPos + query.length };
  }
  return null;
}

function mapHighlight(
  start: number,
  end: number,
  quote: string,
  change: { start: number; oldEnd: number; newEnd: number; delta: number },
  newText: string
): { newStart: number; newEnd: number; newQuote: string; changed: boolean } {
  const { start: chStart, oldEnd: chOldEnd, delta } = change;
  let newStart = start;
  let newEnd = end;

  if (chOldEnd <= start) {
    newStart = Math.max(0, start + delta);
    newEnd = Math.max(newStart, end + delta);
  } else if (chStart >= end) {
    newStart = start;
    newEnd = end;
  } else if (chStart >= start && chOldEnd <= end) {
    newStart = start;
    newEnd = Math.max(newStart, end + delta);
  } else {
    newStart = Math.max(0, start + delta);
    newEnd = Math.max(newStart, end + delta);
  }

  let newQuote = newText.slice(newStart, newEnd);
  if (quote && newQuote !== quote) {
    const nearby = findClosestMatch(newText, quote, newStart, 50 + Math.abs(delta));
    if (nearby) {
      newStart = nearby.start;
      newEnd = nearby.end;
      newQuote = quote;
    }
  }

  const changed = newStart !== start || newEnd !== end || (Boolean(newQuote) && newQuote !== quote);
  return { newStart, newEnd, newQuote: newQuote || quote, changed };
}

const noLiveMode = { setLive() {}, isLive: () => false, flush() {}, dispose() {} };

/**
 * Stands in for the live connection when a guest reads a page: loads the page once over HTTP, then again when the
 * tab is shown after a while (a few minutes at most), applying what's new. Same surface as the live provider
 * (sync event, awareness, destroy) for the parts of the editor that use it, but nothing is ever sent.
 */
function snapshotProvider(doc: Y.Doc, pageId: string): YProvider {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const awareness = new Awareness(doc);
  awareness.setLocalState(null); // a guest is not announced to anyone
  let stopped = false;
  const load = () =>
    api.pageSnapshot(pageId).then(
      (bytes) => {
        if (stopped) return;
        Y.applyUpdate(doc, bytes, 'snapshot');
        listeners.get('sync')?.forEach((fn) => fn(true));
      },
      () => undefined
    );
  void load();
  // once more shortly after opening: the author's last few seconds of typing may still have been on their way to the room
  const again = setTimeout(() => void load(), 4000);
  const stopPolling = pollWhenVisible(() => void load(), 180_000, 60_000);
  return {
    awareness,
    on: (event: string, fn: (...args: any[]) => void) => (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(fn),
    off: (event: string, fn: (...args: any[]) => void) => listeners.get(event)?.delete(fn),
    destroy: () => {
      stopped = true;
      clearTimeout(again);
      stopPolling();
      awareness.destroy();
    },
  } as unknown as YProvider;
}

/**
 * One page: a Yjs document synced through the page's Durable Object. The
 * title and emoji are fields in the same document, so they sync like the
 * body. Mount with `key={pageId}` so each page gets a fresh connection.
 */
export function PageEditor({ pageId, me, canEdit, canComment, dark, onTitle, onIcon, onMessage, onEditor, onComment, onError }: Props) {
  // A guest (not signed in) reads a snapshot fetched over HTTP and opens no live connection, so they send
  // nothing to the room and never show up in anyone's list of who is on the page.
  const guest = !me.accountId;
  const [{ doc, provider, liveMode }] = useState(() => {
    const doc = new Y.Doc();
    if (guest) return { doc, provider: snapshotProvider(doc, pageId), liveMode: noLiveMode };
    const provider = new YProvider(window.location.host, pageId, doc, {
      party: 'page-room',
      protocol: window.location.protocol === 'https:' ? 'wss' : 'ws',
    });
    // Quiet (batched edits, no cursors) until the room says two or more people are editing.
    const liveMode = attachLiveMode(provider, doc, canEdit);
    return { doc, provider, liveMode };
  });
  const meta = doc.getMap<string>('meta');
  const [title, setTitle] = useState('');
  const [icon, setIcon] = useState('');
  // How the page is typeset ('article': a serif reading layout), kept in the document so everyone sees it.
  const [layout, setLayout] = useState('');
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [synced, setSynced] = useState(false);
  const syncedRef = useRef(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState<number | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'edit' | 'read'>('edit');
  const [highlightComments, setHighlightComments] = useState<Comment[]>([]);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const lastDocTextRef = useRef<string>('');
  const pendingAnchorSaves = useRef<Map<string, { start: number; end: number; quote?: string; timer: any }>>(new Map());

  // What the server already has for each comment, so unchanged positions are never re-sent.
  // Moves are gathered and sent as one request: a single edit can shift every highlight below it.
  const savedAnchors = useRef<Map<string, string>>(new Map());
  const anchorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sendAnchors = useCallback(() => {
    clearTimeout(anchorTimer.current);
    const batch = [...pendingAnchorSaves.current].map(([id, v]) => ({ id, start: v.start, end: v.end, quote: v.quote }));
    pendingAnchorSaves.current.clear();
    for (let i = 0; i < batch.length; i += 40) {
      const part = batch.slice(i, i + 40);
      for (const a of part) savedAnchors.current.set(a.id, `${a.start}:${a.end}:${a.quote ?? ''}`);
      api.updateAnchors(pageId, part).catch(() => {});
    }
  }, [pageId]);
  const scheduleAnchorSave = useCallback((cid: string, start: number, end: number, quote?: string) => {
    // Only people who can edit move highlights on the server (they are the ones changing the text).
    if (!canEdit) return;
    if (savedAnchors.current.get(cid) === `${start}:${end}:${quote ?? ''}`) return;
    pendingAnchorSaves.current.set(cid, { start, end, quote, timer: undefined });
    clearTimeout(anchorTimer.current);
    anchorTimer.current = setTimeout(sendAnchors, 5000);
  }, [canEdit, sendAnchors]);

  const flushAnchorSaves = sendAnchors;
  useEffect(() => {
    window.addEventListener('pagehide', sendAnchors);
    return () => {
      window.removeEventListener('pagehide', sendAnchors);
      sendAnchors(); // leaving the page: don't lose highlight moves still waiting
    };
  }, [sendAnchors]);

  useEffect(() => {
    flushAnchorSaves();
    const editorEl = document.querySelector<HTMLElement>('.page .bn-editor');
    if (editorEl) {
      lastDocTextRef.current = getEditorFullText(editorEl);
    }
  }, [viewMode, flushAnchorSaves]);

  useEffect(() => {
    if (synced) {
      const editorEl = document.querySelector<HTMLElement>('.page .bn-editor');
      if (editorEl) {
        lastDocTextRef.current = getEditorFullText(editorEl);
      }
    }
  }, [synced]);

  useEffect(() => {
    const onMeta = () => {
      const t = meta.get('title') ?? '';
      const i = meta.get('icon') ?? '';
      setTitle(t);
      setIcon(i);
      setLayout(meta.get('layout') ?? '');
      // Until the document has synced, `meta` is empty: telling the sidebar then would blank
      // the page's title and icon there for as long as it takes to load.
      if (!syncedRef.current) return;
      onTitle?.(t);
      onIcon?.(i);
    };
    const onSync = (isSynced: boolean) => {
      syncedRef.current = isSynced;
      setSynced(isSynced);
      if (isSynced) onMeta();
    };
    const onAwareness = () => {
      const list: Peer[] = [];
      const seenIds = new Set<string>();
      provider.awareness.getStates().forEach((state, id) => {
        const u = state.user as Partial<Person> | undefined;
        const name = u?.name?.trim();
        // only signed-in people are listed (a guest has no account, and connects to nothing anyway)
        if (id !== doc.clientID && u && name && u.accountId?.trim()) {
          const key = u.accountId.trim();
          if (!seenIds.has(key)) {
            seenIds.add(key);
            list.push({ id, accountId: u.accountId?.trim(), name, color: u.color ?? '#888' });
          }
        }
      });
      setPeers(list);
    };
    const onCustom = (message: string) => {
      try {
        const notice = JSON.parse(message) as { type: string; live?: boolean; from?: string };
        if (notice.type === 'mode') return liveMode.setLive(!!notice.live);
        // The tab that made a change already has it.
        if (notice.from && notice.from === TAB_ID) return;
        onMessage?.(notice.type);
      } catch {
        // Not one of ours.
      }
    };
    meta.observe(onMeta);
    provider.on('sync', onSync);
    provider.on('custom-message', onCustom);
    provider.awareness.on('change', onAwareness);
    onMeta();
    return () => {
      meta.unobserve(onMeta);
      provider.off('sync', onSync);
      provider.off('custom-message', onCustom);
      provider.awareness.off('change', onAwareness);
      liveMode.dispose();
      provider.destroy();
      doc.destroy();
    };
    // The doc and provider live as long as this component (keyed by page).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The page's block layouts become a stylesheet that follows the shared document, so everyone sees the same arrangement.
  useEffect(() => {
    const layouts = doc.getMap<string>('layouts');
    const style = document.createElement('style');
    style.setAttribute('data-block-layouts', pageId);
    document.head.appendChild(style);
    const frag = doc.getXmlFragment('document-store');
    const apply = () => { style.textContent = layoutCss(doc); };
    layouts.observe(apply);
    frag.observeDeep(apply); // moving a block changes which blocks are neighbours
    apply();
    return () => {
      layouts.unobserve(apply);
      frag.unobserveDeep(apply);
      style.remove();
    };
  }, [doc, pageId]);

  const editor = useCreateBlockNote(
    withCollaboration({
      schema,
      collaboration: {
        provider,
        fragment: doc.getXmlFragment('document-store'),
        user: { accountId: me.accountId, name: me.name, color: me.color },
      },
      // Files go to the uploader's own storage; the server explains if there's none.
      uploadFile: async (file: File) => {
        try {
          return (await api.upload(pageId, file)).url;
        } catch (e) {
          onError(`${file.name}: ${errorText(e)}`);
          throw e;
        }
      },
    }),
    []
  ) as unknown as Editor;

  const editable = synced && canEdit && viewMode === 'edit';
  const [saveNote, setSaveNote] = useState('');
  const lastManualSave = useRef(0);
  // The editor's built-in undo (y-undo) ends up with an empty stack here, so the page keeps
  // its own history: one manager for the body, one for the title and icon. Both record every
  // change made in this browser (origin-agnostic) and none made by other people.
  const [undoMeta, undoBody] = useMemo(() => {
    const make = (scope: Y.Map<string> | Y.XmlFragment) => {
      const manager = new Y.UndoManager(scope, { captureTimeout: 600, trackedOrigins: new Set() });
      doc.on('beforeTransaction', (tr: Y.Transaction) => {
        if (tr.local && tr.origin !== manager) manager.trackedOrigins.add(tr.origin);
      });
      return manager;
    };
    return [make(doc.getMap('meta')), make(doc.getXmlFragment('document-store'))] as const;
  }, [doc]);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (synced) return setSlow(false);
    const t = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(t);
  }, [synced]);

  // Ctrl/Cmd+Z undo, Shift+Z / Ctrl+Y redo, Ctrl/Cmd+S save. Text inside the editor already has
  // its own undo; this covers the title (a plain textarea bound to the shared doc, which loses
  // the browser's undo) and focus anywhere else on the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (key === 's') {
        event.preventDefault();
        if (!synced) return setSaveNote('Not connected yet');
        flushAnchorSaves();
        if (!canEdit) return setSaveNote('Up to date');
        if (Date.now() - lastManualSave.current < 5000) return setSaveNote('Saved');
        lastManualSave.current = Date.now();
        setSaveNote('Saving…');
        api.saveVersion(pageId).then(
          () => setSaveNote('Saved'),
          (e) => (setSaveNote(''), onError(errorText(e))),
        );
        return;
      }
      const redo = (key === 'z' && event.shiftKey) || key === 'y';
      if (key !== 'z' && key !== 'y') return;
      if (!editable) return;
      if (target?.closest('.comment-editor, .comment-reply-editor, input')) return; // those keep their own history
      event.preventDefault();
      event.stopImmediatePropagation(); // before the editor's own (empty) undo swallows the key
      const manager = target?.classList.contains('title') ? undoMeta : undoBody;
      if (redo) manager.redo();
      else manager.undo();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [synced, canEdit, editable, pageId, undoMeta, undoBody, flushAnchorSaves, onError]);
  useEffect(() => {
    if (!saveNote || saveNote === 'Saving…') return;
    const t = setTimeout(() => setSaveNote(''), 2500);
    return () => clearTimeout(t);
  }, [saveNote]);
  // A read-only ProseMirror view still takes over mouse selection, and it can only
  // draw a selection while the DOM selection is already inside it. After the comment box
  // took the focus, text could no longer be selected, so no further highlight or comment.
  // Leave the mouse to the browser while reading.
  useEffect(() => {
    if (editable) return;
    const el = document.querySelector<HTMLElement>('.page .bn-editor');
    if (!el) return;
    // (A PDF viewer handles its own mouse, see PdfReader.)
    const keepNative = (event: MouseEvent) => {
      if (!(event.target instanceof Element && event.target.closest('.pdf-pages'))) event.stopPropagation();
    };
    el.addEventListener('mousedown', keepNative, true);
    return () => el.removeEventListener('mousedown', keepNative, true);
  }, [editable, synced]);

  // Kept stable: a new component on each render (cursor moves re-render this)
  // would remount the toolbar between mousedown and click.
  const commentRef = useRef(onComment);
  commentRef.current = onComment;
  const hasComment = !!onComment;
  const toolbar = useCallback(
    () => (
      <FormattingToolbar>
        {...getFormattingToolbarItems()}
        <ImageSizeButtons key="size" />
        <ColumnsButton key="columns" doc={doc} />
        {hasComment && <CommentButton key="comment" onClick={() => {
          const text = editor.getSelectedText();
          if (text) commentRef.current?.(text, undefined, 'yellow', 'highlight');
        }} />}
      </FormattingToolbar>
    ),
    [editor, hasComment, doc]
  );

  const members = useMemo(() => {
    const ownId = me.accountId?.trim();
    const list: Peer[] = guest ? [] : [{ id: -1, name: me.name, color: me.color }];
    peers.forEach((peer) => {
      if (!ownId || peer.accountId !== ownId) list.push(peer);
    });
    return list;
  }, [me, peers, guest]);

  // Handed out once the document has loaded, so blocks added from outside
  // (uploads, quotes) land in the real document.
  useEffect(() => {
    onEditor?.(synced ? editor : null);
    return () => onEditor?.(null);
  }, [editor, synced, onEditor]);

  useEffect(() => {
    const load = () => {
      api.comments(pageId).then(
        // A reload must not undo a highlight move that hasn't been saved yet (the saved
        // position and quote are stale, so the edited highlight would stop matching).
        (list) => setHighlightComments(list.map((c) => {
          const moved = pendingAnchorSaves.current.get(c.id);
          return moved ? { ...c, quote_start: moved.start, quote_end: moved.end, quote: moved.quote ?? c.quote } : c;
        })),
        () => setHighlightComments([]),
      );
    };
    load();
    window.addEventListener('cloud-doc-comments-changed', load);
    return () => window.removeEventListener('cloud-doc-comments-changed', load);
  }, [pageId]);

  useEffect(() => {
    const unsub = editor.onChange(() => {
      const editorEl = document.querySelector<HTMLElement>('.page .bn-editor');
      if (!editorEl) return;
      const newText = getEditorFullText(editorEl);
      const oldText = lastDocTextRef.current;
      lastDocTextRef.current = newText;
      if (!oldText || oldText === newText) return;

      const change = findTextChange(oldText, newText);
      setHighlightComments((currentList) => {
        let changedAny = false;
        const updated = currentList.map((c) => {
          if (c.quote_pdf_url || c.quote_start === null || c.quote_end === null) return c;
          const { newStart, newEnd, newQuote, changed } = mapHighlight(
            c.quote_start,
            c.quote_end,
            c.quote ?? '',
            change,
            newText
          );
          if (changed) {
            changedAny = true;
            scheduleAnchorSave(c.id, newStart, newEnd, newQuote);
            return { ...c, quote_start: newStart, quote_end: newEnd, quote: newQuote };
          }
          return c;
        });
        return changedAny ? updated : currentList;
      });
    });
    return () => unsub();
  }, [editor, scheduleAnchorSave]);

  useEffect(() => {
    const editorEl = document.querySelector<HTMLElement>(`.page .bn-editor`);
    if (!editorEl) return;
    // Overlays don't take the mouse (they'd block selecting text under a highlight), so
    // a plain click on highlighted text is matched against their rects instead.
    let hitRects: { id: string; left: number; top: number; right: number; bottom: number }[] = [];
    const onClick = (event: MouseEvent) => {
      if (window.getSelection()?.toString()) return;
      const hit = hitRects.find((r) => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom);
      if (hit) window.dispatchEvent(new CustomEvent('cloud-doc-peek-comment', { detail: { id: hit.id, left: event.clientX, top: hit.top, right: hit.right, bottom: hit.bottom, below: true } }));
    };
    editorEl.addEventListener('click', onClick);
    // Finding where each highlight sits means walking the document's text, so that happens
    // when the comments or the text change. Scrolling and resizing only re-read the rects of
    // the ranges found, and only the ones on screen are drawn.
    interface Placed { comment: Comment; range: Range; color: string; shape: string }
    let placed: Placed[] = [];
    const resolve = () => {
      placed = [];
      const fullText = getEditorFullText(editorEl);
      const lower = fullText.toLocaleLowerCase();
      for (const comment of highlightComments) {
        const needle = comment.quote?.trim();
        if (!needle || comment.quote_pdf_url) continue;
        let range: Range | null = null;
        if (comment.quote_start !== null && comment.quote_end !== null) {
          if (fullText.slice(comment.quote_start, comment.quote_end) === needle) {
            range = createRangeFromOffsets(editorEl, comment.quote_start, comment.quote_end);
          } else {
            const best = findClosestMatch(fullText, needle, comment.quote_start);
            if (best) {
              range = createRangeFromOffsets(editorEl, best.start, best.end);
              // Found again by its text: draw it there, but don't write it back. The offsets
              // shift whenever embedded content (PDF text, equations) finishes rendering.
              comment.quote_start = best.start;
              comment.quote_end = best.end;
            }
          }
        } else {
          const idx = lower.indexOf(needle.toLocaleLowerCase());
          if (idx >= 0) {
            range = createRangeFromOffsets(editorEl, idx, idx + needle.length);
            scheduleAnchorSave(comment.id, idx, idx + needle.length); // first time only: it had no position
            comment.quote_start = idx;
            comment.quote_end = idx + needle.length;
          }
        }
        if (!range) continue;
        placed.push({
          comment,
          range,
          color: COMMENT_COLORS.find((item) => item.value === comment.quote_color)?.color ?? '#facc15',
          shape: comment.quote_shape || 'highlight',
        });
      }
    };
    let layer = document.querySelector<HTMLElement>('.editor-highlight-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'editor-highlight-layer';
      document.body.appendChild(layer);
    }
    // Two parts: the highlight shapes, redrawn on every paint, and the margin cards, which are kept.
    const overlayLayer = document.createElement('div');
    const marginLayer = document.createElement('div');
    layer.replaceChildren(overlayLayer, marginLayer);
    const margin = new Map<string, HTMLButtonElement>();
    const paint = () => {
      hitRects = [];
      const fragment = document.createDocumentFragment();
      const viewport = window.innerHeight;
      for (const { comment, range, color, shape } of placed) {
        for (const rect of range.getClientRects()) {
          if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > viewport) continue;
          const overlay = document.createElement('div');
          overlay.className = `editor-comment-highlight-overlay shape-${shape}${comment.thread_id === activeThread ? ' is-active' : ''}`;
          overlay.dataset.threadId = comment.thread_id;
          overlay.dataset.commentId = comment.id;
          overlay.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;--highlight-color:${color}${shape === 'highlight' ? `;background:${color}66` : ''}`;
          hitRects.push({ id: comment.id, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
          fragment.appendChild(overlay);
        }
      }
      // The right margin: for each highlight with written comments, a short card (who said what, and how many
      // replies) beside the text it is about. Clicking one opens the full card in the panel. Where the margin is
      // too narrow for cards, a numbered bubble stands in.
      // The margin comments live in the layout's right column (see .right-col), which the open panel replaces. With
      // no such column (a small window) there is only the numbered bubble beside the text.
      const column = document.querySelector<HTMLElement>('.right-col');
      const columnRect = column?.getBoundingClientRect();
      const showCards = !!columnRect && columnRect.width >= 240 && !column?.classList.contains('has-panel');
      const hideAll = !!column?.classList.contains('has-panel');
      const editorRect = editorEl.getBoundingClientRect();
      const contentRight = editorRect.right - (parseFloat(getComputedStyle(editorEl).paddingRight) || 0);
      const left = showCards ? columnRect!.left + 14 : contentRight + 10;
      const room = showCards ? columnRect!.width - 28 : 0;
      const entries: { thread: string; commentId: string; top: number; height: number }[] = [];
      const seen = new Set<string>();
      for (const { comment, range } of placed) {
        if (seen.has(comment.thread_id)) continue;
        const first = range.getClientRects()[0];
        if (!first || first.bottom < 0 || first.top > viewport) continue;
        seen.add(comment.thread_id);
        entries.push({ thread: comment.thread_id, commentId: comment.id, top: first.top, height: first.height });
      }
      // highlights on PDFs: beside the mark inside the viewer, while it is in view
      for (const c of highlightComments) {
        if (!c.quote_pdf_url || c.id !== c.thread_id || seen.has(c.thread_id)) continue;
        const mark = document.querySelector<HTMLElement>(`.pdf-highlight[data-thread-id="${CSS.escape(c.thread_id)}"]`);
        const rect = mark?.getBoundingClientRect();
        const clip = mark?.closest('.pdf-pages')?.getBoundingClientRect();
        if (!rect || !clip || rect.bottom < clip.top || rect.top > clip.bottom || rect.bottom < 0 || rect.top > viewport) continue;
        seen.add(c.thread_id);
        entries.push({ thread: c.thread_id, commentId: c.id, top: rect.top, height: rect.height });
      }
      if (hideAll) entries.length = 0;
      entries.sort((x, y) => x.top - y.top);
      const CARD = 48;
      let nextFree = -Infinity;
      const wanted = new Set<string>();
      for (const entry of entries) {
        const written = highlightComments.filter((c) => c.thread_id === entry.thread && c.body.trim()).sort((x, y) => x.created_at - y.created_at);
        if (!written.length) continue;
        const root = highlightComments.find((c) => c.id === entry.thread);
        const active = entry.thread === activeThread;
        const cardMode = showCards;
        const key = `${cardMode ? 'card' : 'bubble'}:${entry.thread}`;
        let top = entry.top + entry.height / 2 - (cardMode ? CARD / 2 : 11);
        if (cardMode) {
          top = Math.max(top, nextFree);
          nextFree = top + CARD + 6;
          if (top > viewport) continue;
        }
        wanted.add(key);
        // These are updated in place, never rebuilt: a click is a mouse-down and a mouse-up on the same element,
        // and repainting between them (a hover animation ending, a scroll) used to swallow the click.
        let el = margin.get(key);
        if (!el) {
          el = document.createElement('button');
          el.type = 'button';
          el.addEventListener('click', () => {
            if (!el!.dataset.commentId) return;
            const r = el!.getBoundingClientRect();
            window.dispatchEvent(new CustomEvent('cloud-doc-peek-comment', { detail: { id: el!.dataset.commentId, left: r.left, top: r.top, right: r.right, bottom: r.bottom } }));
          });
          margin.set(key, el);
          marginLayer.appendChild(el);
        }
        el.dataset.commentId = entry.commentId;
        el.classList.toggle('is-active', active);
        if (cardMode) {
          el.className = `comment-brief${active ? ' is-active' : ''}`;
          el.style.cssText = `left:${left}px;top:${top}px;width:${Math.min(room, 340)}px;height:${CARD}px;--brief-color:${COMMENT_COLORS.find((item) => item.value === root?.quote_color)?.color ?? '#facc15'}`;
          const label = `${written[0]!.author_name.split(' ')[0] ?? ''}\u0000${briefText(written[0]!.body)}\u0000${written.length}`;
          if (el.dataset.label !== label) {
            el.dataset.label = label;
            const count = document.createElement('em');
            count.textContent = String(written.length);
            const who = document.createElement('b');
            who.textContent = written[0]!.author_name.split(' ')[0] ?? '';
            const said = document.createElement('span');
            said.textContent = ` ${briefText(written[0]!.body)}`;
            const line = document.createElement('span');
            line.className = 'comment-brief-text';
            line.appendChild(count);
            line.appendChild(who);
            line.appendChild(said);
            el.replaceChildren(line);
            el.setAttribute('aria-label', `Comment by ${written[0]!.author_name}: ${briefText(written[0]!.body)}`);
          }
        } else {
          el.className = `comment-bubble${active ? ' is-active' : ''}`;
          el.style.cssText = `left:${Math.min(contentRight + 8, window.innerWidth - 40)}px;top:${top}px`;
          el.dataset.label = '';
          el.textContent = String(written.length);
          el.setAttribute('aria-label', `${written.length} comment${written.length === 1 ? '' : 's'}`);
        }
      }
      for (const [key, el] of margin) {
        if (wanted.has(key)) continue;
        el.remove();
        margin.delete(key);
      }
      overlayLayer.replaceChildren(fragment);
    };
    // A pointer over highlighted text says it can be opened.
    const onMove = (event: MouseEvent) => {
      const over = hitRects.some((r) => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom);
      editorEl.classList.toggle('over-highlight', over);
    };
    editorEl.addEventListener('mousemove', onMove);
    // Tell the Highlights panel where each highlight is in the document (its order by position).
    let publishedPositions = '';
    let publishedMargin = -1;
    const publishPositions = () => {
      const base = editorEl.getBoundingClientRect().top;
      const map: Record<string, number> = {};
      for (const { comment, range } of placed) {
        const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
        if (r) map[comment.thread_id] = Math.round(r.top - base);
      }
      for (const c of highlightComments) {
        if (!c.quote_pdf_url || c.id !== c.thread_id) continue;
        const mark = document.querySelector<HTMLElement>(`.pdf-highlight[data-thread-id="${CSS.escape(c.thread_id)}"]`);
        if (mark) map[c.thread_id] = Math.round(mark.getBoundingClientRect().top - base);
      }
      const withWords = Object.keys(map).filter((id) => highlightComments.some((c) => c.thread_id === id && c.body.trim())).length;
      if (withWords !== publishedMargin) {
        publishedMargin = withWords;
        window.dispatchEvent(new CustomEvent('cloud-doc-margin', { detail: withWords }));
      }
      const text = JSON.stringify(map);
      if (text === publishedPositions) return;
      publishedPositions = text;
      highlightPositions.current = map;
      window.dispatchEvent(new CustomEvent('cloud-doc-highlight-positions'));
    };
    let frame = 0;
    let needResolve = false;
    const schedule = (again = false) => {
      needResolve ||= again;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const changed = needResolve;
        if (needResolve) resolve();
        needResolve = false;
        paint();
        if (changed) publishPositions();
      });
    };
    resolve();
    paint();
    publishPositions();
    // Anything that moves the text (scrolling the page, resizing, the side panel opening or
    // closing, images loading) repaints; edits find the highlights again first.
    const onScroll = (event: Event) => {
      const t = event.target;
      if (t === document || (t instanceof Node && (t.contains(editorEl) || editorEl.contains(t)))) schedule();
    };
    const repaint = () => schedule();
    const marksDrawn = () => requestAnimationFrame(() => { publishPositions(); schedule(); });
    window.addEventListener('cloud-doc-marks-drawn', marksDrawn);
    // Layout has just changed when this runs and nothing has been drawn yet: paint now, not a frame later.
    const observer = new ResizeObserver(() => {
      paint();
      // the text may have just arrived or been re-laid-out: find the highlights again, then tell the panel where they are
      schedule(true);
    });
    observer.observe(editorEl);
    const layout = editorEl.closest('.page-layout');
    if (layout) observer.observe(layout);
    window.addEventListener('resize', repaint);
    document.addEventListener('scroll', onScroll, true);
    const onTransition = (event: Event) => {
      if (!(event.target instanceof Node && layer.contains(event.target))) schedule();
    };
    window.addEventListener('transitionend', onTransition, true);
    const unsubscribe = editor.onChange(() => schedule(true));
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      editorEl.removeEventListener('click', onClick);
      editorEl.removeEventListener('mousemove', onMove);
      editorEl.classList.remove('over-highlight');
      observer.disconnect();
      window.removeEventListener('resize', repaint);
      window.removeEventListener('cloud-doc-marks-drawn', marksDrawn);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('transitionend', onTransition, true);
      layer.replaceChildren();
      margin.clear();
    };
  }, [highlightComments, synced, activeThread, editor, scheduleAnchorSave, editable]);

  // Jump to a search result: find the matching occurrence in the page text, scroll to it and mark it.
  useEffect(() => {
    if (!synced) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fold = (t: string) => Array.from(t, (c) => { const b = c.normalize('NFD')[0] ?? c; const l = b.toLowerCase(); return l.length === b.length ? l : b; }).join('');
    let current: ReturnType<typeof takeFind> = null;
    const run = (attempt = 0) => {
      const request = current ?? takeFind(pageId);
      current = request;
      const editorEl = document.querySelector<HTMLElement>('.page .bn-editor');
      if (!request || !editorEl) return;
      const text = getEditorFullText(editorEl);
      const folded = fold(text);
      const escape = (w: string) => fold(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // No word-start check: this text has no gaps between blocks, so a word starting a block looks mid-word.
      // The occurrence number can then differ from the server's, which is why the context is compared too.
      const pattern = new RegExp(`(?:${request.words.map(escape).join('|')})[\\p{L}\\p{N}]*`, 'gu');
      const found = [...folded.matchAll(pattern)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
      const alnum = (t: string) => fold(t).replace(/[^\p{L}\p{N}]+/gu, '');
      const ctx = alnum(request.before).slice(-10);
      const sameContext = (at: { start: number }) => !ctx || alnum(text.slice(Math.max(0, at.start - 60), at.start)).endsWith(ctx);
      // The counts can differ a little (embedded content adds text), so check the context too.
      const exact = found[request.n] && sameContext(found[request.n]!) ? found[request.n] : found.find(sameContext);
      // The document renders in pieces after it syncs; until the right occurrence shows up, try again.
      if (!exact && attempt < 12) return void setTimeout(() => run(attempt + 1), 250);
      const hit = exact ?? found[0];
      current = null;
      if (!hit) return;
      const range = createRangeFromOffsets(editorEl, hit.start, hit.end);
      if (!range) return;
      const target = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : (range.startContainer as Element);
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
      const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
      if (registry && HighlightCtor) {
        registry.set('search-hit', new HighlightCtor(range));
        clearTimeout(timer);
        timer = setTimeout(() => registry.delete('search-hit'), 5000);
      } else {
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    };
    // The page may still be laying out (images, PDFs), so wait a beat.
    const later = () => setTimeout(() => run(), 250);
    const first = later();
    window.addEventListener('cloud-doc-find', later);
    return () => {
      clearTimeout(first);
      clearTimeout(timer);
      window.removeEventListener('cloud-doc-find', later);
    };
  }, [synced, pageId]);

  useEffect(() => {
    const onPdfComment = (event: Event) => {
      const detail = (event as CustomEvent<{
        text: string;
        page: number;
        rects: number[][];
        pdfUrl: string;
        color?: string;
        shape?: string;
        instant?: boolean;
      }>).detail;
      if (!detail?.text) return;
      if (detail.instant) {
        api.addComment(pageId, '', {
          quote: detail.text,
          quotePage: detail.page,
          quoteRects: detail.rects,
          quotePdfUrl: detail.pdfUrl,
          quoteColor: detail.color,
          quoteShape: detail.shape,
        }).then(() => {
          window.dispatchEvent(new CustomEvent('cloud-doc-comments-changed'));
        }).catch((err) => onError(errorText(err)));
      } else {
        onComment?.(detail.text, { page: detail.page, rects: detail.rects, pdfUrl: detail.pdfUrl }, detail.color, detail.shape);
      }
    };
    window.addEventListener('cloud-doc-pdf-comment', onPdfComment);
    return () => window.removeEventListener('cloud-doc-pdf-comment', onPdfComment);
  }, [onComment, pageId, onError]);

  useEffect(() => {
    let clearTimer: ReturnType<typeof setTimeout> | undefined;
    const showEditorAnnotation = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; text?: string; ack?: { ok: boolean } }>).detail;
      if (!detail) return;
      const editorEl = document.querySelector<HTMLElement>(`.page .bn-editor`);
      if (!editorEl) return;
      const comment = highlightComments.find((c) => (detail.id && (c.id === detail.id || c.thread_id === detail.id)) || (detail.text && c.quote?.includes(detail.text)));
      const fullText = getEditorFullText(editorEl);
      const needle = comment?.quote ?? detail.text;
      let range: Range | null = null;
      if (comment && comment.quote_start !== null && comment.quote_end !== null && fullText.slice(comment.quote_start, comment.quote_end) === needle) {
        range = createRangeFromOffsets(editorEl, comment.quote_start, comment.quote_end);
      } else if (needle) {
        const near = findClosestMatch(fullText, needle, comment?.quote_start ?? 0, Number.MAX_SAFE_INTEGER);
        if (near) range = createRangeFromOffsets(editorEl, near.start, near.end);
      }
      if (!range) return;
      if (detail.ack) detail.ack.ok = true;
      // The overlays are fixed-position, so scroll the text itself, then flash the highlight.
      const target = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : (range.startContainer as Element);
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setActiveThread(comment?.thread_id ?? null);
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => setActiveThread(null), 2500);
    };
    window.addEventListener('cloud-doc-show-editor-annotation', showEditorAnnotation);
    return () => {
      clearTimeout(clearTimer);
      window.removeEventListener('cloud-doc-show-editor-annotation', showEditorAnnotation);
    };
  }, [highlightComments]);

  return (
    <div className={`${synced ? 'page' : 'page is-loading'}${layout === 'article' ? ' is-article' : ''}`} aria-busy={!synced}>
      {!synced && (
        <div className="page-loading" role="status">
          <Loader size="md" />
          <Text size="sm" c="dimmed">{slow ? 'Still connecting… check your network' : 'Loading page…'}</Text>
        </div>
      )}
      <Group justify="space-between" className="page-bar">
        <Text size="xs" c="dimmed">
          {!synced ? 'Connecting…' : saveNote || (guest ? 'Shared page' : editable ? 'Live · editing' : 'Live · reading')}
        </Text>
        <Group gap="sm">
          {canEdit && synced && (
            <Popover opened={layoutOpen} onChange={setLayoutOpen} position="bottom-end" shadow="md" withinPortal>
              <Popover.Target>
                <Tooltip label="Page layout">
                  <ActionIcon variant={layout ? 'light' : 'subtle'} color={layout ? undefined : 'gray'} size="md" aria-label="Page layout" onClick={() => setLayoutOpen((o) => !o)}>
                    <IconArticle size={18} />
                  </ActionIcon>
                </Tooltip>
              </Popover.Target>
              <Popover.Dropdown w={260}>
                <Stack gap="xs">
                  <Text size="sm" fw={600}>Page layout</Text>
                  <SegmentedControl
                    size="xs"
                    value={layout || 'standard'}
                    onChange={(v) => (v === 'article' ? meta.set('layout', 'article') : meta.delete('layout'))}
                    data={[{ value: 'standard', label: 'Standard' }, { value: 'article', label: 'Article' }]}
                  />
                  <Text size="xs" c="dimmed">
                    Article sets the page in a serif reading layout. Select a picture to float it left or right so the text wraps around it; its caption sits beneath it.
                  </Text>
                </Stack>
              </Popover.Dropdown>
            </Popover>
          )}
          {canEdit && synced && (
            <SegmentedControl size="xs" value={viewMode} onChange={(value) => setViewMode(value as 'edit' | 'read')} data={[{ value: 'edit', label: 'Edit' }, { value: 'read', label: 'Read' }]} />
          )}
          {members.length > 0 && (
            <Avatar.Group>
              {members.slice(0, 3).map((p) => (
              <Popover
                key={p.id}
                opened={selectedMemberId === p.id}
                onChange={(opened) => setSelectedMemberId(opened ? p.id : null)}
                position="bottom-end"
                shadow="md"
                withinPortal
              >
                <Popover.Target>
                  <UnstyledButton
                    aria-label={`${p.name} member details`}
                  >
                    <Tooltip label={p.name} withArrow>
                      <Avatar size="sm" radius="xl" color={p.color} variant="filled" styles={{ root: { background: p.color } }}>
                        {p.name.slice(0, 1).toUpperCase()}
                      </Avatar>
                    </Tooltip>
                  </UnstyledButton>
                </Popover.Target>
                <Popover.Dropdown w={220}>
                  <Stack gap={4}>
                    <Text fw={600} size="sm">{p.name}</Text>
                    <Text size="xs" c="dimmed">{p.id === -1 ? 'You · Viewing this page' : 'Viewing this page'}</Text>
                    <Text size="xs" c="dimmed">{p.id === -1 ? 'Local participant' : 'Live collaborator'}</Text>
                  </Stack>
                </Popover.Dropdown>
              </Popover>
              ))}
              {members.length > 3 && (
              <Popover opened={overflowOpen} onChange={setOverflowOpen} position="bottom-end" shadow="md" withinPortal>
                <Popover.Target>
                  <UnstyledButton aria-label={`View ${members.length - 3} more members`}>
                    <Avatar size="sm" radius="xl" color="gray" variant="filled">
                      +{members.length - 3}
                    </Avatar>
                  </UnstyledButton>
                </Popover.Target>
                <Popover.Dropdown w={220}>
                  <Stack gap="xs">
                    {members.slice(3).map((p) => (
                      <Group key={p.id} gap="sm" wrap="nowrap">
                        <Avatar size="sm" radius="xl" color={p.color} variant="filled" styles={{ root: { background: p.color } }}>
                          {p.name.slice(0, 1).toUpperCase()}
                        </Avatar>
                        <div>
                          <Text size="sm" fw={500}>{p.name}</Text>
                          <Text size="xs" c="dimmed">Viewing this page</Text>
                        </div>
                      </Group>
                    ))}
                  </Stack>
                </Popover.Dropdown>
              </Popover>
              )}
            </Avatar.Group>
          )}
        </Group>
      </Group>
      <div className="title-row">
        <IconPicker icon={icon} editable={editable} onPick={(i) => (i ? meta.set('icon', i) : meta.delete('icon'))} />
        <textarea
          className="title"
          placeholder="Untitled"
          rows={1}
          value={title}
          readOnly={!editable}
          onChange={(e) => meta.set('title', e.target.value.replace(/\n/g, ' '))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              editor.focus();
            }
          }}
          ref={(el) => {
            if (el) (el.style.height = 'auto'), (el.style.height = `${el.scrollHeight}px`);
          }}
        />
      </div>
      <PageContext.Provider value={{ pageId, canComment: canComment && !!onComment }}>
      <BlockNoteView editor={editor} theme={dark ? 'dark' : 'light'} editable={editable} formattingToolbar={false} slashMenu={false}>
        {editable && <FormattingToolbarController formattingToolbar={toolbar} />}
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(
              [
                ...getDefaultReactSlashMenuItems(editor),
                {
                  title: 'PDF',
                  subtext: 'Embed a PDF document',
                  aliases: ['pdf', 'document', 'embed'],
                  group: 'Media',
                  icon: <IconFileTypePdf size={18} />,
                  onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'pdf', props: { pageId, commentable: canComment } }),
                },
                {
                  title: 'LaTeX',
                  subtext: 'Insert a rendered LaTeX equation',
                  aliases: ['latex', 'math', 'equation'],
                  group: 'Media',
                  onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'latex', props: { source: '' } }),
                },
                {
                  title: 'Inline LaTeX',
                  subtext: 'Insert LaTeX inside text, including table cells',
                  aliases: ['inline', 'math', 'equation'],
                  group: 'Media',
                  onItemClick: () => editor.insertInlineContent([{ type: 'latex-inline', props: { source: '' } }]),
                },
              ],
              query
            )
          }
        />
      </BlockNoteView>
      </PageContext.Provider>
      {synced && <ColumnsLayer editor={editor} doc={doc} canEdit={editable} />}
      {canComment && onComment && (!canEdit || viewMode === 'read') && (
        <SelectionComment editor={editor} onComment={onComment} pageId={pageId} onError={onError} />
      )}
    </div>
  );
}

/** For a selected picture or video: its width, as presets (dragging its edges still works for anything in between). */
function ImageSizeButtons() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor<any, any, any>();
  const blocks = useSelectedBlocks(editor);
  const block = blocks.length === 1 ? blocks[0] : undefined;
  if (!block || !editor.isEditable || (block.type !== 'image' && block.type !== 'video')) return null;
  const width = Number((block.props as { previewWidth?: number }).previewWidth) || 512;
  const sizes = [
    { label: 'Small', text: 'S', px: 240 },
    { label: 'Medium', text: 'M', px: 400 },
    { label: 'Large', text: 'L', px: 640 },
    // wider than any column: the picture then fills the width it is given
    { label: 'Full width', text: 'XL', px: 4000 },
  ];
  const nearest = sizes.reduce((best, o) => (Math.abs(o.px - width) < Math.abs(best.px - width) ? o : best));
  return (
    <>
      {sizes.map((o) => (
        <Components.FormattingToolbar.Button
          key={o.label}
          className="bn-button"
          label={`${o.label} picture`}
          mainTooltip={`${o.label}${o.px < 4000 ? ` (${o.px}px)` : ''}`}
          icon={<span style={{ fontSize: 12, fontWeight: 700, width: 18, textAlign: 'center' }}>{o.text}</span>}
          isSelected={nearest === o}
          onClick={() => editor.updateBlock(block, { props: { previewWidth: o.px } } as any)}
        />
      ))}
    </>
  );
}

/**
 * Columns, the way Anytype does it: drag a block to the left or right edge of another block and the two sit side by
 * side in a row; drag the gap between columns to resize them; drag a block back between rows to stack it again.
 * (There is no text wrapping, so nothing flows around anything and layouts can't fight each other.)
 *
 * A row is a run of neighbouring top-level blocks that share a row id. That, and each column's width in twelfths of
 * the page column, is kept in the document next to the text by block id (not inside the blocks), so it works for
 * every kind of block, everyone sees it live, and pages that never use columns are untouched. Phones show every
 * block full width.
 */
interface Slot {
  /** row id */
  r: string;
  /** width in twelfths; all columns of a row have one and they add up to 12, or none (equal widths) */
  s?: number;
}

const MAX_COLUMNS = 4;
const MIN_SPAN = 2;

const parseSlot = (raw: string | undefined): Slot | null => {
  try {
    const v = JSON.parse(raw ?? 'null') as Slot | null;
    return v && typeof v.r === 'string' && v.r ? { r: v.r.slice(0, 40), s: typeof v.s === 'number' ? Math.round(v.s) : undefined } : null;
  } catch {
    return null;
  }
};

interface PlacedRow {
  id: string;
  /** block ids, left to right */
  members: string[];
  /** twelfths per member */
  spans: number[];
}

/** The rows of a page, from the document's block order and its slots. Runs of one block are not rows. */
export function placedRows(doc: Y.Doc): PlacedRow[] {
  const layouts = doc.getMap<string>('layouts');
  if (layouts.size === 0) return [];
  const group = doc.getXmlFragment('document-store').get(0);
  if (!(group instanceof Y.XmlElement)) return [];
  const rows: PlacedRow[] = [];
  let run: { id: string; ids: string[]; slots: Slot[] } | null = null;
  const close = () => {
    if (run && run.ids.length >= 2 && run.ids.length <= MAX_COLUMNS) {
      const given = run.slots.map((x) => x.s);
      const ok = given.every((v) => typeof v === 'number' && v >= MIN_SPAN) && given.reduce<number>((a, b) => a + (b ?? 0), 0) === 12;
      rows.push({ id: run.id, members: run.ids, spans: ok ? (given as number[]) : run.ids.map(() => 12 / run!.ids.length) });
    }
    run = null;
  };
  for (const child of group.toArray()) {
    const id = child instanceof Y.XmlElement ? String(child.getAttribute('id') ?? '') : '';
    const slot = id ? parseSlot(layouts.get(id)) : null;
    if (!slot) {
      close();
      continue;
    }
    if (run && run.id === slot.r) {
      run.ids.push(id);
      run.slots.push(slot);
    } else {
      close();
      run = { id: slot.r, ids: [id], slots: [slot] };
    }
  }
  close();
  return rows;
}

/** The stylesheet that lays the rows out: the page's top-level blocks become a 12-column grid, and each column spans its share. */
export function layoutCss(doc: Y.Doc): string {
  const rows = placedRows(doc);
  if (!rows.length) return '';
  const rules = ['.page .bn-editor > .bn-block-group{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));column-gap:28px;align-items:start}', '.page .bn-editor > .bn-block-group > .bn-block-outer{grid-column:1/-1;min-width:0}'];
  for (const row of rows) {
    row.members.forEach((id, i) => {
      if (/^[\w-]{1,80}$/.test(id)) rules.push(`.page .bn-editor > .bn-block-group > .bn-block-outer[data-id="${id}"]{grid-column:${i === 0 ? '1 / ' : ''}span ${row.spans[i]}}`);
    });
  }
  // On a phone the columns stack. While editing, a bar on the left shows which blocks belong to one row.
  const marks: string[] = [];
  for (const row of rows) {
    row.members.forEach((id, i) => {
      if (!/^[\w-]{1,80}$/.test(id)) return;
      const sel = `.page .bn-editor[contenteditable="true"] > .bn-block-group > .bn-block-outer[data-id="${id}"]`;
      marks.push(`${sel}{border-left:3px solid color-mix(in srgb, var(--accent) 55%, transparent);padding-left:10px;margin-left:2px}`);
      if (i === 0) marks.push(`${sel}::before{content:'Columns \\00B7 side by side on wider screens';display:block;font:600 10.5px/1.6 var(--mantine-font-family);color:var(--muted);letter-spacing:.02em}`);
    });
  }
  return `@media (min-width: 48.01em){${rules.join('')}}@media (max-width: 48em){${marks.join('')}}`;
}

/** ProseMirror draws its own drop line while a block is dragged; when we take the drop over, it has to be told to let go. */
const clearDropCursor = () => document.querySelector('.page .bn-editor')?.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));

const topBlocks = () => [...document.querySelectorAll<HTMLElement>('.page .bn-editor > .bn-block-group > .bn-block-outer')];

/** Puts `moved` beside `target` (left or right), in the target's row if it has one, with equal widths. */
function dropBeside(editor: BlockNoteEditor<any, any, any>, doc: Y.Doc, movedId: string, targetId: string, side: 'left' | 'right'): void {
  const layouts = doc.getMap<string>('layouts');
  const row = placedRows(doc).find((r) => r.members.includes(targetId));
  const rowId = row?.id ?? crypto.randomUUID().slice(0, 8);
  const moved = editor.getBlock(movedId);
  const target = editor.getBlock(targetId);
  if (!moved || !target) return;
  doc.transact(() => {
    editor.removeBlocks([moved]);
    editor.insertBlocks([moved as any], target, side === 'left' ? 'before' : 'after');
    // everyone in the row goes back to equal widths
    for (const id of row?.members ?? [targetId]) layouts.set(id, JSON.stringify({ r: rowId }));
    layouts.set(movedId, JSON.stringify({ r: rowId }));
  });
  // the move drops the selection; keep the cursor in the block that was moved
  try {
    editor.setTextCursorPosition(movedId, 'end');
  } catch {
    /* a block without text (a picture) has no cursor */
  }
}

function leaveRow(doc: Y.Doc, id: string): void {
  const layouts = doc.getMap<string>('layouts');
  const row = placedRows(doc).find((r) => r.members.includes(id));
  doc.transact(() => {
    layouts.delete(id);
    if (row && row.members.length === 2) for (const other of row.members) layouts.delete(other); // a lone column is just a block
    else if (row) for (const other of row.members.filter((m) => m !== id)) layouts.set(other, JSON.stringify({ r: row.id }));
  });
}

/** The drag-and-drop part: a drop line on the edge being aimed at, the drop itself, and handles to resize columns. */
function ColumnsLayer({ editor, doc, canEdit }: { editor: BlockNoteEditor<any, any, any>; doc: Y.Doc; canEdit: boolean }) {
  const phone = useMediaQuery('(max-width: 48em)');
  const [hint, setHint] = useState<{ top: number; left: number; height: number } | null>(null);
  const [handles, setHandles] = useState<{ row: PlacedRow; index: number; x: number; top: number; height: number }[]>([]);
  const dragged = useRef<string | null>(null);

  // Handles sit in the gaps between the columns of each row.
  const measure = useCallback(() => {
    const rows = placedRows(doc);
    const out: typeof handles = [];
    for (const row of rows) {
      const boxes = row.members.map((id) => document.querySelector<HTMLElement>(`.page .bn-block-outer[data-id="${id}"]`)?.getBoundingClientRect());
      for (let i = 0; i < boxes.length - 1; i++) {
        const a = boxes[i];
        const b = boxes[i + 1];
        if (!a || !b) continue;
        out.push({ row, index: i, x: (a.right + b.left) / 2, top: Math.min(a.top, b.top), height: Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top) });
      }
    }
    setHandles(out);
  }, [doc]);
  useEffect(() => {
    const layouts = doc.getMap<string>('layouts');
    const frag = doc.getXmlFragment('document-store');
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    layouts.observe(later);
    if (layouts.size) frag.observeDeep(later);
    const unsub = editor.onChange(later);
    window.addEventListener('resize', later);
    window.addEventListener('scroll', later, true);
    later();
    return () => {
      layouts.unobserve(later);
      frag.unobserveDeep(later);
      unsub();
      window.removeEventListener('resize', later);
      window.removeEventListener('scroll', later, true);
      cancelAnimationFrame(frame);
    };
  }, [doc, editor, measure]);

  // Drag a block (by BlockNote's own handle) to a block's left or right edge.
  useEffect(() => {
    if (!canEdit || phone) return;
    const rowSizeOf = (id: string) => placedRows(doc).find((r) => r.members.includes(id))?.members.length ?? 1;
    const aim = (e: DragEvent): { id: string; side: 'left' | 'right'; rect: DOMRect } | null => {
      const moved = dragged.current;
      if (!moved) return null;
      for (const el of topBlocks()) {
        const r = el.getBoundingClientRect();
        if (e.clientY < r.top || e.clientY > r.bottom) continue;
        const id = el.getAttribute('data-id') ?? '';
        if (!id || id === moved) return null;
        const edge = Math.min(64, r.width * 0.2);
        const side = e.clientX <= r.left + edge && e.clientX >= r.left - 60 ? 'left' : e.clientX >= r.right - edge && e.clientX <= r.right + 60 ? 'right' : null;
        if (!side) return null;
        const inRow = placedRows(doc).find((x) => x.members.includes(id));
        if (!inRow?.members.includes(moved) && rowSizeOf(id) >= MAX_COLUMNS) return null;
        return { id, side, rect: r };
      }
      return null;
    };
    const onStart = () => {
      try {
        dragged.current = editor.getTextCursorPosition().block.id;
      } catch {
        dragged.current = null;
      }
    };
    const onOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('blocknote/html')) return;
      const hit = aim(e);
      if (!hit) return setHint(null);
      clearDropCursor();
      e.preventDefault();
      e.stopPropagation();
      setHint({ left: hit.side === 'left' ? hit.rect.left - 14 : hit.rect.right + 12, top: hit.rect.top, height: hit.rect.height });
    };
    const onDrop = (e: DragEvent) => {
      const hit = e.dataTransfer?.types.includes('blocknote/html') ? aim(e) : null;
      setHint(null);
      if (!hit || !dragged.current) return;
      e.preventDefault();
      e.stopPropagation();
      clearDropCursor();
      dropBeside(editor, doc, dragged.current, hit.id, hit.side);
      dragged.current = null;
    };
    const onEnd = () => {
      dragged.current = null;
      setHint(null);
    };
    // bubbling: BlockNote's drag handle has already selected the block it is dragging by the time this runs
    document.addEventListener('dragstart', onStart);
    document.addEventListener('dragover', onOver, true);
    document.addEventListener('drop', onDrop, true);
    document.addEventListener('dragend', onEnd);
    return () => {
      document.removeEventListener('dragstart', onStart);
      document.removeEventListener('dragover', onOver, true);
      document.removeEventListener('drop', onDrop, true);
      document.removeEventListener('dragend', onEnd);
    };
  }, [editor, doc, canEdit, phone]);

  // Drag a gap to resize the two columns beside it (snapping to twelfths).
  const resize = (h: (typeof handles)[number]) => (down: React.PointerEvent) => {
    down.preventDefault();
    const layouts = doc.getMap<string>('layouts');
    const start = down.clientX;
    const grid = document.querySelector<HTMLElement>('.page .bn-editor > .bn-block-group')?.getBoundingClientRect().width ?? 1;
    const unit = grid / 12;
    const base = h.row.spans.slice();
    const move = (e: PointerEvent) => {
      const step = Math.round((e.clientX - start) / unit);
      const left = Math.min(Math.max(base[h.index]! + step, MIN_SPAN), base[h.index]! + base[h.index + 1]! - MIN_SPAN);
      const spans = base.slice();
      spans[h.index + 1] = base[h.index]! + base[h.index + 1]! - left;
      spans[h.index] = left;
      doc.transact(() => h.row.members.forEach((id, i) => layouts.set(id, JSON.stringify({ r: h.row.id, s: spans[i] }))));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (phone || !canEdit) return null;
  return (
    <>
      {hint && <div className="column-drop-hint" style={{ left: hint.left, top: hint.top, height: hint.height }} />}
      {handles.map((h) => (
        <div
          key={`${h.row.id}-${h.index}`}
          className="column-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize columns"
          style={{ left: h.x - 7, top: h.top, height: h.height }}
          onPointerDown={resize(h)}
        >
          <span />
        </div>
      ))}
    </>
  );
}

/** The same thing without dragging, for the selected block: put it beside the block above, or back to full width. */
function ColumnsButton({ doc }: { doc: Y.Doc }) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor<any, any, any>();
  const blocks = useSelectedBlocks(editor);
  const [open, setOpen] = useState(false);
  const phone = useMediaQuery('(max-width: 48em)');
  const [, bump] = useState(0);
  const layouts = doc.getMap<string>('layouts');
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    layouts.observe(on);
    return () => layouts.unobserve(on);
  }, [layouts]);
  const block = blocks[0];
  if (!block || !editor.isEditable) return null;
  const inRow = placedRows(doc).find((r) => r.members.includes(block.id));
  const above = editor.getPrevBlock(block);
  const below = editor.getNextBlock(block);
  const topLevel = editor.document.some((b: { id: string }) => b.id === block.id);
  const act = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };
  const item = (label: string, hint: string, onClick: () => void, disabled = false) => (
    <Button variant="subtle" color="gray" size="compact-sm" justify="flex-start" fullWidth disabled={disabled} onClick={act(onClick)} title={hint}>
      {label}
    </Button>
  );
  return (
    <Popover opened={open} onChange={setOpen} position="bottom" shadow="md" withinPortal={false} floatingStrategy={phone ? 'fixed' : 'absolute'} trapFocus={false} closeOnClickOutside={false}>
      <Popover.Target>
        <div>
          <Components.FormattingToolbar.Button
            className="bn-button"
            label="Columns"
            mainTooltip="Columns: put blocks side by side (or drag a block to another block's edge)"
            icon={<IconLayoutColumns size={18} />}
            isSelected={open || !!inRow}
            onClick={() => setOpen((o) => !o)}
          />
        </div>
      </Popover.Target>
      <Popover.Dropdown w={260} onMouseDown={(e) => e.preventDefault()} style={phone ? { maxWidth: 'calc(100vw - 24px)' } : undefined}>
        <Stack gap={2}>
          <Text size="sm" fw={600} mb={2}>Layout</Text>
          {item('Move up', 'Move this block above the one before it', () => editor.moveBlocksUp())}
          {item('Move down', 'Move this block below the one after it', () => editor.moveBlocksDown())}
          {item('Beside the block above', 'Make a row of this block and the one above it', () => above && dropBeside(editor, doc, block.id, above.id, 'right'), !topLevel || !above || (!inRow?.members.includes(above.id) && (placedRows(doc).find((r) => r.members.includes(above.id))?.members.length ?? 1) >= MAX_COLUMNS))}
          {item('Beside the block below', 'Make a row of this block and the one below it', () => below && dropBeside(editor, doc, block.id, below.id, 'left'), !topLevel || !below)}
          {item('Equal widths', 'Share the row evenly', () => inRow && doc.transact(() => inRow.members.forEach((id) => layouts.set(id, JSON.stringify({ r: inRow.id })))), !inRow)}
          {item('Full width again', 'Take this block out of its row', () => leaveRow(doc, block.id), !inRow)}
          <Text size="xs" c="dimmed" mt={4}>
            {phone ? 'Columns sit side by side on wider screens; on a phone they stack, marked by a bar on the left.' : 'Tip: drag a block by its handle to the left or right edge of another block, and drag the gap between columns to resize.'}
          </Text>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function CommentButton({ onClick }: { onClick: () => void }) {
  const Components = useComponentsContext()!;
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label="Comment"
      mainTooltip="Comment on the selection"
      icon={<IconMessagePlus size={18} />}
      onClick={onClick}
    />
  );
}

/** The page emoji, with a picker for editors. */
function IconPicker({ icon, editable, onPick }: { icon: string; editable: boolean; onPick: (icon: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!editable) return icon ? <span className="page-icon">{icon}</span> : null;
  return (
    <Popover opened={open} onChange={setOpen} position="bottom-start" shadow="md" withinPortal>
      <Popover.Target>
        {icon ? (
          <UnstyledButton className="page-icon" onClick={() => setOpen((o) => !o)} aria-label="Change icon">
            {icon}
          </UnstyledButton>
        ) : (
          <Tooltip label="Add icon">
            <ActionIcon variant="subtle" color="gray" className="add-icon" onClick={() => setOpen((o) => !o)} aria-label="Add icon">
              <IconMoodSmile size={20} />
            </ActionIcon>
          </Tooltip>
        )}
      </Popover.Target>
      <Popover.Dropdown p="xs">
        <SimpleGrid cols={8} spacing={2} verticalSpacing={2}>
          {EMOJI.map((e) => (
            <UnstyledButton key={e} className="emoji" onClick={() => (onPick(e), setOpen(false))}>
              {e}
            </UnstyledButton>
          ))}
        </SimpleGrid>
        {icon && (
          <Button size="compact-xs" variant="subtle" color="gray" mt={6} fullWidth onClick={() => (onPick(''), setOpen(false))}>
            Remove icon
          </Button>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}

/** For read mode: a toolbar over selected text for instant highlighting or commenting. */
function SelectionComment({ editor, onComment, pageId, onError }: {
  editor: Editor;
  onComment: (quote: string, anchor?: { page?: number; rects?: number[][]; pdfUrl?: string; start?: number; end?: number }, color?: string, shape?: string) => void;
  pageId: string;
  onError?: (message: string) => void;
}) {
  const [at, setAt] = useState<{ x: number; y: number; bottom: number; text: string; start: number; end: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // Keep the toolbar inside the window: shift it sideways at the edges, and put it under the text near the top.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !at) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 8;
    const left = Math.min(Math.max(at.x, w / 2 + margin), window.innerWidth - w / 2 - margin);
    el.style.left = `${left}px`;
    const above = at.y - h - margin >= margin;
    el.style.top = `${above ? at.y : at.bottom + h + 2 * margin}px`;
  }, [at]);
  const [shape, setShape] = useState<HighlightShape>('highlight');
  const [color, setColor] = useState<string>('yellow');
  useEffect(() => {
    const update = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      const node = sel?.anchorNode;
      const editorEl = node && (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('.bn-editor');
      // A PDF has its own toolbar (it also stores where on the page the selection is).
      const inPdf = node && (node instanceof Element ? node : node.parentElement)?.closest('.pdf-reader');
      if (!text || !editorEl || !sel?.rangeCount || inPdf) return setAt(null);
      const range = sel.getRangeAt(0);
      const offsets = getSelectionOffsets(editorEl, range);
      if (!offsets) return setAt(null);
      const r = range.getBoundingClientRect();
      setAt({ x: r.left + r.width / 2, y: r.top, bottom: r.bottom, text: offsets.text, start: offsets.start, end: offsets.end });
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, []);
  if (!at) return null;
  return (
    <div ref={box} className="selection-comment selection-highlight-toolbar" style={{ left: at.x, top: at.y }}>
      <div className="selection-shape-buttons" role="toolbar" aria-label="Highlight shape">
        {HIGHLIGHT_SHAPES.map((s) => (
          <button
            key={s.value}
            type="button"
            className="selection-shape-btn"
            aria-label={s.label}
            title={s.label}
            aria-pressed={shape === s.value}
            style={{ '--highlight-color': COMMENT_COLORS.find((c) => c.value === color)?.color || '#facc15' } as React.CSSProperties}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setShape(s.value)}
          >
            <span className={`shape-icon shape-${s.value}`}>Ab</span>
          </button>
        ))}
      </div>
      <span className="selection-sep" />
      <div className="selection-highlight-palette" role="toolbar" aria-label="Highlight color">
        {COMMENT_COLORS.map((item) => (
          <button
            key={item.value}
            type="button"
            className={color === item.value ? 'selection-color is-selected' : 'selection-color'}
            style={{ '--highlight-color': item.color } as React.CSSProperties}
            aria-label={`${item.label} highlight`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setColor(item.value);
              api.addComment(pageId, '', {
                quote: at.text.slice(0, 500),
                quoteColor: item.value,
                quoteShape: shape,
                quoteStart: at.start,
                quoteEnd: at.end,
              }).then(() => {
                window.dispatchEvent(new CustomEvent('cloud-doc-comments-changed'));
                window.getSelection()?.collapseToEnd(); // removeAllRanges() leaves ProseMirror swallowing the next mousedown, so nothing can be selected again
                setAt(null);
              }).catch((e) => {
                onError?.(errorText(e));
              });
            }}
          />
        ))}
      </div>
      <button
        type="button"
        className="selection-comment-action"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onComment(at.text.slice(0, 500), { start: at.start, end: at.end }, color, shape);
          window.getSelection()?.collapseToEnd(); // removeAllRanges() leaves ProseMirror swallowing the next mousedown, so nothing can be selected again
          setAt(null);
        }}
      >
        Comment
      </button>
    </div>
  );
}
