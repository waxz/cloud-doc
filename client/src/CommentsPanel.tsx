import { type BlockNoteEditor, insertOrUpdateBlockForSlashMenu } from '@blocknote/core';
import { filterSuggestionItems } from '@blocknote/core/extensions';
import { ActionIcon, Badge, Button, Collapse, Group, Menu, Paper, Popover, Select, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { getDefaultReactSlashMenuItems, SuggestionMenuController, useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { IconCheck, IconChevronDown, IconChevronRight, IconLink, IconMessageCircle, IconRotate, IconPalette, IconSearch, IconTrash, IconX } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, atLeast, type Comment, type RegisteredMember, type Role, type User } from './api';
import { COMMENT_COLORS, HIGHLIGHT_SHAPES, schema } from './blocks';
import { blocksToMarkdown, matchesToken, RichText, type TokenFilter } from './richText';
import { colorFor, errorText, highlightPositions, timeAgo } from './util';

const QUOTE_COLORS: Record<string, string> = {
  yellow: '#facc15',
  orange: '#fb923c',
  red: '#fb7185',
  pink: '#e879f9',
  purple: '#a78bfa',
  blue: '#60a5fa',
  green: '#34d399',
};

const editorText = (editor: BlockNoteEditor<any, any, any>) => blocksToMarkdown(editor.document as any);

/** Only keep mention ids whose @name is still in the text. */
function liveMentions(text: string, _ids: string[], members: RegisteredMember[]) {
  const lower = text.toLocaleLowerCase();
  return members.filter((m) => lower.includes(`@${m.name.toLocaleLowerCase()}`)).map((m) => m.id);
}

/** Ctrl/Cmd+Enter submits. */
function submitOnShortcut(action: () => void, enabled: boolean) {
  return (event: React.KeyboardEvent) => {
    if (enabled && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      action();
    }
  };
}

/** Typing @ lists the people who can be mentioned, right at the cursor. */
function MentionMenu({ editor, members, meId }: { editor: BlockNoteEditor<any, any, any>; members: RegisteredMember[]; meId?: string }) {
  return (
    <SuggestionMenuController
      triggerCharacter="@"
      getItems={async (query) => {
        const q = query.toLocaleLowerCase();
        return members
          .filter((m) => m.id !== meId && (!q || m.name.toLocaleLowerCase().includes(q) || m.email.toLocaleLowerCase().includes(q)))
          .slice(0, 8)
          .map((m) => ({ title: m.name, subtext: m.email, onItemClick: () => editor.insertInlineContent(`@${m.name} `) }));
      }}
    />
  );
}

function CommentSlashMenu({ editor }: { editor: BlockNoteEditor<any, any, any> }) {
  return (
    <SuggestionMenuController
      triggerCharacter="/"
      getItems={async (query) => filterSuggestionItems([
        ...getDefaultReactSlashMenuItems(editor),
        {
          title: 'LaTeX',
          subtext: 'Insert a rendered LaTeX equation',
          aliases: ['latex', 'math', 'equation'],
          group: 'Media',
          onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'latex', props: { source: '' } }),
        },
        {
          title: 'Inline LaTeX',
          subtext: 'Insert LaTeX inside text',
          aliases: ['inline', 'math', 'equation'],
          group: 'Media',
          onItemClick: () => editor.insertInlineContent([{ type: 'latex-inline', props: { source: '' } }]),
        },
      ], query)}
    />
  );
}

interface Props {
  /** 'highlights': threads on text, in page order. 'discussion': conversations about the page, by latest activity. */
  mode: 'highlights' | 'discussion';
  pageId: string;
  role: Role;
  me: User | null;
  editor: BlockNoteEditor<any, any, any> | null;
  refreshKey: number;
  quoteRequest?: {
    text: string;
    n: number;
    anchor?: { page?: number; rects?: number[][]; pdfUrl?: string; start?: number; end?: number };
    color?: string;
    shape?: string;
  } | null;
  onError: (message: string) => void;
  initialCommentId?: string;
}

/** Comment links already acted on (kept across the panel being switched or reopened). */
const handledLinks = new Set<string>();

export function CommentsPanel({ mode, pageId, role, me, editor, refreshKey, quoteRequest, initialCommentId, onError }: Props) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [members, setMembers] = useState<RegisteredMember[]>([]);
  const [search, setSearch] = useState('');
  const [dFilter, setDFilter] = useState<'open' | 'resolved' | 'all' | 'mine' | 'mentions'>('open');
  const [dOrder, setDOrder] = useState<'active' | 'new' | 'old' | 'replies'>('active');
  const [token, setToken] = useState<TokenFilter | null>(null);
  // where each highlight is in the page, published by the editor (needed for the "position" order)
  const [positions, setPositions] = useState<Record<string, number>>(highlightPositions.current);
  useEffect(() => {
    const update = () => setPositions({ ...highlightPositions.current });
    update();
    window.addEventListener('cloud-doc-highlight-positions', update);
    return () => window.removeEventListener('cloud-doc-highlight-positions', update);
  }, []);
  const toggleToken = useCallback((next: TokenFilter) => setToken((cur) => (cur && cur.kind === next.kind && cur.value.toLocaleLowerCase() === next.value.toLocaleLowerCase() ? null : next)), []);
  const [focusedId, setFocusedId] = useState<string | null>(initialCommentId ?? null);
  // A card is scrolled into view when it is asked for, not every time the list reloads (that
  // used to drag the panel back to the focused card after any change elsewhere in it). Each ask
  // is a numbered request, done once its card has been scrolled to.
  const [scrollRequest, setScrollRequest] = useState<{ id: string; n: number } | null>(
    initialCommentId && !handledLinks.has(`${pageId}:${initialCommentId}`) ? { id: initialCommentId, n: 1 } : null,
  );
  const scrolledN = useRef(0);
  const focusThread = useCallback((id: string) => {
    setScrollRequest((cur) => ({ id, n: (cur?.n ?? 0) + 1 }));
    setFocusedId(id);
  }, []);
  const [draft, setDraft] = useState('');
  const [quote, setQuote] = useState('');
  const [quoteAnchor, setQuoteAnchor] = useState<{ page?: number; rects?: number[][]; pdfUrl?: string; start?: number; end?: number } | undefined>(undefined);
  const [quoteColor, setQuoteColor] = useState<string | undefined>(undefined);
  const [quoteShape, setQuoteShape] = useState<string | undefined>(undefined);
  const [posting, setPosting] = useState(false);
  const postingRef = useRef(false);
  const canComment = !!me && atLeast(role, 'commenter');
  const commentEditor = useCreateBlockNote({ schema }, []);

  const load = useCallback(() => api.comments(pageId).then(setComments, (e) => onError(errorText(e))), [pageId, onError]);
  useEffect(() => { load(); }, [load, refreshKey]);
  // Highlights made from the page itself change the list at once (the live notice is batched).
  useEffect(() => {
    window.addEventListener('cloud-doc-comments-changed', load);
    return () => window.removeEventListener('cloud-doc-comments-changed', load);
  }, [load]);
  useEffect(() => {
    api.commentMembers(pageId).then(setMembers, (e) => onError(errorText(e)));
  }, [pageId, onError]);
  useEffect(() => {
    if (!quoteRequest) return;
    setQuote(quoteRequest.text.slice(0, 500));
    setQuoteAnchor(quoteRequest.anchor);
    setQuoteColor(quoteRequest.color);
    setQuoteShape(quoteRequest.shape);
    setTimeout(() => { try { commentEditor.focus(); } catch { /* editor not mounted yet */ } }, 150);
  }, [quoteRequest]);
  useEffect(() => {
    if (!initialCommentId) return;
    // The address keeps ?comment=… for as long as the page is open: act on it once, or every
    // later change to the list (a new shape, a reply) would pull the panel back to that card.
    const linkKey = `${pageId}:${initialCommentId}`;
    if (handledLinks.has(linkKey)) return;
    const comment = comments.find((item) => item.id === initialCommentId);
    if (!comment) return;
    handledLinks.add(linkKey);
    focusThread(comment.thread_id);
  }, [comments, initialCommentId, pageId, focusThread]);
  useEffect(() => {
    const openComment = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (!id) return;
      const comment = comments.find((item) => item.id === id);
      focusThread(comment?.thread_id ?? id);
    };
    // 'open' comes from a click on a highlight; 'focus' from the page once the right panel is showing.
    window.addEventListener('cloud-doc-focus-comment', openComment);
    return () => window.removeEventListener('cloud-doc-focus-comment', openComment);
  }, [comments, focusThread]);

  const threads = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const all = comments
      .filter((comment) => comment.id === comment.thread_id && (mode === 'highlights' ? !!comment.quote : !comment.quote))
      .map((root) => {
        const replies = comments.filter((comment) => comment.thread_id === root.id && comment.id !== root.id);
        return { root, replies, last: Math.max(root.created_at, ...replies.map((r) => r.created_at)) };
      })
      .filter(({ root, replies }) => {
        if (token && ![root, ...replies].some((comment) => matchesToken(comment, token))) return false;
        return !query || [root, ...replies].some((comment) => `${comment.body} ${comment.author_name} ${comment.quote ?? ''}`.toLocaleLowerCase().includes(query));
      });
    // Highlights follow the page, top to bottom (a place not known yet goes last, oldest first); a discussion
    // follows its latest activity, so what people are talking about now is on top.
    const order = (a: (typeof all)[number], b: (typeof all)[number]) => {
      if (mode === 'discussion') return b.last - a.last;
      const pa = positions[a.root.thread_id] ?? Infinity;
      const pb = positions[b.root.thread_id] ?? Infinity;
      if (pa !== pb) return pa === Infinity ? 1 : pb === Infinity ? -1 : pa - pb;
      return a.root.created_at - b.root.created_at;
    };
    if (mode === 'discussion') {
      const mine = me?.name ? `@${me.name.toLocaleLowerCase()}` : null;
      const shown = all
        .filter(({ root, replies }) => {
          if (dFilter === 'open') return !root.resolved_at;
          if (dFilter === 'resolved') return !!root.resolved_at;
          if (dFilter === 'mine') return root.author_id === me?.id || replies.some((r) => r.author_id === me?.id);
          if (dFilter === 'mentions') return !!mine && [root, ...replies].some((c) => c.body.toLocaleLowerCase().includes(mine));
          return true;
        })
        .sort((a, b) => {
          if (dOrder === 'new') return b.root.created_at - a.root.created_at;
          if (dOrder === 'old') return a.root.created_at - b.root.created_at;
          if (dOrder === 'replies') return b.replies.length - a.replies.length || b.last - a.last;
          return b.last - a.last;
        });
      return { open: shown, resolved: [] as typeof all, total: all.length, shown: shown.length };
    }
    const open = all.filter(({ root }) => !root.resolved_at).sort(order);
    const resolved = all.filter(({ root }) => root.resolved_at).sort(order);
    return { open, resolved, total: all.length, shown: all.length };
  }, [comments, search, mode, token, positions, dFilter, dOrder, me]);
  const [showResolved, setShowResolved] = useState(false);
  // Asking for a resolved thread (a link, a click on its highlight) opens the resolved list.
  useEffect(() => {
    if (focusedId && threads.resolved.some(({ root }) => root.id === focusedId)) setShowResolved(true);
    if (focusedId && mode === 'discussion' && comments.some((c) => c.id === focusedId && c.resolved_at)) setDFilter('all');
  }, [focusedId, threads.resolved, mode, comments]);

  useEffect(() => {
    if (!scrollRequest || scrolledN.current >= scrollRequest.n) return;
    const card = document.getElementById(`comment-thread-${scrollRequest.id}`);
    if (!card) return; // not in this list yet (still loading, or filtered out): look again when the list changes
    scrolledN.current = scrollRequest.n;
    const t = setTimeout(() => card.scrollIntoView({ block: 'center', behavior: 'smooth' }), 0);
    return () => clearTimeout(t);
  }, [scrollRequest, threads]);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      window.dispatchEvent(new CustomEvent('cloud-doc-comments-changed'));
      return true;
    } catch (e) {
      onError(errorText(e));
      return false;
    }
  };
  const post = async () => {
    if (postingRef.current || !draft.trim()) return;
    postingRef.current = true;
    setPosting(true);
    try {
      await run(async () => {
        await api.addComment(pageId, blocksToMarkdown(commentEditor.document as any) || draft.trim(), {
          ...(mode === 'highlights' && quote ? { quote } : {}),
          ...(quoteAnchor ? {
            ...(quoteAnchor.page !== undefined ? { quotePage: quoteAnchor.page } : {}),
            ...(quoteAnchor.rects !== undefined ? { quoteRects: quoteAnchor.rects } : {}),
            ...(quoteAnchor.pdfUrl !== undefined ? { quotePdfUrl: quoteAnchor.pdfUrl } : {}),
            ...(quoteAnchor.start !== undefined ? { quoteStart: quoteAnchor.start } : {}),
            ...(quoteAnchor.end !== undefined ? { quoteEnd: quoteAnchor.end } : {}),
          } : {}),
          ...(quoteColor ? { quoteColor } : {}),
          ...(quoteShape ? { quoteShape } : {}),
          mentionIds: liveMentions(draft, [], members),
        });
        commentEditor.replaceBlocks(commentEditor.document, [{ type: 'paragraph', content: '' }]);
        setQuote('');
        setQuoteAnchor(undefined);
        setQuoteColor(undefined);
        setQuoteShape(undefined);
      });
    } finally {
      postingRef.current = false;
      setPosting(false);
    }
  };

  const card = ({ root, replies }: { root: Comment; replies: Comment[] }) => (
    <Thread key={root.id} root={root} replies={replies} focused={focusedId === root.id} me={me} role={role} run={run} pageId={pageId} members={members} token={token} onToken={toggleToken} />
  );
  // Highlights are grouped by where they are: a heading each time the place changes (a PDF page, or the text).
  const placeOf = (root: Comment) => (root.quote_page ? `PDF · page ${root.quote_page}` : 'In the text');
  const showComposer = canComment && (mode === 'discussion' || !!quote);

  return (
    <Stack gap="sm" className="comments-panel">
      {showComposer && (
        <Paper p={8} radius="lg" className="composer">
          {quote && (
            <div className="composer-quote" style={{ borderLeftColor: QUOTE_COLORS[quoteColor ?? 'yellow'] ?? QUOTE_COLORS.yellow }}>
              <Text size="xs" lineClamp={2}>
                {quoteAnchor?.page !== undefined && <Text span size="xs" c="dimmed" fw={600}>p.{quoteAnchor.page} · </Text>}
                <span className={quoteShape ? `quote-${quoteShape}` : undefined}>{quote}</span>
              </Text>
              <ActionIcon size="xs" variant="subtle" color="gray" aria-label="Remove quote" onClick={() => { setQuote(''); setQuoteAnchor(undefined); setQuoteColor(undefined); setQuoteShape(undefined); }}><IconX size={12} /></ActionIcon>
            </div>
          )}
          <div className="comment-editor" onKeyDown={submitOnShortcut(post, !!draft.trim() && !posting)}>
            <BlockNoteView editor={commentEditor} theme="light" formattingToolbar slashMenu={false} onChange={() => setDraft(editorText(commentEditor))}>
              <CommentSlashMenu editor={commentEditor} />
              <MentionMenu editor={commentEditor} members={members} meId={me?.id} />
            </BlockNoteView>
          </div>
          <Group justify="space-between" mt={6} wrap="nowrap" gap={6}>
            <Text size="xs" c="dimmed">Ctrl+Enter to send · @ to mention</Text>
            <Button size="compact-sm" radius="xl" disabled={!draft.trim() || posting} loading={posting} onClick={post}>{mode === 'highlights' ? 'Comment' : 'Post'}</Button>
          </Group>
        </Paper>
      )}
      {mode === 'highlights' && !quote && canComment && (
        <Text size="xs" c="dimmed" className="panel-hint">Select text in the page and pick a colour, or press Comment, to add a highlight.</Text>
      )}
      {!me && <Text size="sm" c="dimmed">Sign in to comment.</Text>}
      {mode === 'discussion' && threads.total > 0 && (
        <Group gap="xs" wrap="nowrap" className="discussion-controls">
          <Select size="xs" radius="xl" style={{ flex: 1 }} aria-label="Filter" allowDeselect={false} value={dFilter} onChange={(v) => setDFilter((v as typeof dFilter) ?? 'open')}
            data={[{ value: 'open', label: 'Open' }, { value: 'resolved', label: 'Resolved' }, { value: 'all', label: 'All threads' }, { value: 'mine', label: 'I took part' }, { value: 'mentions', label: 'Mentioning me' }]} />
          <Select size="xs" radius="xl" style={{ flex: 1 }} aria-label="Sort by" allowDeselect={false} value={dOrder} onChange={(v) => setDOrder((v as typeof dOrder) ?? 'active')}
            data={[{ value: 'active', label: 'Latest activity' }, { value: 'new', label: 'Newest' }, { value: 'old', label: 'Oldest' }, { value: 'replies', label: 'Most replies' }]} />
        </Group>
      )}
      {(threads.total > 0 || search || token) && (
        <TextInput size="xs" radius="xl" placeholder={mode === 'highlights' ? 'Search highlights' : 'Search discussion'} aria-label="Search" leftSection={<IconSearch size={14} />} value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
      )}
      {token && (
        <Group gap={6}>
          <Badge variant="light" size="md" tt="none" rightSection={<ActionIcon size="xs" variant="transparent" aria-label="Clear filter" onClick={() => setToken(null)}><IconX size={12} /></ActionIcon>}>
            {token.kind === 'member' ? '@' : '#'}{token.value}
          </Badge>
        </Group>
      )}
      {threads.shown === 0 && (
        <div className="panel-empty">
          <Text size="sm" fw={500}>{search || token || threads.total > 0 ? 'Nothing matches' : mode === 'highlights' ? 'No highlights yet' : 'No discussion yet'}</Text>
          {!search && !token && threads.total === 0 && <Text size="xs" c="dimmed">{mode === 'highlights' ? 'Select text in the page to highlight it or comment on it.' : 'Start a conversation about this page.'}</Text>}
        </div>
      )}
      {threads.open.map((item, i) => (
        <div key={item.root.id}>
          {mode === 'highlights' && (i === 0 || placeOf(threads.open[i - 1]!.root) !== placeOf(item.root)) && <div className="panel-group">{placeOf(item.root)}</div>}
          {card(item)}
        </div>
      ))}
      {threads.resolved.length > 0 && (
        <>
          <button type="button" className="panel-group panel-group-toggle" aria-expanded={showResolved} onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />} Resolved · {threads.resolved.length}
          </button>
          {showResolved && threads.resolved.map((item) => <div key={item.root.id}>{card(item)}</div>)}
        </>
      )}
    </Stack>
  );
}

interface NodeCtx {
  pageId: string;
  threadId: string;
  me: User | null;
  role: Role;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  members: RegisteredMember[];
  token: TokenFilter | null;
  onToken: (token: TokenFilter) => void;
}

function DActions({ count, open, onToggle, canReply, composing, onReply, extra }: {
  count: number; open: boolean; onToggle: () => void; canReply: boolean; composing: boolean; onReply: () => void; extra?: React.ReactNode;
}) {
  return (
    <div className="dthread-actions" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="dbtn" aria-expanded={open} disabled={count === 0} onClick={onToggle}>
        <IconMessageCircle size={15} /> {count} {count === 1 ? 'reply' : 'replies'}
        {count > 0 && (open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />)}
      </button>
      {canReply && !composing && <button type="button" className="dbtn" onClick={onReply}>Reply</button>}
      {extra}
    </div>
  );
}

/** Replies hang from a rail at the left; clicking the rail folds them. */
function Replies({ children, onCollapse }: { children: React.ReactNode; onCollapse: () => void }) {
  return (
    <div className="dthread-replies">
      <button type="button" className="dthread-rail" aria-label="Collapse replies" onClick={onCollapse} />
      <div className="dthread-replies-body">{children}</div>
    </div>
  );
}

function ReplyComposer({ pageId, threadId, parentId, me, run, members, onDone }: NodeCtx & { parentId?: string; onDone: () => void }) {
  const editor = useCreateBlockNote({ schema }, []);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  useEffect(() => { const t = setTimeout(() => { try { editor.focus(); } catch { /* not mounted yet */ } }, 100); return () => clearTimeout(t); }, [editor]);
  const send = async () => {
    if (sendingRef.current || !text.trim()) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const succeeded = await run(() => api.addComment(pageId, blocksToMarkdown(editor.document as any) || text.trim(), {
        threadId,
        ...(parentId ? { parentId } : {}),
        mentionIds: liveMentions(text, [], members),
      }));
      if (succeeded) onDone();
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  return (
    <div className="thread-composer" onClick={(e) => e.stopPropagation()}>
      <div className="comment-reply-editor" onKeyDown={submitOnShortcut(send, !!text.trim() && !sending)}>
        <BlockNoteView editor={editor} theme="light" formattingToolbar slashMenu={false} onChange={() => setText(editorText(editor))}>
          <CommentSlashMenu editor={editor} />
          <MentionMenu editor={editor} members={members} meId={me?.id} />
        </BlockNoteView>
      </div>
      <Group gap={6} mt={6} justify="flex-end">
        <Button size="compact-xs" variant="subtle" color="gray" radius="xl" onClick={onDone}>Cancel</Button>
        <Button size="compact-xs" radius="xl" disabled={!text.trim() || sending} loading={sending} onClick={send}>Reply</Button>
      </Group>
    </div>
  );
}

/** One reply, with the replies to it nested below. */
function DNode({ c, kids, depth, locked, ...ctx }: NodeCtx & { c: Comment; kids: Map<string, Comment[]>; depth: number; locked: boolean }) {
  const [open, setOpen] = useState(true);
  const [composing, setComposing] = useState(false);
  const mine = kids.get(c.id) ?? [];
  const count = (id: string): number => (kids.get(id) ?? []).reduce((n, k) => n + 1 + count(k.id), 0);
  const canReply = !!ctx.me && atLeast(ctx.role, 'commenter') && !locked;
  const nested = mine.map((k) => <DNode key={k.id} c={k} kids={kids} depth={depth + 1} locked={locked} {...ctx} />);
  return (
    <div className="dnode">
      <CommentItem c={c} me={ctx.me} role={ctx.role} run={ctx.run} members={ctx.members} token={ctx.token} onToken={ctx.onToken} />
      <DActions count={count(c.id)} open={open} onToggle={() => setOpen((v) => !v)} canReply={canReply} composing={composing} onReply={() => { setComposing(true); setOpen(true); }} />
      {composing && <ReplyComposer {...ctx} parentId={c.id} onDone={() => setComposing(false)} />}
      {mine.length > 0 && open && (depth >= 5 ? <div className="dnode-flat">{nested}</div> : <Replies onCollapse={() => setOpen(false)}>{nested}</Replies>)}
    </div>
  );
}

export function Thread({ root, replies, focused, me, role, run, pageId, members, token, onToken }: {
  token: TokenFilter | null;
  onToken: (token: TokenFilter) => void;
  root: Comment;
  replies: Comment[];
  focused: boolean;
  me: User | null;
  role: Role;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  pageId: string;
  members: RegisteredMember[];
}) {
  const replyEditor = useCreateBlockNote({ schema }, []);
  const [reply, setReply] = useState('');
  const [open, setOpen] = useState(true);
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [composing, setComposing] = useState(false);
  const canComment = !!me && atLeast(role, 'commenter');
  const accent = QUOTE_COLORS[root.quote_color ?? ''] ?? 'var(--line)';
  const copyLink = () => {
    const url = `${window.location.origin}${window.location.pathname}?comment=${encodeURIComponent(root.id)}`;
    navigator.clipboard?.writeText(url).then(() => undefined, () => undefined);
  };
  const canDeleteThread = !!me && (root.author_id === me.id || atLeast(role, 'admin'));
  const sendReply = () => run(async () => {
    await api.addComment(pageId, blocksToMarkdown(replyEditor.document as any) || reply.trim(), { threadId: root.id, mentionIds: liveMentions(reply, mentionIds, members) });
    replyEditor.replaceBlocks(replyEditor.document, [{ type: 'paragraph', content: '' }]);
    setReply('');
    setMentionIds([]);
    setComposing(false);
  });
  // Who answers whom: a reply points at the comment it answers; one whose parent is unknown hangs from the first comment.
    const byId = new Set([root.id, ...replies.map((r) => r.id)]);
    const kids = new Map<string, Comment[]>();
    for (const r of replies) {
      const parent = r.parent_id && byId.has(r.parent_id) ? r.parent_id : root.id;
      kids.set(parent, [...(kids.get(parent) ?? []), r]);
    }
    const ctx = { pageId, threadId: root.id, me, role, run, members, token, onToken };
    return (
      <article
        className={`dthread${root.quote ? ' thread thread-hl' : ''}${focused ? ' is-active' : ''}${root.resolved_at ? ' is-resolved' : ''}`}
        id={`comment-thread-${root.id}`}
        style={{ '--thread-accent': accent } as React.CSSProperties}
        onClick={() => {
          if (root.quote_page && root.quote_pdf_url) {
            window.dispatchEvent(new CustomEvent('cloud-doc-show-pdf-annotation', { detail: { id: root.thread_id, page: root.quote_page, pdfUrl: root.quote_pdf_url } }));
          } else if (root.quote) {
            window.dispatchEvent(new CustomEvent('cloud-doc-show-editor-annotation', { detail: { id: root.thread_id, text: root.quote } }));
          }
        }}
      >
      {root.quote && (
        <Group justify="space-between" wrap="nowrap" align="flex-start" mb={4} gap={4}>
          <Text size="sm" fw={500} className="thread-quote" lineClamp={3}>
            {root.quote_page && <Text span size="xs" c="dimmed" fw={600}>p.{root.quote_page} · </Text>}
            <span className={root.quote_shape ? `quote-${root.quote_shape}` : undefined}>“{root.quote}”</span>
          </Text>
          <Group gap={2} wrap="nowrap" className="thread-actions" onClick={(e) => e.stopPropagation()}>
            {canDeleteThread && root.quote && (
              <Popover position="bottom-end" withinPortal shadow="md">
                <Popover.Target><ActionIcon size="xs" variant="subtle" color="gray" aria-label="Change highlight style"><IconPalette size={14} /></ActionIcon></Popover.Target>
                <Popover.Dropdown p={6}>
                  <div className="selection-highlight-toolbar" style={{ position: 'static', boxShadow: 'none', border: 0, padding: 0 }}>
                    <div className="selection-shape-buttons" role="toolbar" aria-label="Highlight shape">
                      {HIGHLIGHT_SHAPES.map((shape) => (
                        <button key={shape.value} type="button" className="selection-shape-btn" aria-label={shape.label} title={shape.label}
                          aria-pressed={(root.quote_shape || 'highlight') === shape.value}
                          style={{ '--highlight-color': QUOTE_COLORS[root.quote_color ?? 'yellow'] ?? '#facc15' } as React.CSSProperties}
                          onClick={() => run(() => api.setCommentStyle(root.id, { quoteShape: shape.value }))}>
                          <span className={`shape-icon shape-${shape.value}`}>Ab</span>
                        </button>
                      ))}
                    </div>
                    <span className="selection-sep" />
                    <div className="selection-highlight-palette" role="toolbar" aria-label="Highlight color">
                      {COMMENT_COLORS.map((item) => (
                        <button key={item.value} type="button" className={(root.quote_color || 'yellow') === item.value ? 'selection-color is-selected' : 'selection-color'}
                          style={{ '--highlight-color': item.color } as React.CSSProperties} aria-label={`${item.label} highlight`}
                          onClick={() => run(() => api.setCommentStyle(root.id, { quoteColor: item.value }))} />
                      ))}
                    </div>
                  </div>
                </Popover.Dropdown>
              </Popover>
            )}
            {canDeleteThread && <ActionIcon size="xs" variant="subtle" color="gray" aria-label="Delete thread" onClick={() => { if (window.confirm('Delete this whole thread and its replies?')) run(() => api.deleteComment(root.id)); }}><IconTrash size={14} /></ActionIcon>}
          </Group>
        </Group>
      )}
        {(root.body || !root.quote) && <CommentItem c={root} me={me} role={role} run={run} members={members} token={token} onToken={onToken} />}
        {root.visibility === 'mentioned' && <Badge size="xs" variant="light" ml={30}>Private</Badge>}
        <DActions
          count={replies.length} open={open} onToggle={() => setOpen((v) => !v)}
          canReply={canComment && !root.resolved_at} composing={composing} onReply={() => { setComposing(true); setOpen(true); }}
          extra={<>
            <button type="button" className="dbtn" onClick={copyLink}><IconLink size={14} /> Link</button>
            {canComment && (
              <button type="button" className="dbtn" onClick={() => run(() => api.resolveComment(root.id, !root.resolved_at))}>
                {root.resolved_at ? <><IconRotate size={14} /> Reopen</> : <><IconCheck size={14} /> Resolve</>}
              </button>
            )}
            {root.resolved_at && <Badge size="xs" variant="light" color="gray">Resolved by {root.resolved_by_name}</Badge>}
          </>}
        />
        {composing && canComment && <ReplyComposer {...ctx} parentId={undefined} onDone={() => setComposing(false)} />}
        {replies.length > 0 && open && (
          <Replies onCollapse={() => setOpen(false)}>
            {(kids.get(root.id) ?? []).map((c) => <DNode key={c.id} c={c} kids={kids} depth={1} locked={!!root.resolved_at} {...ctx} />)}
          </Replies>
        )}
      </article>
    );
}

function CommentItem({ c, me, role, run, members, token, onToken }: {
  token: TokenFilter | null;
  onToken: (token: TokenFilter) => void;
  c: Comment;
  me: User | null;
  role: Role;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  members: RegisteredMember[];
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(c.body);
  const mine = !!me && c.author_id === me.id;
  const canDelete = mine || (!!me && atLeast(role, 'admin'));
  return (
    <div className="comment" onClick={(e) => e.stopPropagation()}>
      <Group justify="space-between" gap={4} wrap="nowrap">
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <span className="comment-avatar" style={{ background: colorFor(c.author_id ?? c.author_name) }} aria-hidden>{c.author_name.slice(0, 1).toUpperCase()}</span>
          <Text size="xs" fw={600} truncate="end">{c.author_name} <Text span size="xs" c="dimmed" fw={400}>{timeAgo(c.created_at)}{c.edited_at ? ' · edited' : ''}</Text></Text>
        </Group>
        {(mine || canDelete) && <Menu position="bottom-end" withinPortal><Menu.Target><ActionIcon variant="subtle" size="xs" color="gray" aria-label="Comment actions">⋯</ActionIcon></Menu.Target><Menu.Dropdown>
          {mine && <Menu.Item onClick={() => setEditing(true)}>Edit</Menu.Item>}
          {canDelete && <Menu.Item color="red" onClick={() => { if (window.confirm(c.id === c.thread_id ? 'Delete this whole thread and its replies?' : 'Delete this comment and the replies to it?')) run(() => api.deleteComment(c.id)); }}>{c.id === c.thread_id ? 'Delete thread' : 'Delete'}</Menu.Item>}
        </Menu.Dropdown></Menu>}
      </Group>
      {editing ? <><Textarea size="xs" autosize value={body} onChange={(e) => setBody(e.currentTarget.value)} /><Group gap={6} mt={4}><Button size="compact-xs" disabled={!body.trim()} onClick={() => run(async () => { await api.editComment(c.id, body.trim()); setEditing(false); })}>Save</Button><Button size="compact-xs" variant="subtle" onClick={() => { setEditing(false); setBody(c.body); }}>Cancel</Button></Group></> : (
        c.body ? (
          <RichText text={c.body} members={members} onToken={onToken} active={token} />
        ) : (
          <Text size="xs" c="dimmed" fs="italic">Highlight</Text>
        )
      )}
    </div>
  );
}
