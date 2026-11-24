import { yDocToBlocks } from '@blocknote/core/yjs';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { ActionIcon, Badge, Button, Group, Loader, Modal, Progress, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import * as Y from 'yjs';
import { api, atLeast, type Role, type Version } from './api';
import { errorText, formatBytes, timeAgo } from './util';

interface Props {
  pageId: string;
  role: Role;
  dark: boolean;
  /** Bumped when the page's room reports a new version. */
  refreshKey: number;
  onError: (message: string) => void;
}

const KIND: Record<Version['kind'], string> = { auto: 'Auto', manual: 'Saved', 'before-restore': 'Before restore' };

export function HistoryPanel({ pageId, role, dark, refreshKey, onError }: Props) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [open, setOpen] = useState<Version | null>(null);
  const [saving, setSaving] = useState(false);
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof api.historyUsage>> | null>(null);
  const [clearing, setClearing] = useState(false);
  const canEdit = atLeast(role, 'editor');

  const load = useCallback(async () => {
    try {
      const [list, used] = await Promise.all([api.versions(pageId), api.historyUsage(pageId)]);
      setVersions(list);
      setUsage(used);
    } catch (e) {
      onError(errorText(e));
    }
  }, [pageId, onError]);

  // Removes history in steps (each version is one request to the storage) until none of that kind is left.
  const clear = async (scope: 'auto' | 'all') => {
    const what = scope === 'auto' ? 'the automatic versions of this page (named versions stay)' : 'the whole history of this page, named versions too';
    if (!confirm(`Delete ${what}? This frees storage and cannot be undone.`)) return;
    setClearing(true);
    try {
      for (let step = 0; step < 200; step++) {
        const r = await api.clearHistory(pageId, scope);
        if (r.remaining === 0 || r.deleted === 0) break;
      }
    } catch (e) {
      onError(errorText(e));
    } finally {
      setClearing(false);
      await load();
    }
  };
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return (
    <Stack gap="xs">
      {canEdit && (
        <Button
          size="xs"
          variant="light"
          loading={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await api.saveVersion(pageId);
              await load();
            } catch (e) {
              onError(errorText(e));
            } finally {
              setSaving(false);
            }
          }}
        >
          Save a version now
        </Button>
      )}
      <Text size="xs" c="dimmed">
        Versions are kept in the workspace's storage. One is saved automatically at most every 10 minutes while the page changes, and only the newest 30 automatic ones are kept.
      </Text>
      {usage && (
        <Stack gap={4} className="history-usage">
          <Group justify="space-between">
            <Text size="sm" fw={500}>
              This page's history: {formatBytes(usage.bytes)}
            </Text>
            <Text size="xs" c="dimmed">
              {usage.versions} version{usage.versions === 1 ? '' : 's'} ({usage.autoVersions} automatic, {formatBytes(usage.autoBytes)})
            </Text>
          </Group>
          {usage.storageLimit != null && (
            <>
              <Progress size="sm" value={Math.min(100, (usage.workspaceBytes / usage.storageLimit) * 100)} color={usage.workspaceBytes >= usage.storageLimit ? 'red' : usage.workspaceBytes >= usage.storageLimit * 0.9 ? 'orange' : undefined} />
              <Text size="xs" c="dimmed">
                The workspace has used {formatBytes(usage.workspaceBytes)} of {formatBytes(usage.storageLimit)}. When it is full, new versions are not saved.
              </Text>
            </>
          )}
          {canEdit && usage.versions > 0 && (
            <Group gap="xs">
              <Button size="compact-xs" variant="light" color="red" loading={clearing} disabled={usage.autoVersions === 0} onClick={() => clear('auto')}>
                Clear automatic versions
              </Button>
              <Button size="compact-xs" variant="subtle" color="red" loading={clearing} onClick={() => clear('all')}>
                Clear all history
              </Button>
            </Group>
          )}
        </Stack>
      )}
      {versions === null && <Loader size="sm" />}
      {versions?.length === 0 && (
        <Text size="sm" c="dimmed">
          No versions yet.
        </Text>
      )}
      {versions?.map((v) => (
        <Group key={v.id} gap={4} wrap="nowrap" align="stretch">
          <UnstyledButton className="version" style={{ flex: 1, minWidth: 0 }} onClick={() => setOpen(v)}>
            <Group justify="space-between" wrap="nowrap">
              <Text size="sm" fw={500} truncate>
                {v.title || 'Untitled'}
              </Text>
              <Badge size="xs" variant="light" color={v.kind === 'manual' ? 'blue' : 'gray'}>
                {KIND[v.kind]}
              </Badge>
            </Group>
            <Text size="xs" c="dimmed">
              {timeAgo(v.created_at)}
              {v.created_by_name ? ` · ${v.created_by_name}` : ''} · {formatBytes(v.size)}
            </Text>
          </UnstyledButton>
          {canEdit && (
            <Tooltip label="Delete this version">
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label={`Delete the version from ${timeAgo(v.created_at)}`}
                onClick={async () => {
                  if (!confirm('Delete this version?')) return;
                  try {
                    await api.deleteVersion(pageId, v.id);
                    await load();
                  } catch (e) {
                    onError(errorText(e));
                  }
                }}
              >
                <IconTrash size={15} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      ))}
      <Modal opened={!!open} onClose={() => setOpen(null)} size="xl" title={open ? `${KIND[open.kind]} version · ${new Date(open.created_at).toLocaleString()}` : ''}>
        {open && (
          <Preview
            pageId={pageId}
            version={open}
            dark={dark}
            canRestore={canEdit}
            onError={onError}
            onRestored={() => {
              setOpen(null);
              load();
            }}
          />
        )}
      </Modal>
    </Stack>
  );
}

function Preview({
  pageId,
  version,
  dark,
  canRestore,
  onError,
  onRestored,
}: {
  pageId: string;
  version: Version;
  dark: boolean;
  canRestore: boolean;
  onError: (message: string) => void;
  onRestored: () => void;
}) {
  const editor = useCreateBlockNote({}, []);
  const [title, setTitle] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.versionContent(pageId, version.id).then(
      (bytes) => {
        if (cancelled) return;
        const doc = new Y.Doc();
        Y.applyUpdate(doc, bytes);
        setTitle(String(doc.getMap('meta').get('title') ?? ''));
        editor.replaceBlocks(editor.document, yDocToBlocks(editor, doc, 'document-store'));
        doc.destroy();
      },
      (e) => onError(errorText(e))
    );
    return () => {
      cancelled = true;
    };
  }, [pageId, version.id, editor, onError]);

  return (
    <Stack>
      {title === null ? (
        <Loader size="sm" />
      ) : (
        <>
          <Text fz={28} fw={700} px={54}>
            {title || 'Untitled'}
          </Text>
          <BlockNoteView editor={editor} editable={false} theme={dark ? 'dark' : 'light'} />
        </>
      )}
      {canRestore && (
        <Group justify="flex-end">
          <Button
            loading={restoring}
            onClick={async () => {
              setRestoring(true);
              try {
                await api.restoreVersion(pageId, version.id);
                onRestored();
              } catch (e) {
                onError(errorText(e));
              } finally {
                setRestoring(false);
              }
            }}
          >
            Restore this version
          </Button>
        </Group>
      )}
    </Stack>
  );
}
