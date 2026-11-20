import { ActionIcon, Button, Menu, Modal, Select, Stack, Text } from '@mantine/core';
import {
  IconChevronRight,
  IconDots,
  IconFileText,
  IconLink,
  IconPlus,
  IconTrash,
  IconArrowsMove,
  IconUpload,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import type { Page } from './api';

type Zone = 'before' | 'inside' | 'after';

interface Props {
  projectId: string;
  pages: Page[];
  canEdit: boolean;
  activeId?: string;
  linkFor: (pageId: string) => string;
  onOpen: (id: string) => void;
  onCreate: (parentId: string | null) => void;
  onDelete: (page: Page) => void;
  onMove: (page: Page, parentId: string | null, position?: number) => void;
  onUpload: (page: Page) => void;
}

/** Which pages are expanded, per project, kept across reloads. */
function useExpanded(projectId: string) {
  const key = `cloud-doc:open:${projectId}`;
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const save = (next: Set<string>) => {
    setOpen(next);
    try {
      localStorage.setItem(key, JSON.stringify([...next]));
    } catch {
      // Private mode: expansion just isn't remembered.
    }
  };
  return [open, save] as const;
}

/** All descendants of a page (to keep moves from creating cycles). */
export function descendants(pages: Page[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of pages) if (p.parent_id && out.has(p.parent_id) && !out.has(p.id)) (out.add(p.id), (grew = true));
  }
  return out;
}

/**
 * A project's page tree: chevrons to fold, the page's emoji, drag and drop
 * to move or reorder (top or bottom edge = before or after, middle = inside),
 * and a ⋯ menu with the same actions for touch screens.
 */
export function PageTree({ projectId, pages, canEdit, activeId, linkFor, onOpen, onCreate, onDelete, onMove, onUpload }: Props) {
  const [open, setOpen] = useExpanded(projectId);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; zone: Zone } | null>(null);
  const [moving, setMoving] = useState<Page | null>(null);

  const children = useMemo(() => {
    const m = new Map<string | null, Page[]>();
    for (const p of [...pages].sort((a, b) => a.position - b.position)) {
      const list = m.get(p.parent_id) ?? [];
      list.push(p);
      m.set(p.parent_id, list);
    }
    return m;
  }, [pages]);

  // Unfold the way to the open page.
  useEffect(() => {
    if (!activeId) return;
    const byId = new Map(pages.map((p) => [p.id, p]));
    const next = new Set(open);
    let p = byId.get(activeId);
    let changed = false;
    while (p?.parent_id) {
      if (!next.has(p.parent_id)) (next.add(p.parent_id), (changed = true));
      p = byId.get(p.parent_id);
    }
    if (changed) setOpen(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, pages]);

  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };

  const drop = (target: Page, zone: Zone) => {
    const page = pages.find((p) => p.id === drag);
    setDrag(null);
    setOver(null);
    if (!page || descendants(pages, page.id).has(target.id)) return;
    if (zone === 'inside') {
      if (!open.has(target.id)) toggle(target.id);
      return onMove(page, target.id);
    }
    const siblings = (children.get(target.parent_id) ?? []).filter((p) => p.id !== page.id);
    const i = siblings.findIndex((p) => p.id === target.id);
    const neighbour = zone === 'before' ? siblings[i - 1] : siblings[i + 1];
    const position = neighbour ? (target.position + neighbour.position) / 2 : target.position + (zone === 'before' ? -1 : 1);
    onMove(page, target.parent_id, position);
  };

  const zoneOf = (e: React.DragEvent<HTMLElement>): Zone => {
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    return y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside';
  };

  const copyLink = (p: Page) => navigator.clipboard?.writeText(new URL(linkFor(p.id), window.location.origin).href);

  const rows = (parentId: string | null, depth: number): React.ReactNode =>
    (children.get(parentId) ?? []).map((p) => {
      const kids = children.get(p.id) ?? [];
      const isOpen = open.has(p.id);
      const cls = ['tree-row', p.id === activeId && 'active', p.id === drag && 'dragging', over?.id === p.id && `drop-${over.zone}`]
        .filter(Boolean)
        .join(' ');
      return (
        <div key={p.id} role="treeitem" aria-expanded={kids.length ? isOpen : undefined} aria-selected={p.id === activeId}>
          <div
            className={cls}
            style={{ paddingLeft: 4 + depth * 16 }}
            onClick={() => onOpen(p.id)}
            draggable={canEdit}
            onDragStart={(e) => {
              setDrag(p.id);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', p.title || 'Untitled');
            }}
            onDragEnd={() => (setDrag(null), setOver(null))}
            onDragOver={(e) => {
              if (!drag || drag === p.id) return;
              e.preventDefault();
              const zone = zoneOf(e);
              if (over?.id !== p.id || over.zone !== zone) setOver({ id: p.id, zone });
            }}
            onDragLeave={() => over?.id === p.id && setOver(null)}
            onDrop={(e) => (e.preventDefault(), drop(p, zoneOf(e)))}
            data-page-id={p.id}
          >
            <button
              className={`tree-chevron${isOpen ? ' open' : ''}${kids.length ? '' : ' empty'}`}
              aria-label={isOpen ? 'Collapse' : 'Expand'}
              onClick={(e) => (e.stopPropagation(), kids.length && toggle(p.id))}
              tabIndex={kids.length ? 0 : -1}
            >
              <IconChevronRight size={14} />
            </button>
            <span className="tree-icon">{p.icon || <IconFileText size={16} stroke={1.6} />}</span>
            <span className="tree-title">{p.title || 'Untitled'}</span>
            {canEdit && (
              <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
                <Menu position="bottom-end" withinPortal width={190}>
                  <Menu.Target>
                    <ActionIcon size="sm" variant="subtle" color="gray" aria-label={`Actions for ${p.title || 'Untitled'}`}>
                      <IconDots size={15} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item leftSection={<IconPlus size={15} />} onClick={() => (onCreate(p.id), toggle(p.id))}>
                      Add subpage
                    </Menu.Item>
                    <Menu.Item leftSection={<IconUpload size={15} />} onClick={() => onUpload(p)}>
                      Upload file…
                    </Menu.Item>
                    <Menu.Item leftSection={<IconArrowsMove size={15} />} onClick={() => setMoving(p)}>
                      Move to…
                    </Menu.Item>
                    <Menu.Item leftSection={<IconLink size={15} />} onClick={() => copyLink(p)}>
                      Copy link
                    </Menu.Item>
                    <Menu.Divider />
                    <Menu.Item color="red" leftSection={<IconTrash size={15} />} onClick={() => onDelete(p)}>
                      Delete
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  aria-label={`Add subpage to ${p.title || 'Untitled'}`}
                  onClick={() => {
                    onCreate(p.id);
                    if (!isOpen) toggle(p.id);
                  }}
                >
                  <IconPlus size={15} />
                </ActionIcon>
              </span>
            )}
          </div>
          {isOpen && kids.length > 0 && <div role="group">{rows(p.id, depth + 1)}</div>}
        </div>
      );
    });

  return (
    <div role="tree">
      {rows(null, 0)}
      {pages.length === 0 && (
        <Text size="xs" c="dimmed" px={10} py={4}>
          No pages yet
        </Text>
      )}
      <MoveDialog page={moving} pages={pages} onClose={() => setMoving(null)} onMove={(parentId) => moving && onMove(moving, parentId)} />
    </div>
  );
}

/** Picks a new parent: the touch-friendly way to move a page. */
function MoveDialog({ page, pages, onClose, onMove }: { page: Page | null; pages: Page[]; onClose: () => void; onMove: (parentId: string | null) => void }) {
  const [target, setTarget] = useState<string | null>('');
  useEffect(() => setTarget(page?.parent_id ?? ''), [page]);
  const blocked = page ? descendants(pages, page.id) : new Set<string>();
  const byId = new Map(pages.map((p) => [p.id, p]));
  const label = (p: Page) => {
    const parts: string[] = [];
    for (let q: Page | undefined = p; q; q = q.parent_id ? byId.get(q.parent_id) : undefined) parts.unshift(q.title || 'Untitled');
    return parts.join(' / ');
  };
  const data = [{ value: '', label: 'Top level of the project' }].concat(
    pages
      .filter((p) => !blocked.has(p.id))
      .map((p) => ({ value: p.id, label: label(p) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  );
  return (
    <Modal opened={!!page} onClose={onClose} title={`Move "${page?.title || 'Untitled'}"`}>
      <Stack>
        <Select label="Put it under" data={data} value={target} onChange={setTarget} searchable allowDeselect={false} comboboxProps={{ withinPortal: true }} />
        <Button
          onClick={() => {
            onMove(target || null);
            onClose();
          }}
        >
          Move
        </Button>
      </Stack>
    </Modal>
  );
}
