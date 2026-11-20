import {
  ActionIcon,
  Badge,
  Button,
  Card,
  CopyButton,
  Divider,
  Group,
  Loader,
  Modal,
  NumberInput,
  PasswordInput,
  SegmentedControl,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconCheck, IconCopy, IconLink, IconPlus, IconTrash, IconUserPlus, IconUsers } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { type AdminUser, api, type RegistrationLink, type Storage, type User } from './api';
import { href } from './route';
import { StorageManager } from './StorageManager';
import { errorText, formatBytes, timeAgo } from './util';

interface Props {
  me: User;
  opened: boolean;
  onClose: () => void;
  onError: (message: string) => void;
}

const MB = 1048576;

/** Instance admin: accounts, roles, limits, storages and registration links. */
export function AdminPanel({ me, opened, onClose, onError }: Props) {
  const phone = useMediaQuery('(max-width: 48em)');
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [links, setLinks] = useState<RegistrationLink[] | null>(null);
  const [editing, setEditing] = useState<AdminUser | 'new' | null>(null);

  const load = useCallback(() => {
    api.adminUsers().then(setUsers, (e) => onError(errorText(e)));
    api.adminLinks().then(setLinks, (e) => onError(errorText(e)));
  }, [onError]);
  useEffect(() => {
    if (opened) load();
  }, [opened, load]);

  return (
    <Modal opened={opened} onClose={onClose} title="Admin" size="xl" fullScreen={phone}>
      <Tabs defaultValue="users" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="users" leftSection={<IconUsers size={16} />}>
            Users
          </Tabs.Tab>
          <Tabs.Tab value="links" leftSection={<IconLink size={16} />}>
            Registration links
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="users">
          {!users ? (
            <Loader size="sm" />
          ) : editing ? (
            <UserEditor
              me={me}
              user={editing === 'new' ? null : editing}
              onDone={() => (setEditing(null), load())}
              onCancel={() => setEditing(null)}
              onError={onError}
            />
          ) : (
            <Stack gap="xs">
              <Button leftSection={<IconUserPlus size={16} />} variant="light" onClick={() => setEditing('new')} style={{ alignSelf: 'flex-start' }}>
                Add user
              </Button>
              {users.map((u) => (
                <Card key={u.id} withBorder padding="sm" radius="md" className="user-card" onClick={() => setEditing(u)}>
                  <Group justify="space-between" wrap="nowrap">
                    <div style={{ minWidth: 0 }}>
                      <Group gap={6}>
                        <Text fw={500}>{u.name}</Text>
                        {u.role === 'admin' && (
                          <Badge size="xs" variant="light">
                            Admin
                          </Badge>
                        )}
                        {!!u.disabled && (
                          <Badge size="xs" color="red" variant="light">
                            Disabled
                          </Badge>
                        )}
                      </Group>
                      <Text size="xs" c="dimmed" truncate="end">
                        {u.email}
                      </Text>
                    </div>
                    <div style={{ textAlign: 'right', flex: 'none' }}>
                      <Text size="xs">
                        {formatBytes(u.usage)}
                        {u.storage_limit != null && ` / ${formatBytes(u.storage_limit)}`}
                      </Text>
                      <Text size="xs" c={u.default_storage_name ? 'dimmed' : 'orange'}>
                        {u.default_storage_name ?? 'No storage'}
                      </Text>
                    </div>
                  </Group>
                </Card>
              ))}
            </Stack>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="links">
          <Links links={links} onChanged={load} onError={onError} />
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}

function UserEditor({
  me,
  user,
  onDone,
  onCancel,
  onError,
}: {
  me: User;
  user: AdminUser | null;
  onDone: () => void;
  onCancel: () => void;
  onError: (m: string) => void;
}) {
  const [email, setEmail] = useState(user?.email ?? '');
  const [name, setName] = useState(user?.name ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>(user?.role ?? 'member');
  const [canCreate, setCanCreate] = useState(user ? !!user.can_create_workspaces : true);
  const [limitMb, setLimitMb] = useState<number | string>(user?.storage_limit != null ? Math.round(user.storage_limit / MB) : '');
  const [disabled, setDisabled] = useState(!!user?.disabled);
  const [storages, setStorages] = useState<Storage[] | null>(null);
  const [defaultId, setDefaultId] = useState(user?.default_storage_id ?? null);
  const [busy, setBusy] = useState(false);

  const loadStorages = useCallback(() => {
    if (!user) return;
    api.storages(user.id).then(setStorages, (e) => onError(errorText(e)));
    api.adminUsers().then((all) => setDefaultId(all.find((u) => u.id === user.id)?.default_storage_id ?? null));
  }, [user, onError]);
  useEffect(loadStorages, [loadStorages]);

  const storageLimit = limitMb === '' ? null : Math.round(Number(limitMb) * MB);

  const save = async () => {
    setBusy(true);
    try {
      if (user) {
        await api.adminUpdateUser(user.id, {
          name: name.trim(),
          role,
          canCreateWorkspaces: canCreate,
          storageLimit,
          disabled,
          ...(password ? { password } : {}),
        });
      } else {
        await api.adminCreateUser({ email: email.trim(), name: name.trim(), password, role, canCreateWorkspaces: canCreate, storageLimit });
      }
      onDone();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <Title order={5}>{user ? user.name : 'New user'}</Title>
      <TextInput label="Email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} readOnly={!!user} variant={user ? 'filled' : 'default'} required />
      <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} required />
      <PasswordInput
        label={user ? 'Reset password' : 'Password'}
        description={user ? 'Leave empty to keep it. Resetting signs them out.' : 'At least 8 characters'}
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
        autoComplete="new-password"
      />
      <div>
        <Text size="sm" fw={500} mb={4}>
          Role
        </Text>
        <SegmentedControl
          value={role}
          onChange={(v) => setRole(v as 'admin' | 'member')}
          data={[
            { value: 'member', label: 'Member' },
            { value: 'admin', label: 'Admin' },
          ]}
        />
      </div>
      <Switch label="Can create workspaces" checked={canCreate || role === 'admin'} disabled={role === 'admin'} onChange={(e) => setCanCreate(e.currentTarget.checked)} />
      <NumberInput
        label="Storage limit (MB)"
        description="Files and page history in their storages. Empty = no limit."
        value={limitMb}
        onChange={setLimitMb}
        min={0}
        allowDecimal={false}
      />
      {user && user.id !== me.id && (
        <Switch label="Disabled (can't sign in)" color="red" checked={disabled} onChange={(e) => setDisabled(e.currentTarget.checked)} />
      )}
      <Group justify="space-between">
        {user && user.id !== me.id ? (
          <Button
            variant="subtle"
            color="red"
            leftSection={<IconTrash size={16} />}
            onClick={async () => {
              if (!confirm(`Delete ${user.name}'s account?`)) return;
              try {
                await api.adminDeleteUser(user.id);
                onDone();
              } catch (e) {
                onError(errorText(e));
              }
            }}
          >
            Delete
          </Button>
        ) : (
          <span />
        )}
        <Group gap="xs">
          <Button variant="default" onClick={onCancel}>
            Back
          </Button>
          <Button onClick={save} loading={busy} disabled={!name.trim() || (!user && (!email.trim() || password.length < 8))}>
            {user ? 'Save' : 'Create user'}
          </Button>
        </Group>
      </Group>
      {user && (
        <>
          <Divider label="WebDAV storage" labelPosition="left" />
          <Text size="sm" c="dimmed">
            Where {user.name}'s uploads and page history go. They can also manage this themselves in Settings.
          </Text>
          {storages ? (
            <StorageManager uid={user.id} storages={storages} defaultId={defaultId} onChanged={loadStorages} onError={onError} />
          ) : (
            <Loader size="sm" />
          )}
        </>
      )}
    </Stack>
  );
}

function Links({ links, onChanged, onError }: { links: RegistrationLink[] | null; onChanged: () => void; onError: (m: string) => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [days, setDays] = useState<number | string>(7);
  const url = (token: string) => new URL(href.register(token), window.location.origin).href;
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError(errorText(e));
    }
  };
  const status = (l: RegistrationLink) =>
    l.used_at ? `Used by ${l.used_by_name ?? 'a deleted user'} ${timeAgo(l.used_at)}` : l.expires_at && l.expires_at < Date.now() ? 'Expired' : l.expires_at ? `Expires ${new Date(l.expires_at).toLocaleDateString()}` : 'No expiry';

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Sign-up is closed. Send someone a link to create their account; each link works once.
      </Text>
      <Card withBorder padding="sm" radius="md">
        <Stack gap="xs">
          <TextInput label="For email (optional)" placeholder="Anyone with the link" value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
          <Group grow align="flex-end">
            <div>
              <Text size="sm" fw={500} mb={4}>
                Role
              </Text>
              <SegmentedControl
                fullWidth
                value={role}
                onChange={(v) => setRole(v as 'admin' | 'member')}
                data={[
                  { value: 'member', label: 'Member' },
                  { value: 'admin', label: 'Admin' },
                ]}
              />
            </div>
            <NumberInput label="Expires after (days)" value={days} onChange={setDays} min={0} max={365} />
          </Group>
          <Button
            leftSection={<IconPlus size={16} />}
            style={{ alignSelf: 'flex-start' }}
            onClick={() => run(async () => (await api.adminCreateLink({ email: email.trim() || undefined, role, expiresInDays: Number(days) || null }), setEmail('')))}
          >
            Create link
          </Button>
        </Stack>
      </Card>
      {!links ? (
        <Loader size="sm" />
      ) : (
        links.map((l) => (
          <Card key={l.token} withBorder padding="sm" radius="md">
            <Group justify="space-between" wrap="nowrap">
              <div style={{ minWidth: 0 }}>
                <Group gap={6}>
                  <Text size="sm" fw={500}>
                    {l.email ?? 'Anyone'}
                  </Text>
                  <Badge size="xs" variant="light" color={l.role === 'admin' ? 'grape' : 'gray'}>
                    {l.role}
                  </Badge>
                </Group>
                <Text size="xs" c="dimmed">
                  {status(l)}
                </Text>
                {!l.used_at && (
                  <Text size="xs" ff="monospace" truncate="end" className="link-url">
                    {url(l.token)}
                  </Text>
                )}
              </div>
              <Group gap={2} wrap="nowrap">
                {!l.used_at && (
                  <CopyButton value={url(l.token)}>
                    {({ copied, copy }) => (
                      <Tooltip label={copied ? 'Copied' : 'Copy link'}>
                        <ActionIcon variant="subtle" color={copied ? 'teal' : 'gray'} onClick={copy} aria-label="Copy link">
                          {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </CopyButton>
                )}
                <Tooltip label="Delete link">
                  <ActionIcon variant="subtle" color="red" onClick={() => run(() => api.adminDeleteLink(l.token))} aria-label="Delete link">
                    <IconTrash size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Group>
          </Card>
        ))
      )}
    </Stack>
  );
}
