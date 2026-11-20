import { type BlockNoteEditor, insertOrUpdateBlockForSlashMenu } from '@blocknote/core';
import { filterSuggestionItems } from '@blocknote/core/extensions';
import { withCollaboration } from '@blocknote/core/yjs';
import { BlockNoteView } from '@blocknote/mantine';
import {
  FormattingToolbar,
  FormattingToolbarController,
  getDefaultReactSlashMenuItems,
  getFormattingToolbarItems,
  SuggestionMenuController,
  useComponentsContext,
  useCreateBlockNote,
} from '@blocknote/react';
import { ActionIcon, Avatar, Button, Group, Popover, SimpleGrid, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconFileTypePdf, IconMessagePlus, IconMoodSmile } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import YProvider from 'y-partyserver/provider';
import * as Y from 'yjs';
import { api } from './api';
import { schema, type Schema } from './blocks';
import { errorText } from './util';

export interface Person {
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
  onComment?: (quote: string) => void;
  onError: (message: string) => void;
}

interface Peer extends Person {
  id: number;
}

const EMOJI = [
  '📄', '📝', '📌', '📎', '📚', '📖', '🗂️', '📁', '🗃️', '📊', '📈', '🧾',
  '✅', '☑️', '⭐', '🔥', '💡', '🎯', '🚀', '⚙️', '🛠️', '🔧', '🧪', '🐛',
  '🔒', '🔑', '🌐', '🏠', '🏢', '👥', '🙋', '💬', '📣', '📅', '⏰', '🗓️',
  '🎨', '🖼️', '🎬', '🎵', '📷', '🧭', '🗺️', '🌱', '🍀', '☕', '🎉', '❤️',
];

/**
 * One page: a Yjs document synced through the page's Durable Object. The
 * title and emoji are fields in the same document, so they sync like the
 * body. Mount with `key={pageId}` so each page gets a fresh connection.
 */
export function PageEditor({ pageId, me, canEdit, canComment, dark, onTitle, onIcon, onMessage, onEditor, onComment, onError }: Props) {
  const [{ doc, provider }] = useState(() => {
    const doc = new Y.Doc();
    const provider = new YProvider(window.location.host, pageId, doc, {
      party: 'page-room',
      protocol: window.location.protocol === 'https:' ? 'wss' : 'ws',
    });
    return { doc, provider };
  });
  const meta = doc.getMap<string>('meta');
  const [title, setTitle] = useState('');
  const [icon, setIcon] = useState('');
  const [synced, setSynced] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    const onMeta = () => {
      const t = meta.get('title') ?? '';
      const i = meta.get('icon') ?? '';
      setTitle(t);
      setIcon(i);
      onTitle?.(t);
      onIcon?.(i);
    };
    const onSync = (isSynced: boolean) => setSynced(isSynced);
    const onAwareness = () => {
      const list: Peer[] = [];
      provider.awareness.getStates().forEach((state, id) => {
        const u = state.user as Partial<Person> | undefined;
        if (id !== doc.clientID && u?.name) list.push({ id, name: u.name, color: u.color ?? '#888' });
      });
      setPeers(list);
    };
    const onCustom = (message: string) => {
      try {
        onMessage?.((JSON.parse(message) as { type: string }).type);
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
      provider.destroy();
      doc.destroy();
    };
    // The doc and provider live as long as this component (keyed by page).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editor = useCreateBlockNote(
    withCollaboration({
      schema,
      collaboration: {
        provider,
        fragment: doc.getXmlFragment('document-store'),
        user: { name: me.name, color: me.color },
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

  const editable = synced && canEdit;

  // Kept stable: a new component on each render (cursor moves re-render this)
  // would remount the toolbar between mousedown and click.
  const commentRef = useRef(onComment);
  commentRef.current = onComment;
  const hasComment = !!onComment;
  const toolbar = useCallback(
    () => (
      <FormattingToolbar>
        {...getFormattingToolbarItems()}
        {hasComment && <CommentButton key="comment" onClick={() => commentRef.current?.(editor.getSelectedText())} />}
      </FormattingToolbar>
    ),
    [editor, hasComment]
  );

  // Handed out once the document has loaded, so blocks added from outside
  // (uploads, quotes) land in the real document.
  useEffect(() => {
    onEditor?.(synced ? editor : null);
    return () => onEditor?.(null);
  }, [editor, synced, onEditor]);

  return (
    <div className="page">
      <Group justify="space-between" className="page-bar">
        <Text size="xs" c="dimmed">
          {!synced ? 'Connecting…' : canEdit ? 'Live' : 'Live · read only'}
        </Text>
        <Avatar.Group>
          {peers.slice(0, 6).map((p) => (
            <Tooltip key={p.id} label={p.name} withArrow>
              <Avatar size="sm" radius="xl" color={p.color} variant="filled" styles={{ root: { background: p.color } }}>
                {p.name.slice(0, 1).toUpperCase()}
              </Avatar>
            </Tooltip>
          ))}
        </Avatar.Group>
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
      <BlockNoteView editor={editor} theme={dark ? 'dark' : 'light'} editable={editable} formattingToolbar={false} slashMenu={false}>
        <FormattingToolbarController formattingToolbar={toolbar} />
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
                  onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'pdf' }),
                },
              ],
              query
            )
          }
        />
      </BlockNoteView>
      {!canEdit && canComment && onComment && <SelectionComment onComment={onComment} />}
    </div>
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

/** For people who can comment but not edit: a Comment button over selected text. */
function SelectionComment({ onComment }: { onComment: (quote: string) => void }) {
  const [at, setAt] = useState<{ x: number; y: number; text: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const update = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      const node = sel?.anchorNode;
      const inEditor = node && (node instanceof Element ? node : node.parentElement)?.closest('.bn-editor');
      if (!text || !inEditor || !sel?.rangeCount) return setAt(null);
      const r = sel.getRangeAt(0).getBoundingClientRect();
      setAt({ x: r.left + r.width / 2, y: r.top, text });
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, []);
  if (!at) return null;
  return (
    <div ref={ref} className="selection-comment" style={{ left: at.x, top: at.y }}>
      <Button size="compact-sm" leftSection={<IconMessagePlus size={16} />} onMouseDown={(e) => e.preventDefault()} onClick={() => onComment(at.text.slice(0, 500))}>
        Comment
      </Button>
    </div>
  );
}
