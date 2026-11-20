import { ActionIcon, Breadcrumbs, Button, CloseButton, Drawer, Group, Loader, Menu, Text, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconDots, IconHistory, IconMessageCircle, IconPaperclip, IconShare } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { api, atLeast, type PageInfo, type User } from './api';
import { CommentsPanel } from './CommentsPanel';
import { type Editor, PageEditor, type Person } from './Editor';
import { FilesPanel, uploadInto } from './FilesPanel';
import { HistoryPanel } from './HistoryPanel';
import { navigate } from './route';
import { ShareDialog } from './ShareDialog';
import { colorFor, errorText } from './util';

interface Props {
  pageId: string;
  me: User | null;
  dark: boolean;
  /** Shown first in the header (the phone's menu button). */
  leading?: React.ReactNode;
  linkFor: (pageId: string) => string;
  onTitle?: (pageId: string, title: string) => void;
  onIcon?: (pageId: string, icon: string) => void;
  onError: (message: string) => void;
  /** Files to upload into this page as soon as it's open. */
  pendingUpload?: File[];
  onPendingTaken?: () => void;
  /** Opens storage settings when an upload fails for lack of storage. */
  onNeedStorage?: () => void;
}

type Panel = 'comments' | 'history' | 'files';
const PANEL_TITLE: Record<Panel, string> = { comments: 'Comments', history: 'History', files: 'Files' };

export function PageView({ pageId, me, dark, leading, linkFor, onTitle, onIcon, onError, pendingUpload, onPendingTaken, onNeedStorage }: Props) {
  const phone = useMediaQuery('(max-width: 48em)');
  const [info, setInfo] = useState<PageInfo | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [keys, setKeys] = useState({ comments: 0, history: 0, files: 0 });
  const [title, setTitle] = useState('');
  const [quoteRequest, setQuoteRequest] = useState<{ text: string; n: number } | null>(null);

  useEffect(() => {
    setInfo(null);
    api.page(pageId).then(setInfo, (e) => onError(errorText(e)));
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
    uploadInto(pageId, editor, pendingUpload, uploadError);
  }, [editor, pendingUpload, pageId, onPendingTaken, uploadError]);

  const person: Person = me ? { name: me.name, color: colorFor(me.id) } : { name: 'Guest', color: '#868e96' };
  const onMessage = useCallback((type: string) => {
    if (type === 'comments' || type === 'history' || type === 'files') setKeys((k) => ({ ...k, [type]: k[type] + 1 }));
  }, []);
  const handleTitle = useCallback(
    (t: string) => {
      setTitle(t);
      onTitle?.(pageId, t);
    },
    [pageId, onTitle]
  );
  const handleIcon = useCallback((i: string) => onIcon?.(pageId, i), [pageId, onIcon]);
  const canComment = !!me && atLeast(info?.role, 'commenter');
  const onComment = useCallback((text: string) => {
    setPanel('comments');
    setQuoteRequest((q) => ({ text, n: (q?.n ?? 0) + 1 }));
  }, []);

  if (!info) return <Loader m="xl" size="sm" />;
  const crumbs = info.path.map((p) => (p.id === pageId ? { ...p, title } : p));
  const shown = phone ? crumbs.slice(-1) : crumbs;
  const toggle = (p: Panel) => setPanel(panel === p ? null : p);
  const panels: { key: Panel; icon: React.ReactNode; show: boolean }[] = [
    { key: 'comments', icon: <IconMessageCircle size={18} />, show: !info.viaShare || atLeast(info.role, 'commenter') },
    { key: 'files', icon: <IconPaperclip size={18} />, show: !info.viaShare },
    { key: 'history', icon: <IconHistory size={18} />, show: !info.viaShare },
  ];
  const canShare = !!me && !info.viaShare && atLeast(info.role, 'editor');

  const body =
    panel === 'comments' ? (
      <CommentsPanel pageId={pageId} role={info.role} me={me} editor={editor} refreshKey={keys.comments} quoteRequest={quoteRequest} onError={onError} />
    ) : panel === 'history' ? (
      <HistoryPanel pageId={pageId} role={info.role} dark={dark} refreshKey={keys.history} onError={onError} />
    ) : panel === 'files' ? (
      <FilesPanel pageId={pageId} role={info.role} me={me} editor={editor} refreshKey={keys.files} onError={uploadError} />
    ) : null;

  return (
    <div className="page-layout">
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
                  {canShare && (
                    <Menu.Item leftSection={<IconShare size={18} />} onClick={() => setShareOpen(true)}>
                      Share
                    </Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>
            ) : (
              <>
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
        panel && (
          <aside className="side-panel">
            <Group justify="space-between" mb="sm">
              <Text fw={600}>{PANEL_TITLE[panel]}</Text>
              <CloseButton onClick={() => setPanel(null)} aria-label="Close panel" />
            </Group>
            {body}
          </aside>
        )
      )}
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
