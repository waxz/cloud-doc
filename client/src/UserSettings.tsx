import { Button, Divider, Group, Loader, Modal, PasswordInput, Progress, Select, Stack, Tabs, Text, TextInput, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconDatabase, IconUser } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { api, type Settings } from './api';
import { StorageManager } from './StorageManager';
import { errorText, formatBytes } from './util';

interface Props {
  opened: boolean;
  tab?: 'profile' | 'storage';
  onClose: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
}

/** The signed-in user's own settings: profile, password, storages. */
export function UserSettings({ opened, tab = 'profile', onClose, onChanged, onError }: Props) {
  const phone = useMediaQuery('(max-width: 48em)');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [active, setActive] = useState<string | null>(tab);
  useEffect(() => setActive(tab), [tab, opened]);

  const load = useCallback(() => api.settings().then(setSettings, (e) => onError(errorText(e))), [onError]);
  useEffect(() => {
    if (opened) load();
  }, [opened, load]);

  return (
    <Modal opened={opened} onClose={onClose} title="Settings" size="lg" fullScreen={phone}>
      {!settings ? (
        <Loader size="sm" />
      ) : (
        <Tabs value={active} onChange={setActive} keepMounted={false}>
          <Tabs.List mb="md">
            <Tabs.Tab value="profile" leftSection={<IconUser size={16} />}>
              Profile
            </Tabs.Tab>
            <Tabs.Tab value="storage" leftSection={<IconDatabase size={16} />}>
              Storage
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="profile">
            <Profile settings={settings} onSaved={() => (load(), onChanged())} onError={onError} />
          </Tabs.Panel>
          <Tabs.Panel value="storage">
            <StorageTab settings={settings} onChanged={load} onError={onError} />
          </Tabs.Panel>
        </Tabs>
      )}
    </Modal>
  );
}

function Profile({ settings, onSaved, onError }: { settings: Settings; onSaved: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState(settings.user.name);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [done, setDone] = useState('');
  const save = async (patch: Parameters<typeof api.updateProfile>[0], message: string) => {
    try {
      await api.updateProfile(patch);
      setDone(message);
      onSaved();
    } catch (e) {
      onError(errorText(e));
    }
  };
  return (
    <Stack>
      <TextInput label="Email" value={settings.user.email} readOnly variant="filled" />
      <Group align="flex-end" wrap="nowrap">
        <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} style={{ flex: 1 }} />
        <Button onClick={() => save({ name: name.trim() }, 'Name saved')} disabled={!name.trim() || name === settings.user.name}>
          Save
        </Button>
      </Group>
      <Divider label="Change password" labelPosition="left" />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save({ currentPassword: current, newPassword: next }, 'Password changed').then(() => (setCurrent(''), setNext('')));
        }}
      >
        <Stack gap="xs">
          <PasswordInput label="Current password" value={current} onChange={(e) => setCurrent(e.currentTarget.value)} autoComplete="current-password" />
          <PasswordInput
            label="New password"
            description="At least 8 characters"
            value={next}
            onChange={(e) => setNext(e.currentTarget.value)}
            autoComplete="new-password"
          />
          <Button type="submit" variant="light" disabled={!current || next.length < 8} style={{ alignSelf: 'flex-start' }}>
            Change password
          </Button>
        </Stack>
      </form>
      {done && (
        <Text size="sm" c="teal">
          {done}
        </Text>
      )}
    </Stack>
  );
}

function StorageTab({ settings, onChanged, onError }: { settings: Settings; onChanged: () => void; onError: (m: string) => void }) {
  return (
    <Stack>
      <Group justify="space-between">
        <Text size="sm" fw={500}>Stored by you</Text>
        <Text size="sm" c="dimmed">{formatBytes(settings.usage)} in total</Text>
      </Group>
      <Text size="sm" c="dimmed">
        A workspace keeps its files and page history in a WebDAV storage, such as a cloud-drive drive or Nextcloud. You pick one when you create a
        workspace; people you add to it use that storage without needing their own.
      </Text>
      {settings.sharedStorages.length > 0 && (
        <>
          <Title order={6}>Shared with you by the admin</Title>
          {settings.sharedStorages.map((s) => (
            <div key={s.id}>
              <Group justify="space-between" mb={4}>
                <Text size="sm" fw={500}>{s.name}</Text>
                <Text size="sm" c="dimmed">{formatBytes(s.used)} {s.limit_bytes != null ? `of ${formatBytes(s.limit_bytes)}` : '· no limit'}</Text>
              </Group>
              {s.limit_bytes != null && <Progress value={s.limit_bytes ? Math.min(100, (s.used / s.limit_bytes) * 100) : 100} color={s.used >= s.limit_bytes ? 'red' : 'blue'} />}
            </div>
          ))}
        </>
      )}
      <Title order={6}>Your storages</Title>
      <StorageManager uid="me" storages={settings.storages} defaultId={settings.defaultStorageId} onChanged={onChanged} onError={onError} />
    </Stack>
  );
}
