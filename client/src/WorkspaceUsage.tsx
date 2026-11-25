import { Badge, Button, Divider, Group, NumberInput, Progress, Stack, Text } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { api, type User, type WorkspaceUsage as Usage } from './api';
import { errorText, formatBytes } from './util';

const MB = 1048576;

/**
 * What a workspace keeps (files and page history), against its limits. Owners and admins see it; only the
 * instance admin can change the limits, so an owner can't lift their own.
 */
export function WorkspaceUsage({ workspaceId, me, onError }: { workspaceId: string; me: User; onError: (m: string) => void }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [storageMb, setStorageMb] = useState<number | string>('');
  const [pages, setPages] = useState<number | string>('');
  const [comments, setComments] = useState<number | string>('');
  const [note, setNote] = useState('');
  const load = useCallback(
    () =>
      api.workspaceUsage(workspaceId).then(
        (u) => (setUsage(u), setStorageMb(u.storageLimit ? +(u.storageLimit / MB).toFixed(2) : ''), setPages(u.maxPages ?? ''), setComments(u.maxComments ?? '')),
        (e) => onError(errorText(e))
      ),
    [workspaceId, onError]
  );
  useEffect(() => void load(), [load]);
  if (!usage) return null;
  const share = usage.storageLimit ? Math.min(100, (usage.bytes / usage.storageLimit) * 100) : 0;
  const near = usage.storageLimit != null && share >= 90;
  return (
    <Stack gap="xs">
      <Divider label="Storage and limits" labelPosition="left" />
      <div>
        <Group justify="space-between" mb={4}>
          <Text size="sm">
            {formatBytes(usage.bytes)}
            {usage.storageLimit != null ? ` of ${formatBytes(usage.storageLimit)}` : ' used, no limit'}
          </Text>
          {near && <Badge color={share >= 100 ? 'red' : 'orange'} variant="light">{share >= 100 ? 'Full' : 'Almost full'}</Badge>}
        </Group>
        {usage.storageLimit != null && <Progress value={share} color={share >= 100 ? 'red' : near ? 'orange' : undefined} />}
        <Text size="xs" c="dimmed" mt={4}>
          {usage.fileCount} file{usage.fileCount === 1 ? '' : 's'} ({formatBytes(usage.files)}) and page history ({formatBytes(usage.history)}). When it is full, uploads and new history versions are refused.
        </Text>
      </div>
      <Text size="sm">
        {usage.pages} page{usage.pages === 1 ? '' : 's'}
        {usage.maxPages != null ? ` of ${usage.maxPages} allowed` : ', no limit'}
        {` · ${usage.comments} comment${usage.comments === 1 ? '' : 's'}`}
        {usage.maxComments != null ? ` of ${usage.maxComments} allowed` : ''}
        {usage.maxFileBytes != null ? ` · one file may weigh at most ${formatBytes(usage.maxFileBytes)}` : ''}
      </Text>
      {me.role === 'admin' ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.setWorkspaceLimits(workspaceId, {
                storageLimit: storageMb === '' || Number(storageMb) <= 0 ? null : Math.round(Number(storageMb) * MB),
                maxPages: pages === '' || Number(pages) <= 0 ? null : Math.floor(Number(pages)),
                maxComments: comments === '' || Number(comments) <= 0 ? null : Math.floor(Number(comments)),
              });
              setNote('Saved.');
              await load();
            } catch (err) {
              setNote('');
              onError(errorText(err));
            }
          }}
        >
          <Group align="end" wrap="wrap">
            <NumberInput label="Storage limit (MB)" description="Files and history. Empty = none" min={0} decimalScale={2} value={storageMb} onChange={setStorageMb} w={190} />
            <NumberInput label="Page limit" description="Empty = none" min={0} allowDecimal={false} value={pages} onChange={setPages} w={150} />
            <NumberInput label="Comment limit" description="Empty = none" min={0} allowDecimal={false} value={comments} onChange={setComments} w={150} />
            <Button type="submit" size="sm">Save limits</Button>
            {note && <Text size="sm" c="teal">{note}</Text>}
          </Group>
        </form>
      ) : (
        <Text size="xs" c="dimmed">Limits are set by this server's admin.</Text>
      )}
    </Stack>
  );
}
