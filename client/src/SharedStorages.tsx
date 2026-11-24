import { ActionIcon, Badge, Button, Card, Group, NumberInput, Select, Stack, Text, Tooltip } from '@mantine/core';
import { IconPencil, IconPlus, IconTrash, IconX } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { type AdminUser, api, type SharedStorage } from './api';
import { StorageForm } from './StorageManager';
import { errorText, formatBytes } from './util';

const MB = 1048576;

/**
 * Admin: storages of the admin's own that are shared with chosen users, each with a limit. People can't be given
 * storages of their own by an admin; they add theirs in their settings. A user with an allocation can create
 * workspaces on a shared storage, and everyone in those workspaces uses it.
 */
export function SharedStorages({ onError }: { onError: (message: string) => void }) {
  const [storages, setStorages] = useState<SharedStorage[] | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [editing, setEditing] = useState<SharedStorage | 'new' | null>(null);

  const load = useCallback(() => {
    api.adminSharedStorages().then(setStorages, (e) => onError(errorText(e)));
    api.adminUsers().then(setUsers, (e) => onError(errorText(e)));
  }, [onError]);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      load();
    } catch (e) {
      onError(errorText(e));
    }
  };

  if (!storages) return null;
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Share a WebDAV storage of yours with people and give each a limit. They can build workspaces on it without a storage of their own; what those
        workspaces keep there counts against their limit.
      </Text>
      {editing === 'new' ? (
        <StorageForm uid="me" shared storage={null} onCancel={() => setEditing(null)} onSaved={() => (setEditing(null), load())} onError={onError} />
      ) : (
        <Button leftSection={<IconPlus size={16} />} variant="light" style={{ alignSelf: 'flex-start' }} onClick={() => setEditing('new')}>
          Add a shared storage
        </Button>
      )}
      {storages.map((s) =>
        editing !== 'new' && editing?.id === s.id ? (
          <StorageForm key={s.id} uid="me" shared storage={s} onCancel={() => setEditing(null)} onSaved={() => (setEditing(null), load())} onError={onError} />
        ) : (
          <Card key={s.id} withBorder padding="sm" radius="md">
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <div style={{ minWidth: 0 }}>
                <Group gap={6}>
                  <Text fw={500}>{s.name}</Text>
                  <Badge size="xs" variant="light">{s.grants.length} user{s.grants.length === 1 ? '' : 's'}</Badge>
                </Group>
                <Text size="xs" c="dimmed" truncate="end">{s.baseUrl ?? s.url}{s.path ? ` · ${s.path}` : ''}</Text>
              </div>
              <Group gap={2} wrap="nowrap">
                <Tooltip label="Edit"><ActionIcon variant="subtle" color="gray" aria-label={`Edit ${s.name}`} onClick={() => setEditing(s)}><IconPencil size={16} /></ActionIcon></Tooltip>
                <Tooltip label="Delete"><ActionIcon variant="subtle" color="red" aria-label={`Delete ${s.name}`} onClick={() => confirm(`Delete the shared storage "${s.name}"? Only possible when nothing is stored on it.`) && run(() => api.adminDeleteSharedStorage(s.id))}><IconTrash size={16} /></ActionIcon></Tooltip>
              </Group>
            </Group>
            <Stack gap={6} mt="sm">
              {s.grants.map((g) => (
                <Group key={g.user_id} justify="space-between" wrap="nowrap" gap="xs">
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm" truncate="end">{g.name}</Text>
                    <Text size="xs" c="dimmed">{formatBytes(g.used)} used</Text>
                  </div>
                  <Group gap={4} wrap="nowrap">
                    <NumberInput
                      size="xs" w={110} min={0} allowDecimal={false} placeholder="No limit" suffix=" MB" aria-label={`Limit for ${g.name}`}
                      defaultValue={g.limit_bytes != null ? Math.round(g.limit_bytes / MB) : ''}
                      onBlur={(e) => {
                        const text = e.currentTarget.value.replace(/[^\d]/g, '');
                        const next = text === '' ? null : Number(text) * MB;
                        if (next !== g.limit_bytes) void run(() => api.adminSetGrant(s.id, g.user_id, next));
                      }}
                    />
                    <ActionIcon variant="subtle" color="gray" aria-label={`Stop sharing with ${g.name}`} onClick={() => run(() => api.adminRemoveGrant(s.id, g.user_id))}><IconX size={14} /></ActionIcon>
                  </Group>
                </Group>
              ))}
              <AddGrant storage={s} users={users.filter((u) => !u.disabled && !s.grants.some((g) => g.user_id === u.id))} onAdd={(ids, limit) => run(async () => { for (const id of ids) await api.adminSetGrant(s.id, id, limit); })} />
            </Stack>
          </Card>
        ),
      )}
    </Stack>
  );
}

function AddGrant({ users, onAdd }: { storage: SharedStorage; users: AdminUser[]; onAdd: (userIds: string[], limitBytes: number | null) => void }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [limit, setLimit] = useState<number | string>('');
  if (!users.length) return null;
  const bytes = limit === '' ? null : Number(limit) * MB;
  return (
    <Group gap={6} align="flex-end" wrap="wrap">
      <Select size="xs" w={200} placeholder="Share with…" searchable value={userId} onChange={setUserId} data={users.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))} />
      <NumberInput size="xs" w={110} min={0} allowDecimal={false} placeholder="No limit" suffix=" MB" value={limit} onChange={setLimit} aria-label="Limit for the new user" />
      <Button size="xs" disabled={!userId} onClick={() => { if (userId) { onAdd([userId], bytes); setUserId(null); } }}>Share</Button>
      <Button size="xs" variant="subtle" onClick={() => onAdd(users.map((u) => u.id), bytes)}>Share with everyone</Button>
    </Group>
  );
}
