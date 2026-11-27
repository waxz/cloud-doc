import { ActionIcon, Button, Group, Text } from '@mantine/core';
import { IconLayoutSidebarRight, IconX } from '@tabler/icons-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type Comment, type RegisteredMember, type Role, type User } from './api';
import { Thread } from './CommentsPanel';
import { errorText } from './util';

/** `below`: the marker is text in the page, so the card goes under it; otherwise it is in the margin and the card goes to its left. */
interface Anchor { id: string; left: number; top: number; right: number; bottom: number; below?: boolean }

const WIDTH = 360;

/**
 * One comment thread as a card next to its marker in the page: opened by a click on a highlight, a margin
 * comment or its bubble. It is the same card as in the panel (reply, resolve, edit, delete), and a button opens
 * the whole panel.
 */
export function ThreadPopover({ pageId, me, role, onOpenPanel, onError }: {
  pageId: string;
  me: User | null;
  role: Role;
  onOpenPanel: (commentId: string) => void;
  onError: (message: string) => void;
}) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [members, setMembers] = useState<RegisteredMember[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  const load = useCallback(() => api.comments(pageId).then(setComments, (e) => onError(errorText(e))), [pageId, onError]);

  useEffect(() => {
    const peek = (event: Event) => {
      const detail = (event as CustomEvent<Anchor>).detail;
      if (!detail?.id) return;
      // the same marker again closes it
      setAnchor((current) => (current && current.id === detail.id ? null : detail));
    };
    window.addEventListener('cloud-doc-peek-comment', peek);
    return () => window.removeEventListener('cloud-doc-peek-comment', peek);
  }, []);

  useEffect(() => {
    if (!anchor) return;
    void load();
    api.commentMembers(pageId).then(setMembers, () => undefined);
    window.addEventListener('cloud-doc-comments-changed', load);
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setAnchor(null);
        return;
      }
      const target = event.target as Element | null;
      // clicks inside the card, on a marker (which decides for itself) or in a menu belonging to the card don't close it
      if (target?.closest?.('.thread-popover, .comment-brief, .comment-bubble, .mantine-Menu-dropdown, .mantine-Popover-dropdown, .bn-suggestion-menu')) return;
      setAnchor(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('cloud-doc-comments-changed', load);
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [anchor, pageId, load]);

  // Beside the marker (to its left, over the page), kept inside the window.
  useLayoutEffect(() => {
    if (!anchor || !box.current) return setPlace(null);
    const height = box.current.offsetHeight;
    const wantLeft = anchor.below ? anchor.left - WIDTH / 2 : anchor.left - WIDTH - 10;
    const left = Math.max(8, Math.min(wantLeft, window.innerWidth - WIDTH - 8));
    const wantTop = anchor.below ? anchor.bottom + 8 : anchor.top - 8;
    const top = Math.max(60, Math.min(wantTop, window.innerHeight - height - 12));
    setPlace({ left, top });
  }, [anchor, comments]);

  if (!anchor) return null;
  const root = comments.find((c) => c.id === anchor.id && c.id === c.thread_id) ?? comments.find((c) => c.id === anchor.id);
  const thread = root && comments.find((c) => c.id === root.thread_id);
  if (comments.length && !thread) {
    // deleted meanwhile
    setTimeout(() => setAnchor(null), 0);
    return null;
  }
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

  return (
    <div ref={box} className="thread-popover" style={{ left: place?.left ?? -9999, top: place?.top ?? 0, width: WIDTH, visibility: place ? 'visible' : 'hidden' }} role="dialog" aria-label="Comment thread">
      <Group justify="space-between" mb={6} wrap="nowrap">
        <Button size="compact-xs" variant="light" leftSection={<IconLayoutSidebarRight size={14} />} onClick={() => { onOpenPanel(anchor.id); setAnchor(null); }}>
          Open all comments
        </Button>
        <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Close" onClick={() => setAnchor(null)}><IconX size={14} /></ActionIcon>
      </Group>
      {thread ? (
        <Thread
          root={thread}
          replies={comments.filter((c) => c.thread_id === thread.id && c.id !== thread.id)}
          focused={false}
          me={me}
          role={role}
          run={run}
          pageId={pageId}
          members={members}
          token={null}
          onToken={() => undefined}
        />
      ) : (
        <Text size="sm" c="dimmed">Loading…</Text>
      )}
    </div>
  );
}
