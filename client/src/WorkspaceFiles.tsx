import { ActionIcon, Anchor, Badge, Button, Group, Loader, Modal, SegmentedControl, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { IconCopy, IconFile, IconFileTypePdf, IconMovie, IconMusic, IconPhoto, IconRowInsertBottom, IconSearch, IconTrash } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type User, type WorkspaceFile } from './api';
import { blockTypeFor } from './blocks';
import { deleteFileAsking } from './FilesPanel';
import { errorText, formatBytes, timeAgo } from './util';

const ICON = { image: IconPhoto, video: IconMovie, audio: IconMusic, pdf: IconFileTypePdf, file: IconFile };

/**
 * Everything uploaded to a workspace. A file is not tied to one page: several pages can show it, it survives
 * pages being deleted, and what no page uses any more shows up here as unused, to keep or delete.
 */
export function WorkspaceFiles({ workspaceId, opened, onClose, me, pageId, canInsert, onOpenPage, onError }: {
  workspaceId: string;
  opened: boolean;
  onClose: () => void;
  me: User;
  /** The page open behind this window, if any: files can be added to it. */
  pageId: string | null;
  canInsert: boolean;
  onOpenPage: (id: string) => void;
  onError: (message: string) => void;
}) {
  const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'unused' | 'mine'>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => api.workspaceFiles(workspaceId).then((r) => setFiles(r.files), (e) => onError(errorText(e))), [workspaceId, onError]);
  useEffect(() => {
    if (opened) void load();
  }, [opened, load]);

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return (files ?? []).filter((f) => (filter === 'all' || (filter === 'unused' ? f.used_count === 0 : f.owner_id === me.id)) && (!q || f.name.toLocaleLowerCase().includes(q)));
  }, [files, query, filter, me.id]);
  const unused = (files ?? []).filter((f) => f.used_count === 0);

  return (
    <Modal opened={opened} onClose={onClose} title="Files of this workspace" size="xl">
      <Stack gap="sm">
        <Group wrap="nowrap" align="flex-end">
          <TextInput style={{ flex: 1 }} size="xs" placeholder="Search files…" leftSection={<IconSearch size={14} />} value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
          <SegmentedControl
            size="xs"
            value={filter}
            onChange={(v) => setFilter(v as typeof filter)}
            data={[
              { value: 'all', label: `All (${files?.length ?? 0})` },
              { value: 'unused', label: `Unused (${unused.length})` },
              { value: 'mine', label: 'Mine' },
            ]}
          />
        </Group>
        {!files ? <Loader size="sm" /> : shown.length === 0 ? (
          <Text size="sm" c="dimmed">{files.length ? 'No file matches.' : 'No files yet. Upload one into a page and it appears here.'}</Text>
        ) : shown.map((f) => {
          const Icon = ICON[blockTypeFor(f.mime)];
          const expanded = openId === f.id;
          return (
            <div key={f.id} className="file-row workspace-file">
              <Group gap="xs" wrap="nowrap">
                <Icon size={20} stroke={1.5} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Anchor href={f.url} target="_blank" size="sm" truncate="end" display="block">{f.name}</Anchor>
                  <Text size="xs" c="dimmed">{formatBytes(f.size)} · {f.owner_name ?? 'someone'} · {timeAgo(f.created_at)}{f.storage_name ? ` · ${f.storage_name}` : ''}</Text>
                </div>
                {f.used_count === 0 ? (
                  <Badge size="sm" color="orange" variant="light">Unused</Badge>
                ) : (
                  <Badge size="sm" variant="light" style={{ cursor: 'pointer' }} onClick={() => setOpenId(expanded ? null : f.id)} title="Show the pages">
                    Used in {f.used_count} page{f.used_count === 1 ? '' : 's'}
                  </Badge>
                )}
                <Tooltip label="Copy link">
                  <ActionIcon variant="subtle" color="gray" aria-label={`Copy link to ${f.name}`} onClick={() => navigator.clipboard?.writeText(new URL(f.url, window.location.origin).href).then(() => undefined, () => undefined)}>
                    <IconCopy size={16} />
                  </ActionIcon>
                </Tooltip>
                {canInsert && pageId && (
                  <Tooltip label="Add to the open page">
                    <ActionIcon variant="subtle" color="gray" aria-label={`Add ${f.name} to the open page`} onClick={() => window.dispatchEvent(new CustomEvent('cloud-doc-insert-file', { detail: f }))}>
                      <IconRowInsertBottom size={16} />
                    </ActionIcon>
                  </Tooltip>
                )}
                {f.can_delete && (
                  <Tooltip label="Delete file">
                    <ActionIcon variant="subtle" color="red" aria-label={`Delete ${f.name}`} onClick={async () => { if (await deleteFileAsking(f, onError)) void load(); }}>
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </Group>
              {expanded && (
                <Group gap={6} mt={4} ml={28}>
                  {f.used_in.map((p) => (
                    <Badge key={p.id} size="sm" variant="outline" style={{ cursor: 'pointer' }} onClick={() => { onOpenPage(p.id); onClose(); }}>{p.title || 'Untitled'}</Badge>
                  ))}
                  {f.used_count > f.used_in.length && <Text size="xs" c="dimmed">+ {f.used_count - f.used_in.length} more you can't see</Text>}
                </Group>
              )}
            </div>
          );
        })}
        {unused.length > 0 && filter !== 'unused' && (
          <Group justify="space-between">
            <Text size="xs" c="dimmed">{unused.length} unused file{unused.length === 1 ? '' : 's'} · {formatBytes(unused.reduce((n, f) => n + f.size, 0))}</Text>
            <Button size="compact-xs" variant="subtle" onClick={() => setFilter('unused')}>Review</Button>
          </Group>
        )}
      </Stack>
    </Modal>
  );
}
