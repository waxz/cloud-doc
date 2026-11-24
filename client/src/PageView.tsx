import { ActionIcon, Breadcrumbs, Button, CloseButton, Drawer, Group, Loader, Menu, Text, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconArrowsHorizontal, IconArrowsMinimize, IconDots, IconDownload, IconHistory, IconListDetails, IconHighlight, IconMessages, IconPaperclip, IconShare, IconStar, IconStarFilled } from '@tabler/icons-react';
import { useCallback, useEffect, useState, useRef, useMemo } from 'react';
import { api, ApiError, atLeast, type FileInfo, type PageInfo, type User } from './api';
import { CommentsPanel } from './CommentsPanel';
import { type Editor, PageEditor, type Person } from './Editor';
import { FilesPanel, insertFile, uploadInto } from './FilesPanel';
import { HistoryPanel } from './HistoryPanel';
import { OutlinePanel } from './OutlinePanel';
import { navigate } from './route';
import { ShareDialog } from './ShareDialog';
import { ThreadPopover } from './ThreadPopover';
import { colorFor, debounced, download, errorText, getFavorites, toggleFavorite } from './util';

interface Props {
  pageId: string;
  me: User | null;
  dark: boolean;
  /** Shown first in the header (the phone's menu button). */
  leading?: React.ReactNode;
  /** Extra controls at the right of the page header (the light/dark switch). */
  trailing?: React.ReactNode;
  linkFor: (pageId: string) => string;
  onTitle?: (pageId: string, title: string) => void;
  onIcon?: (pageId: string, icon: string) => void;
  onError: (message: string) => void;
  /** Files to upload into this page as soon as it's open. */
  pendingUpload?: File[];
  onPendingTaken?: () => void;
  /** Opens storage settings when an upload fails for lack of storage. */
  onNeedStorage?: () => void;
  initialCommentId?: string;
}

type Panel = 'outline' | 'highlights' | 'discussion' | 'history' | 'files';
const PANEL_TITLE: Record<Panel, string> = { outline: 'Outline', highlights: 'Highlights', discussion: 'Discussion', history: 'History', files: 'Files' };

interface QuoteAnchor {
  page?: number;
  rects?: number[][];
  pdfUrl?: string;
  start?: number;
  end?: number;
}

export function PageView({ pageId, me, dark, leading, trailing, linkFor, onTitle, onIcon, onError, pendingUpload, onPendingTaken, onNeedStorage, initialCommentId }: Props) {
  const phone = useMediaQuery('(max-width: 48em)');
  const [info, setInfo] = useState<PageInfo | null>(null);
  const [missing, setMissing] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [keys, setKeys] = useState({ comments: 0, history: 0, files: 0 });
  const [title, setTitle] = useState('');
  // Full-width pages use the whole window instead of a reading column (remembered per browser).
  const [wide, setWide] = useState(() => {
    try { return localStorage.getItem('cloud-doc-wide') === '1'; } catch { return false; }
  });
  const toggleWide = () => setWide((current) => {
    try { localStorage.setItem('cloud-doc-wide', current ? '0' : '1'); } catch { /* not remembered */ }
    return !current;
  });
  // Whether the page has comments to show beside its text: the right column is only kept open for them (or a panel).
  const [hasMargin, setHasMargin] = useState(false);
  useEffect(() => {
    const update = (event: Event) => setHasMargin(((event as CustomEvent<number>).detail ?? 0) > 0);
    window.addEventListener('cloud-doc-margin', update);
    return () => window.removeEventListener('cloud-doc-margin', update);
  }, []);
  const [favorites, setFavorites] = useState(getFavorites);
  useEffect(() => {
    const sync = () => setFavorites(getFavorites());
    window.addEventListener('cloud-doc-favorites', sync);
    return () => window.removeEventListener('cloud-doc-favorites', sync);
  }, []);
  const [quoteRequest, setQuoteRequest] = useState<{ text: string; n: number; anchor?: QuoteAnchor; color?: string; shape?: string } | null>(null);

  /**
   * Opens a comment wherever it lives: the right panel, the card in view and, for a highlight,
   * the highlighted text in the page. Used by links to comments, clicks on highlights and bubbles.
   */
  // A file picked in the workspace's Files window is added to this page.
  useEffect(() => {
    const add = (event: Event) => {
      const f = (event as CustomEvent<FileInfo>).detail;
      if (editor && f && atLeast(info?.role, 'editor')) insertFile(editor, f, pageId, !!me && atLeast(info?.role, 'commenter'));
    };
    window.addEventListener('cloud-doc-insert-file', add);
    return () => window.removeEventListener('cloud-doc-insert-file', add);
  }, [editor, pageId, me, info?.role]);

  const goToComment = useCallback(async (id: string) => {
    const list = await api.comments(pageId).catch(() => []);
    const target = list.find((c) => c.id === id);
    const root = target && list.find((c) => c.id === target.thread_id);
    setPanel(root && !root.quote ? 'discussion' : 'highlights');
    if (!root) return;
    // The panel mounts and the page may still be loading: ask again until the page confirms it
    // scrolled to the text, and then stop (a late repeat would drag the page back after the user moved on).
    const ack = { ok: false };
    const show = () => {
      if (!root.quote) return;
      const pdf = !!(root.quote_page && root.quote_pdf_url);
      const detail = pdf ? { id: root.thread_id, page: root.quote_page, pdfUrl: root.quote_pdf_url, ack } : { id: root.thread_id, text: root.quote, ack };
      window.dispatchEvent(new CustomEvent(pdf ? 'cloud-doc-show-pdf-annotation' : 'cloud-doc-show-editor-annotation', { detail }));
    };
    setTimeout(() => window.dispatchEvent(new CustomEvent('cloud-doc-focus-comment', { detail: root.id })), 150);
    let attempt = 0;
    const tick = () => {
      show();
      if (!ack.ok && ++attempt < 8) setTimeout(tick, 400);
    };
    setTimeout(tick, 200);
  }, [pageId]);

  useEffect(() => {
    if (initialCommentId) void goToComment(initialCommentId);
  }, [initialCommentId, goToComment]);

  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (id) void goToComment(id);
    };
    window.addEventListener('cloud-doc-open-comment', open);
    window.addEventListener('cloud-doc-goto-comment', open);
    return () => {
      window.removeEventListener('cloud-doc-open-comment', open);
      window.removeEventListener('cloud-doc-goto-comment', open);
    };
  }, [goToComment]);

  useEffect(() => {
    setInfo(null);
    setMissing(false);
    api.page(pageId).then(setInfo, (e) => {
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) setMissing(true);
      else onError(errorText(e));
    });
  }, [pageId, onError]);

  // Upload errors that mean "no storage yet" open the storage settings.
  const uploadError = useCallback(
    (m: string) => {
      onError(m);
      if (/Settings → Storage/.test(m)) onNeedStorage?.();
    },
    [onError, onNeedStorage]
  );

  useEffect(() => {
    if (!editor || !pendingUpload?.length) return;
    onPendingTaken?.();
    uploadInto(pageId, editor, pendingUpload, uploadError, !!me && atLeast(info?.role, 'commenter'));
  }, [editor, pendingUpload, pageId, onPendingTaken, uploadError, me, info?.role]);

  const person: Person = me ? { accountId: me.id, name: me.name, color: colorFor(me.id) } : { name: 'Guest', color: '#868e96' };
  // Live notices from other people arrive in bursts (every autosave says "history"), so
  // gather them and refresh each panel at most once per 2 s instead of once per notice.
  const pendingKinds = useRef(new Set<string>());
  const flushKinds = useMemo(() => debounced(() => {
    const kinds = [...pendingKinds.current];
    pendingKinds.current.clear();
    if (kinds.includes('comments')) {
      api.invalidateComments();
      // The page's own highlights, the panels and an open thread all reload from one shared request.
      window.dispatchEvent(new CustomEvent('cloud-doc-comments-changed'));
    }
    setKeys((k) => {
      const next = { ...k };
      for (const kind of kinds as ('comments' | 'history' | 'files')[]) next[kind] = k[kind] + 1;
      return next;
    });
  }, 2000), []);
  useEffect(() => () => flushKinds.cancel(), [flushKinds]);
  const onMessage = useCallback((type: string) => {
    if (type === 'comments' || type === 'history' || type === 'files') {
      pendingKinds.current.add(type);
      flushKinds();
    }
  }, [flushKinds]);
  const handleTitle = useCallback(
    (t: string) => {
      setTitle(t);
      onTitle?.(pageId, t);
    },
    [pageId, onTitle]
  );
  const handleIcon = useCallback((i: string) => onIcon?.(pageId, i), [pageId, onIcon]);
  const canComment = !!me && atLeast(info?.role, 'commenter');
  const onComment = useCallback((text: string, anchor?: QuoteAnchor, color?: string, shape?: string) => {
    setPanel('highlights');
    setQuoteRequest((q) => ({ text, n: (q?.n ?? 0) + 1, anchor, color, shape }));
  }, []);

  if (!info && missing) {
    return (
      <div className="empty">
        <Text fw={600}>This page doesn't exist, or you don't have access to it.</Text>
        <Text c="dimmed" size="sm">The link may be old, or the page was deleted.</Text>
        <Button variant="light" onClick={() => navigate('/')}>Go to your pages</Button>
      </div>
    );
  }
  if (!info) return <div className="page-loading page-loading-static" role="status"><Loader size="md" /></div>;
  const crumbs = info.path.map((p) => (p.id === pageId ? { ...p, title } : p));
  const shown = phone ? crumbs.slice(-1) : crumbs;
  const toggle = (p: Panel) => setPanel(panel === p ? null : p);
  const panels: { key: Panel; icon: React.ReactNode; show: boolean }[] = [
    { key: 'outline', icon: <IconListDetails size={18} />, show: true },
    { key: 'highlights', icon: <IconHighlight size={18} />, show: !info.viaShare || atLeast(info.role, 'commenter') },
    { key: 'discussion', icon: <IconMessages size={18} />, show: !info.viaShare || atLeast(info.role, 'commenter') },
    { key: 'files', icon: <IconPaperclip size={18} />, show: !info.viaShare },
    { key: 'history', icon: <IconHistory size={18} />, show: !info.viaShare },
  ];
  const canShare = !!me && !info.viaShare && atLeast(info.role, 'editor');
  // Someone reading through a share link with nothing to comment on or edit: no margin column, the page takes the whole window.
  const reviewOnly = info.viaShare && !atLeast(info.role, 'commenter');

  const fileName = (title || 'Untitled').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'page';
  const exportAs = async (kind: 'md' | 'html' | 'print') => {
    if (!editor) return onError('The page is still loading.');
    // Let the menu finish closing, or its dropdown is still on screen when the print view is taken.
    if (kind === 'print') return void setTimeout(() => window.print(), 400);
    try {
      if (kind === 'md') download(`${fileName}.md`, `# ${title || 'Untitled'}\n\n${await editor.blocksToMarkdownLossy()}`, 'text/markdown');
      else download(`${fileName}.html`, `<!doctype html><meta charset="utf-8"><title>${(title || 'Untitled').replace(/</g, '&lt;')}</title><h1>${(title || 'Untitled').replace(/</g, '&lt;')}</h1>${await editor.blocksToFullHTML()}`, 'text/html');
    } catch (e) {
      onError(errorText(e));
    }
  };
  const starred = favorites.includes(pageId);
  const exportItems = (
    <>
      <Menu.Item onClick={() => exportAs('md')}>Download Markdown</Menu.Item>
      <Menu.Item onClick={() => exportAs('html')}>Download HTML</Menu.Item>
      <Menu.Item onClick={() => exportAs('print')}>Print / save as PDF</Menu.Item>
    </>
  );

  const body =
    panel === 'outline' ? (
      <OutlinePanel editor={editor} />
    ) : panel === 'highlights' || panel === 'discussion' ? (
      <CommentsPanel key={panel} mode={panel} pageId={pageId} role={info.role} me={me} editor={editor} refreshKey={keys.comments} quoteRequest={quoteRequest} initialCommentId={initialCommentId} onError={onError} />
    ) : panel === 'history' ? (
      <HistoryPanel pageId={pageId} role={info.role} dark={dark} refreshKey={keys.history} onError={onError} />
    ) : panel === 'files' ? (
      <FilesPanel pageId={pageId} role={info.role} me={me} editor={editor} refreshKey={keys.files} onError={uploadError} />
    ) : null;

  return (
    <div className={`page-layout${wide ? ' is-wide' : ''}${reviewOnly ? ' review-only' : ''}`}>
      <div className="page-main">
        <Group justify="space-between" className="page-header" wrap="nowrap" gap="xs">
          <Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
            {leading}
            <Breadcrumbs separator="/" className="crumbs" separatorMargin={6}>
              {!phone && info.project && (
                <Text size="sm" c="dimmed" span>
                  {info.project.name}
                </Text>
              )}
              {shown.map((p) => (
                <Crumb key={p.id} title={p.title} link={linkFor(p.id)} current={p.id === pageId} />
              ))}
            </Breadcrumbs>
          </Group>
          <Group gap={4} wrap="nowrap">
            {trailing}
            {phone ? (
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon variant="subtle" color="gray" size="lg" aria-label="Page actions">
                    <IconDots size={18} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {panels
                    .filter((p) => p.show)
                    .map((p) => (
                      <Menu.Item key={p.key} leftSection={p.icon} onClick={() => toggle(p.key)}>
                        {PANEL_TITLE[p.key]}
                      </Menu.Item>
                    ))}
                  {me && <Menu.Item leftSection={starred ? <IconStarFilled size={18} /> : <IconStar size={18} />} onClick={() => toggleFavorite(pageId)}>{starred ? 'Remove from favorites' : 'Add to favorites'}</Menu.Item>}
                  <Menu.Item leftSection={wide ? <IconArrowsMinimize size={18} /> : <IconArrowsHorizontal size={18} />} onClick={toggleWide}>{wide ? 'Reading width' : 'Full width'}</Menu.Item>
                  <Menu.Divider />
                  {exportItems}
                  {canShare && (
                    <Menu.Item leftSection={<IconShare size={18} />} onClick={() => setShareOpen(true)}>
                      Share
                    </Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>
            ) : (
              <>
                {me && (
                  <Tooltip label={starred ? 'Remove from favorites' : 'Add to favorites'}>
                    <ActionIcon variant="subtle" color={starred ? 'yellow' : 'gray'} size="lg" aria-label={starred ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={starred} onClick={() => toggleFavorite(pageId)}>
                      {starred ? <IconStarFilled size={18} /> : <IconStar size={18} />}
                    </ActionIcon>
                  </Tooltip>
                )}
                <Tooltip label={wide ? 'Reading width' : 'Full width'}>
                  <ActionIcon variant={wide ? 'light' : 'subtle'} color={wide ? undefined : 'gray'} size="lg" aria-label={wide ? 'Reading width' : 'Full width'} aria-pressed={wide} onClick={toggleWide}>
                    {wide ? <IconArrowsMinimize size={18} /> : <IconArrowsHorizontal size={18} />}
                  </ActionIcon>
                </Tooltip>
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <Tooltip label="Export"><ActionIcon variant="subtle" color="gray" size="lg" aria-label="Export page"><IconDownload size={18} /></ActionIcon></Tooltip>
                  </Menu.Target>
                  <Menu.Dropdown>{exportItems}</Menu.Dropdown>
                </Menu>
                {panels
                  .filter((p) => p.show)
                  .map((p) => (
                    <Tooltip key={p.key} label={PANEL_TITLE[p.key]}>
                      <ActionIcon
                        variant={panel === p.key ? 'light' : 'subtle'}
                        color={panel === p.key ? undefined : 'gray'}
                        size="lg"
                        onClick={() => toggle(p.key)}
                        aria-label={PANEL_TITLE[p.key]}
                        aria-pressed={panel === p.key}
                      >
                        {p.icon}
                      </ActionIcon>
                    </Tooltip>
                  ))}
                {canShare && (
                  <Button size="compact-md" leftSection={<IconShare size={16} />} onClick={() => setShareOpen(true)} ml={4}>
                    Share
                  </Button>
                )}
              </>
            )}
          </Group>
        </Group>
        <PageEditor
          key={pageId}
          pageId={pageId}
          me={person}
          canEdit={atLeast(info.role, 'editor')}
          canComment={canComment}
          dark={dark}
          onTitle={handleTitle}
          onIcon={handleIcon}
          onMessage={onMessage}
          onEditor={setEditor}
          onComment={canComment ? onComment : undefined}
          onError={uploadError}
        />
      </div>
      {phone ? (
        <Drawer opened={!!panel} onClose={() => setPanel(null)} position="bottom" size="85%" title={panel && PANEL_TITLE[panel]} radius="md">
          {body}
        </Drawer>
      ) : (
        // The third column: the margin comments when no panel is open, the panel (covering them) when one is.
        <div className={`right-col${panel ? ' has-panel' : ''}${hasMargin ? ' has-margin' : ''}`}>
          {panel && (
            <aside className="side-panel">
              <Group justify="space-between" className="side-panel-head">
                <Text fw={650} size="md">{PANEL_TITLE[panel]}</Text>
                <CloseButton onClick={() => setPanel(null)} aria-label="Close panel" />
              </Group>
              {body}
            </aside>
          )}
        </div>
      )}
      {canComment && <ThreadPopover pageId={pageId} me={me} role={info.role} onOpenPanel={(id) => window.dispatchEvent(new CustomEvent('cloud-doc-open-comment', { detail: id }))} onError={onError} />}
      <ShareDialog pageId={pageId} opened={shareOpen} canShareEdit={atLeast(info.role, 'admin')} onClose={() => setShareOpen(false)} onError={onError} />
    </div>
  );
}

/** A breadcrumb entry that navigates in-app. */
function Crumb({ title, link, current }: { title: string; link: string; current: boolean }) {
  return (
    <a
      href={link}
      className={current ? 'crumb current' : 'crumb'}
      onClick={(e) => {
        e.preventDefault();
        navigate(link);
      }}
    >
      {title || 'Untitled'}
    </a>
  );
}
