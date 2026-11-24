import { Alert, Button, Checkbox, Divider, Group, Progress, Select, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { api, type Settings, type Workspace } from './api';
import { errorText } from './util';

type Backups = Awaited<ReturnType<typeof api.backups>>;

/**
 * Owner tools for where a workspace's data lives: move it to another storage, write a backup into a storage,
 * and restore a backup as a new workspace. Each runs as a series of short requests (the server handles a few
 * items per call) so it works inside the free plan's limits; leaving the page just stops it, and it can be started again.
 */
export function WorkspaceBackup({ workspace, onChanged, onError }: { workspace: Workspace; onChanged: () => void; onError: (m: string) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const [removeOld, setRemoveOld] = useState(false);
  const [backupTo, setBackupTo] = useState<string | null>(null);
  const [restoreFrom, setRestoreFrom] = useState<string | null>(null);
  const [backups, setBackups] = useState<Backups | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [restoreMembers, setRestoreMembers] = useState(false);
  const [busy, setBusy] = useState<'move' | 'backup' | 'restore' | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => { api.settings().then(setSettings, (e) => onError(errorText(e))); }, [onError]);
  useEffect(() => {
    setBackups(null);
    setFolder(null);
    if (restoreFrom) api.backups(restoreFrom).then(setBackups, (e) => onError(errorText(e)));
  }, [restoreFrom, onError]);

  if (!settings) return null;
  const own = settings.storages.map((s) => ({ value: s.id, label: s.name }));
  const usable = [...own, ...settings.sharedStorages.map((s) => ({ value: s.id, label: `${s.name} (shared)` }))];

  const run = async (kind: NonNullable<typeof busy>, job: () => Promise<string>) => {
    setBusy(kind);
    setProgress(0);
    setNote('');
    try {
      setNote(await job());
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const move = () => run('move', async () => {
    let start = true;
    let total = 0;
    let movedAll = 0;
    const skip: string[] = [];
    for (;;) {
      const r = await api.migrateStep(workspace.id, { toStorageId: moveTo!, removeOld, start, skip });
      start = false;
      movedAll += r.moved;
      for (const f of r.failed) skip.push(f.id);
      total = Math.max(total, movedAll + r.remaining);
      setProgress(total ? Math.round((movedAll / total) * 100) : 100);
      if (r.done || (r.moved === 0 && r.failed.length === 0)) break;
    }
    onChanged();
    return skip.length ? `Moved ${movedAll} items; ${skip.length} could not be moved and stay where they were.` : `Moved ${movedAll} items. New files now go to the new storage.`;
  });

  const backup = () => run('backup', async () => {
    let r = await api.backupStep(workspace.id, { storageId: backupTo! });
    const totals = r.totals ?? {};
    const sum = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
    const folderName = r.folder;
    let state = r.state as { counts: Record<string, number> };
    while (!r.done) {
      r = await api.backupStep(workspace.id, { storageId: backupTo!, folder: folderName, state });
      state = r.state as typeof state;
      setProgress(Math.min(99, Math.round((Object.values(state.counts).reduce((a, b) => a + b, 0) / sum) * 100)));
    }
    return `Backup saved to cloud-doc-backups/${folderName}${r.skipped?.length ? ` (${r.skipped.length} items could not be read and are not in it)` : ''}.`;
  });

  const restore = () => run('restore', async () => {
    let r = await api.importStep({ storageId: restoreFrom!, folder: folder!, targetStorageId: restoreFrom!, restoreMembers });
    const sum = Object.values(r.totals ?? {}).reduce((a, b) => a + b, 0) || 1;
    const created = r.workspace?.name ?? '';
    let n = 0;
    while (!r.done) {
      r = await api.importStep({ storageId: restoreFrom!, folder: folder!, targetStorageId: restoreFrom!, state: r.state });
      setProgress(Math.min(99, Math.round((++n * 8) / sum * 100)));
    }
    onChanged();
    const failed = r.state.failed.length;
    return `Restored as "${created}"${failed ? `; ${failed} items could not be restored` : ''}.`;
  });

  return (
    <Stack gap="sm">
      <Divider label="Move, back up and restore" labelPosition="left" />
      <Text size="xs" c="dimmed">
        Copy everything this workspace keeps (files and page history) to another storage, save a full backup you can restore anywhere, or restore one.
        Large workspaces take a while; keep this window open.
      </Text>
      <Group align="end" wrap="wrap">
        <Select label="Move files and history to" placeholder="Choose a storage" data={usable} value={moveTo} onChange={setMoveTo} style={{ flex: 1, minWidth: 180 }} disabled={!!busy} />
        <Button disabled={!moveTo || !!busy} loading={busy === 'move'} onClick={move}>Move</Button>
      </Group>
      <Checkbox size="xs" label="Delete the old copies after each file is moved" checked={removeOld} onChange={(e) => setRemoveOld(e.currentTarget.checked)} disabled={!!busy} />
      <Group align="end" wrap="wrap">
        <Select label="Back up to" placeholder="One of your storages" data={own} value={backupTo} onChange={setBackupTo} style={{ flex: 1, minWidth: 180 }} disabled={!!busy} />
        <Button variant="light" disabled={!backupTo || !!busy} loading={busy === 'backup'} onClick={backup}>Back up</Button>
      </Group>
      <Group align="end" wrap="wrap">
        <Select label="Restore from storage" placeholder="Choose a storage" data={usable} value={restoreFrom} onChange={setRestoreFrom} style={{ flex: 1, minWidth: 140 }} disabled={!!busy} />
        <Select
          label="Backup"
          placeholder={backups ? (backups.length ? 'Choose a backup' : 'No backups here') : '…'}
          data={(backups ?? []).filter((b) => b.complete).map((b) => ({ value: b.folder, label: `${b.name || b.folder} · ${b.exportedAt ? new Date(b.exportedAt).toLocaleString() : ''}` }))}
          value={folder}
          onChange={setFolder}
          style={{ flex: 1, minWidth: 180 }}
          disabled={!!busy}
        />
        <Button variant="light" disabled={!folder || !!busy} loading={busy === 'restore'} onClick={restore}>Restore as new workspace</Button>
      </Group>
      <Checkbox size="xs" label="Add the people who were in the backup (existing accounts now, others as invites)" checked={restoreMembers} onChange={(e) => setRestoreMembers(e.currentTarget.checked)} disabled={!!busy} />
      {progress !== null && <Progress value={progress} animated />}
      {note && <Alert color="green" variant="light">{note}</Alert>}
    </Stack>
  );
}
