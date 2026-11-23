import { Badge, Button, Checkbox, Group, List, Modal, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { type DeletePreview, type Page } from './api';
import { formatBytes } from './util';

/**
 * Asks before a page goes: its subpages and history are deleted with it, but files belong to the workspace, so
 * the ones only this page uses are offered for deletion and the ones other pages use are kept, always.
 */
export function DeletePageDialog({ page, preview, onCancel, onConfirm }: {
  page: Page | null;
  preview: DeletePreview | null;
  onCancel: () => void;
  onConfirm: (deleteFiles: boolean) => Promise<void>;
}) {
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const files = preview?.files ?? [];
  const alone = files.filter((f) => !f.shared && f.can_delete);
  const shared = files.filter((f) => f.shared);
  const others = files.filter((f) => !f.shared && !f.can_delete);
  const subpages = (preview?.pages ?? 1) - 1;

  return (
    <Modal opened={!!page} onClose={onCancel} title={`Delete “${page?.title || 'Untitled'}”?`} size="md">
      <Stack gap="sm">
        <Text size="sm">
          {subpages > 0
            ? `The page and its ${subpages} subpage${subpages === 1 ? '' : 's'}, with all their saved versions, will be deleted.`
            : 'The page and its saved versions will be deleted.'}
        </Text>
        {files.length > 0 && (
          <>
            <Text size="sm" fw={500}>Files used by {subpages > 0 ? 'these pages' : 'this page'}</Text>
            <List size="sm" spacing={4} listStyleType="none">
              {files.map((f) => (
                <List.Item key={f.id}>
                  <Group gap={6} wrap="nowrap" justify="space-between">
                    <Text size="sm" truncate="end" style={{ minWidth: 0 }}>{f.name} <Text span c="dimmed" size="xs">{formatBytes(f.size)}</Text></Text>
                    {f.shared ? (
                      <Badge size="xs" color="blue" variant="light" title={f.used_elsewhere.map((p) => p.title || 'Untitled').join(', ')}>
                        also used by {f.used_elsewhere.map((p) => p.title || 'Untitled').slice(0, 2).join(', ')}
                      </Badge>
                    ) : (
                      <Badge size="xs" color="gray" variant="light">only here</Badge>
                    )}
                  </Group>
                </List.Item>
              ))}
            </List>
            {shared.length > 0 && <Text size="xs" c="dimmed">Files that other pages use are always kept, and stay in the workspace’s Files.</Text>}
            {alone.length > 0 && (
              <Checkbox
                checked={deleteFiles}
                onChange={(e) => setDeleteFiles(e.currentTarget.checked)}
                label={`Also delete the ${alone.length} file${alone.length === 1 ? '' : 's'} only used here`}
                description="Otherwise they stay in the workspace’s Files, unused, and can be deleted there later."
              />
            )}
            {others.length > 0 && <Text size="xs" c="dimmed">{others.length} file{others.length === 1 ? ' was' : 's were'} uploaded by someone else: only they or a workspace admin can delete {others.length === 1 ? 'it' : 'them'}.</Text>}
          </>
        )}
        <Group justify="flex-end" mt="xs">
          <Button variant="default" onClick={onCancel}>Cancel</Button>
          <Button color="red" loading={busy} disabled={!preview} onClick={async () => { setBusy(true); try { await onConfirm(deleteFiles && alone.length > 0); } finally { setBusy(false); setDeleteFiles(false); } }}>
            Delete
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
