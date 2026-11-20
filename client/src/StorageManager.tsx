import { ActionIcon, Badge, Button, Card, Group, Menu, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { IconCheck, IconDots, IconPencil, IconPlugConnected, IconPlus, IconStar, IconTrash, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { api, type Storage, type StorageInput } from './api';
import { errorText } from './util';

interface Props {
  /** `me`, or a user id when an admin manages someone else's storage. */
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
                  {s.url}
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

function StorageForm({
  uid,
  storage,
  onCancel,
  onSaved,
  onError,
}: {
  uid: string;
  storage: Storage | null;
  onCancel?: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState<StorageInput>({
    name: storage?.name ?? '',
    url: storage?.url ?? '',
    username: storage?.username ?? '',
    password: '',
  });
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
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
            if (storage) await api.updateStorage(storage.id, form);
            else await api.createStorage(uid, form);
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
            label="WebDAV folder URL"
            placeholder="https://drive.example.com/dav/home"
            description="Files go into a cloud-doc folder inside it"
            value={form.url}
            onChange={set('url')}
            required
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
            <Text size="sm" c={test.ok ? 'teal' : 'red'}>
              {test.ok ? <IconCheck size={14} /> : <IconX size={14} />} {test.message}
            </Text>
          )}
          <Group justify="flex-end" gap="xs">
            <Button
              variant="default"
              size="xs"
              leftSection={<IconPlugConnected size={15} />}
              onClick={async () => {
                try {
                  setTest(await api.testStorage(storage?.id ?? null, form));
                } catch (err) {
                  setTest({ ok: false, message: errorText(err) });
                }
              }}
              disabled={!form.url}
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
