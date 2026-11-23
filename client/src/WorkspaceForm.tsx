import { Alert, Button, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Settings, type Workspace } from './api';
import { StorageManager } from './StorageManager';
import { errorText, formatBytes } from './util';

/**
 * Creating a workspace: a name and the storage that will hold its files and page history, either one of the
 * user's own or a shared one the admin allocated to them. With neither, there is nothing to create yet.
 */
export function WorkspaceForm({ onCreated, onError, children }: { onCreated: (w: Workspace) => void; onError: (message: string) => void; children?: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [name, setName] = useState('');
  const [storageId, setStorageId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => api.settings().then((s) => {
    setSettings(s);
    setStorageId((cur) => cur && [...s.storages, ...s.sharedStorages].some((x) => x.id === cur) ? cur : (s.storages[0]?.id ?? s.sharedStorages[0]?.id ?? null));
  }, (e) => onError(errorText(e))), [onError]);
  useEffect(() => { void load(); }, [load]);

  const options = useMemo(() => {
    const groups = [];
    if (settings?.storages.length) groups.push({ group: 'Your storages', items: settings.storages.map((s) => ({ value: s.id, label: s.name })) });
    if (settings?.sharedStorages.length) {
      groups.push({
        group: 'Shared with you by the admin',
        items: settings.sharedStorages.map((s) => ({ value: s.id, label: `${s.name} · ${formatBytes(s.used)}${s.limit_bytes != null ? ` of ${formatBytes(s.limit_bytes)}` : ''}` })),
      });
    }
    return groups;
  }, [settings]);

  if (!settings) return <Text size="sm" c="dimmed">Loading…</Text>;
  const none = !settings.storages.length && !settings.sharedStorages.length;

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!storageId) return;
        try {
          onCreated(await api.createWorkspace(name.trim(), storageId));
          setName('');
        } catch (err) {
          onError(errorText(err));
        }
      }}
    >
      <Stack>
        {children}
        {!settings.canCreateWorkspaces && <Alert color="orange">Your account may not create workspaces. Ask an admin, or ask someone to add you to theirs.</Alert>}
        <TextInput label="Workspace name" value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
        {none ? (
          <Alert color="blue" title="A workspace needs a storage">
            Its files and page history are kept in a WebDAV storage (a cloud-drive drive, Nextcloud…). Add one of your own, or ask the admin to share one with you.
          </Alert>
        ) : (
          <Select label="Storage for its files and history" value={storageId} onChange={setStorageId} data={options} allowDeselect={false} />
        )}
        <Group justify="space-between">
          <Button variant="light" onClick={() => setAdding(true)}>{none ? 'Add a storage' : 'Add another storage'}</Button>
          <Button type="submit" disabled={!name.trim() || !storageId || !settings.canCreateWorkspaces}>Create</Button>
        </Group>
      </Stack>
      <Modal opened={adding} onClose={() => { setAdding(false); void load(); }} title="Your storages" size="lg">
        <StorageManager uid="me" storages={settings.storages} defaultId={settings.defaultStorageId} onChanged={load} onError={onError} />
      </Modal>
    </form>
  );
}
