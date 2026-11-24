import { ActionIcon, Badge, Button, Card, Group, Menu, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { IconCheck, IconDots, IconPencil, IconPlugConnected, IconPlus, IconStar, IconTrash, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { api, type Storage, type StorageInput } from './api';
import { errorText } from './util';

interface Props {
  /** Always `me`: people set up their own storages. */
  uid: string;
  storages: Storage[];
  defaultId: string | null;
  onChanged: () => void;
  onError: (message: string) => void;
}

/**
 * A user's WebDAV storages (cloud-drive, Nextcloud, any WebDAV server):
 * add, test, edit, pick the default, remove.
 */
export function StorageManager({ uid, storages, defaultId, onChanged, onError }: Props) {
  const [editing, setEditing] = useState<Storage | 'new' | null>(storages.length ? null : 'new');

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError(errorText(e));
    }
  };

  return (
    <Stack gap="sm">
      {storages.map((s) =>
        editing !== 'new' && editing?.id === s.id ? (
          <StorageForm key={s.id} storage={s} onCancel={() => setEditing(null)} onSaved={() => (setEditing(null), onChanged())} uid={uid} onError={onError} />
        ) : (
          <Card key={s.id} withBorder padding="sm" radius="md">
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <div style={{ minWidth: 0 }}>
                <Group gap={6}>
                  <Text fw={500}>{s.name}</Text>
                  {s.id === defaultId && (
                    <Badge size="xs" variant="light">
                      Default
                    </Badge>
                  )}
                </Group>
                <Text size="xs" c="dimmed" truncate="end">
                  {s.baseUrl ?? s.url}
                  {s.path ? ` · ${s.path}` : ''}
                </Text>
                {s.username && (
                  <Text size="xs" c="dimmed">
                    as {s.username}
                  </Text>
                )}
              </div>
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon variant="subtle" color="gray" aria-label={`Actions for ${s.name}`}>
                    <IconDots size={16} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item
                    leftSection={<IconPlugConnected size={15} />}
                    onClick={async () => {
                      try {
                        const r = await api.testStorage(s.id, {});
                        if (r.ok) alert(`${s.name}: ${r.message}`);
                        else onError(`${s.name}: ${r.message}`);
                      } catch (e) {
                        onError(errorText(e));
                      }
                    }}
                  >
                    Test connection
                  </Menu.Item>
                  {s.id !== defaultId && (
                    <Menu.Item leftSection={<IconStar size={15} />} onClick={() => run(() => api.setDefaultStorage(uid, s.id))}>
                      Make default
                    </Menu.Item>
                  )}
                  <Menu.Item leftSection={<IconPencil size={15} />} onClick={() => setEditing(s)}>
                    Edit
                  </Menu.Item>
                  <Menu.Item
                    color="red"
                    leftSection={<IconTrash size={15} />}
                    onClick={() => confirm(`Remove ${s.name}? Its files stay on the server.`) && run(() => api.deleteStorage(s.id))}
                  >
                    Remove
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </Group>
          </Card>
        )
      )}
      {editing === 'new' ? (
        <StorageForm uid={uid} storage={null} onCancel={storages.length ? () => setEditing(null) : undefined} onSaved={() => (setEditing(null), onChanged())} onError={onError} />
      ) : (
        <Button variant="light" leftSection={<IconPlus size={16} />} onClick={() => setEditing('new')} style={{ alignSelf: 'flex-start' }}>
          Add WebDAV storage
        </Button>
      )}
    </Stack>
  );
}

export function StorageForm({
  uid,
  storage,
  shared = false,
  onCancel,
  onSaved,
  onError,
}: {
  uid: string;
  /** An admin's shared storage rather than one of the user's own. */
  shared?: boolean;
  storage: Storage | null;
  onCancel?: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState<StorageInput>({
    name: storage?.name ?? '',
    baseUrl: storage?.baseUrl ?? storage?.url ?? '',
    path: storage?.path ?? '',
    username: storage?.username ?? '',
    password: '',
  });
  const [test, setTest] = useState<{ ok: boolean; message: string; missing?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const runTest = async (create: boolean) => {
    try {
      const input = { ...form, create };
      setTest(await (shared ? api.adminTestSharedStorage(storage?.id ?? null, input) : api.testStorage(storage?.id ?? null, input)));
    } catch (err) {
      setTest({ ok: false, message: errorText(err) });
    }
  };
  const set = (k: keyof StorageInput) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [k]: e.currentTarget.value });
    setTest(null);
  };

  return (
    <Card withBorder padding="sm" radius="md">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            if (storage) await (shared ? api.adminUpdateSharedStorage(storage.id, form) : api.updateStorage(storage.id, form));
            else await (shared ? api.adminCreateSharedStorage(form) : api.createStorage(uid, form));
            onSaved();
          } catch (err) {
            onError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Stack gap="xs">
          <TextInput label="Name" placeholder="My drive" value={form.name} onChange={set('name')} required />
          <TextInput
            label="Server URL"
            placeholder="https://drive.example.com/remote.php/dav/files/me"
            description="The WebDAV address of your account on the server"
            value={form.baseUrl}
            onChange={set('baseUrl')}
            inputMode="url"
            autoCapitalize="off"
            required
          />
          <TextInput
            label="Folder"
            placeholder="Apps/cloud-doc"
            description="Where Cloud Doc keeps its data. Created for you if it doesn't exist; leave empty to use the server URL itself."
            value={form.path}
            onChange={set('path')}
            autoCapitalize="off"
          />
          <Group grow>
            <TextInput label="Username" value={form.username} onChange={set('username')} autoComplete="off" />
            <PasswordInput
              label="Password"
              placeholder={storage?.hasPassword ? 'Unchanged' : ''}
              value={form.password}
              onChange={set('password')}
              autoComplete="new-password"
            />
          </Group>
          {test && (
            <Group gap="xs" align="center">
              <Text size="sm" c={test.ok ? 'teal' : test.missing ? 'orange' : 'red'}>
                {test.ok ? <IconCheck size={14} /> : <IconX size={14} />} {test.message}
              </Text>
              {test.missing && (
                <Button size="compact-xs" variant="light" onClick={() => runTest(true)}>
                  Create folder
                </Button>
              )}
            </Group>
          )}
          <Group justify="flex-end" gap="xs">
            <Button
              variant="default"
              size="xs"
              leftSection={<IconPlugConnected size={15} />}
              onClick={() => runTest(false)}
              disabled={!form.baseUrl}
            >
              Test
            </Button>
            {onCancel && (
              <Button variant="subtle" size="xs" onClick={onCancel}>
                Cancel
              </Button>
            )}
            <Button type="submit" size="xs" loading={busy}>
              Save
            </Button>
          </Group>
        </Stack>
      </form>
    </Card>
  );
}
