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
  Select,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconChartBar, IconDatabase, IconCheck, IconCopy, IconLink, IconPlus, IconSettings, IconTrash, IconUserPlus, IconUsers } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { type AdminUser, api, type InstanceSettings, type RegistrationLink, type Storage, type User } from './api';
import { href } from './route';
import { SharedStorages } from './SharedStorages';
import { UsagePanel } from './UsagePanel';
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
          <Tabs.Tab value="storage" leftSection={<IconDatabase size={16} />}>
            Storage
          </Tabs.Tab>
          <Tabs.Tab value="usage" leftSection={<IconChartBar size={16} />}>
            Usage
          </Tabs.Tab>
          <Tabs.Tab value="settings" leftSection={<IconSettings size={16} />}>
            Settings
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
                      <Text size="xs">{formatBytes(u.usage)}</Text>
                      <Text size="xs" c={u.own_storages + u.shared_storages ? 'dimmed' : 'orange'}>
                        {u.own_storages + u.shared_storages ? `${u.own_storages} own · ${u.shared_storages} shared` : 'No storage'}
                      </Text>
                    </div>
                  </Group>
                </Card>
              ))}
            </Stack>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="storage">
          <SharedStorages onError={onError} />
        </Tabs.Panel>
        <Tabs.Panel value="usage">
          <UsagePanel onError={onError} />
        </Tabs.Panel>
        <Tabs.Panel value="settings">
          <InstanceSettings onError={onError} />
        </Tabs.Panel>
        <Tabs.Panel value="links">
          <Links links={links} onChanged={load} onError={onError} />
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}

/** The contact email people see on the sign-in page, and the state of recovery mode. */
function InstanceSettings({ onError }: { onError: (m: string) => void }) {
  const [saved, setSaved] = useState<InstanceSettings | null>(null);
  const [email, setEmail] = useState('');
  const MB = 1048576;
  const [defStorage, setDefStorage] = useState<number | string>('');
  const [defPages, setDefPages] = useState<number | string>('');
  const [fileMb, setFileMb] = useState<number | string>('');
  const [limitNote, setLimitNote] = useState('');
  const [rateMin, setRateMin] = useState<number | string>(600);
  const [rateHour, setRateHour] = useState<number | string>('');
  const [cap, setCap] = useState<number | string>('');
  const [defComments, setDefComments] = useState<number | string>('');
  const [pageMb, setPageMb] = useState<number | string>(10);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const show = (s: InstanceSettings) => (setSaved(s), setEmail(s.adminEmail), setDefStorage(s.defaultStorageLimit ? +(s.defaultStorageLimit / MB).toFixed(2) : ''), setDefPages(s.defaultMaxPages ?? ''), setFileMb(s.maxFileBytes ? +(s.maxFileBytes / MB).toFixed(2) : ''), setRateMin(s.ratePerMinute), setRateHour(s.ratePerHour || ''), setCap(s.playgroundMaxUsers ?? ''), setDefComments(s.defaultMaxComments ?? ''), setPageMb(+(s.maxPageBytes / MB).toFixed(2)));
  const [note, setNote] = useState('');
  useEffect(() => {
    api.adminSettings().then(show, (e) => onError(errorText(e)));
    api.adminWorkspaces().then(setWorkspaces, () => undefined);
  }, [onError]);
  if (!saved) return <Loader size="sm" />;
  return (
    <Stack gap="lg" maw={560}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const next = await api.setAdminSettings({ adminEmail: email });
            setSaved(next);
            setEmail(next.adminEmail);
            setNote(next.adminEmail ? 'Saved. It now shows on the sign-in page.' : 'Removed from the sign-in page.');
          } catch (err) {
            setNote('');
            onError(errorText(err));
          }
        }}
      >
        <Stack gap="xs">
          <TextInput
            label="Admin contact email"
            description="Shown on the sign-in page, so people who forget their password can email you to have it reset. Leave empty to show nothing."
            placeholder="admin@example.com"
            type="email"
            value={email}
            onChange={(e) => (setEmail(e.currentTarget.value), setNote(''))}
          />
          <Group>
            <Button type="submit" size="xs" disabled={email.trim() === saved.adminEmail}>Save</Button>
            {note && <Text size="sm" c="teal">{note}</Text>}
          </Group>
        </Stack>
      </form>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const n = (v: number | string) => (v === '' || Number(v) <= 0 ? null : Number(v));
          try {
            show(await api.setAdminSettings({
              defaultStorageLimit: n(defStorage) == null ? null : Math.round(n(defStorage)! * MB),
              defaultMaxPages: n(defPages) == null ? null : Math.floor(n(defPages)!),
              maxFileBytes: n(fileMb) == null ? null : Math.round(n(fileMb)! * MB),
              ratePerMinute: rateMin === '' ? null : Math.max(0, Math.floor(Number(rateMin))),
              ratePerHour: rateHour === '' ? null : Math.max(0, Math.floor(Number(rateHour))),
              playgroundMaxUsers: n(cap),
              defaultMaxComments: n(defComments) == null ? null : Math.floor(n(defComments)!),
              maxPageBytes: n(pageMb) == null ? null : Math.round(n(pageMb)! * MB),
            }));
            setLimitNote('Saved.');
          } catch (err) {
            setLimitNote('');
            onError(errorText(err));
          }
        }}
      >
        <Stack gap="xs">
          <Text fw={600} size="sm">Limits for a playground</Text>
          <Text size="sm" c="dimmed">
            To let people try the app without a risk to your storage or your Cloudflare allowance, give new workspaces a storage limit and a page limit, and cap the size of a single file.
            Each workspace's own limits (open its settings from the sidebar, as admin) can be changed afterwards. Empty means no limit.
          </Text>
          <Group align="end" wrap="wrap">
            <NumberInput label="New workspaces: storage (MB)" description="Files and page history" min={0} decimalScale={2} value={defStorage} onChange={(v) => (setDefStorage(v), setLimitNote(''))} w={210} />
            <NumberInput label="New workspaces: pages" min={0} allowDecimal={false} value={defPages} onChange={(v) => (setDefPages(v), setLimitNote(''))} w={170} />
            <NumberInput label="New workspaces: comments" min={0} allowDecimal={false} value={defComments} onChange={(v) => (setDefComments(v), setLimitNote(''))} w={190} />
            <NumberInput label="Largest page (MB)" description="Past it a page is locked for editors. Default 10" min={0} decimalScale={2} value={pageMb} onChange={(v) => (setPageMb(v), setLimitNote(''))} w={230} />
            <NumberInput label="Largest single file (MB)" description="Applies everywhere" min={0} decimalScale={2} value={fileMb} onChange={(v) => (setFileMb(v), setLimitNote(''))} w={200} />
            <NumberInput label="Requests per person per minute" description="0 = no limit; admins are exempt" min={0} allowDecimal={false} value={rateMin} onChange={(v) => (setRateMin(v), setLimitNote(''))} w={230} />
            <NumberInput label="Requests per person per hour" description="Empty or 0 = no limit" min={0} allowDecimal={false} value={rateHour} onChange={(v) => (setRateHour(v), setLimitNote(''))} w={230} />
            <NumberInput label="Stop open sign-up at (accounts)" description={`Now ${saved.accounts}. Empty = no cap`} min={0} allowDecimal={false} value={cap} onChange={(v) => (setCap(v), setLimitNote(''))} w={230} />
            <Button type="submit" size="xs">Save limits</Button>
            {limitNote && <Text size="sm" c="teal">{limitNote}</Text>}
          </Group>
        </Stack>
      </form>
      <Stack gap="xs">
        <Switch
          label="Open registration (playground)"
          description="Anyone can create an account from the sign-in page, without a registration link. New accounts are plain members of the playground workspace below and cannot create workspaces of their own. Turn it off to close sign-up again; accounts already made keep working."
          checked={saved.openRegistration}
          disabled={!saved.playgroundWorkspace}
          onChange={async (e) => {
            try {
              show(await api.setAdminSettings({ openRegistration: e.currentTarget.checked }));
            } catch (err) {
              onError(errorText(err));
            }
          }}
        />
        <Select
          label="Playground workspace"
          description="Where new accounts land. Give it limits in its settings, and make its Demo project read-only (project settings); other projects can be edited by any member."
          placeholder={workspaces.length ? 'Choose a workspace' : 'No workspaces yet'}
          data={workspaces.map((w) => ({ value: w.id, label: w.name }))}
          value={saved.playgroundWorkspace}
          clearable
          searchable
          onChange={async (id) => {
            try {
              show(await api.setAdminSettings({ playgroundWorkspace: id }));
            } catch (err) {
              onError(errorText(err));
            }
          }}
        />
        {saved.openRegistration && <Badge color="orange" variant="light" w="fit-content">Sign-up is open</Badge>}
      </Stack>
      <div>
        <Group gap="xs" mb={4}>
          <Text fw={600} size="sm">Recovery mode</Text>
          <Badge color={saved.recoveryEnabled ? 'teal' : 'gray'} variant="light">{saved.recoveryEnabled ? 'On' : 'Off'}</Badge>
        </Group>
        <Text size="sm" c="dimmed">
          If you ever forget the admin password, recovery mode lets you set a new one from the sign-in page with a secret only the Worker's owner knows.
          {saved.recoveryEnabled
            ? ' It is on: to change the secret, edit RECOVERY_SECRET in the Cloudflare dashboard (Workers & Pages → this Worker → Settings → Variables and Secrets).'
            : ' To turn it on, add a secret named RECOVERY_SECRET (16 or more characters) in the Cloudflare dashboard: Workers & Pages → this Worker → Settings → Variables and Secrets. Change it there any time.'}
        </Text>
      </div>
    </Stack>
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
  const [disabled, setDisabled] = useState(!!user?.disabled);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      if (user) {
        await api.adminUpdateUser(user.id, {
          name: name.trim(),
          role,
          canCreateWorkspaces: canCreate,
          disabled,
          ...(password ? { password } : {}),
        });
      } else {
        await api.adminCreateUser({ email: email.trim(), name: name.trim(), password, role, canCreateWorkspaces: canCreate });
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
        <Text size="xs" c="dimmed">
          Storages are set up by their owners. To give {user.name} room to create workspaces without a storage of their own, share one of yours under Storage.
        </Text>
      )}
    </Stack>
  );
}

function Links({ links, onChanged, onError }: { links: RegistrationLink[] | null; onChanged: () => void; onError: (m: string) => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [days, setDays] = useState<number | string>(7);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [storages, setStorages] = useState<{ id: string; name: string }[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [storageId, setStorageId] = useState<string | null>(null);
  const [limit, setLimit] = useState<number | string>('');
  useEffect(() => {
    api.adminWorkspaces().then(setWorkspaces, (e) => onError(errorText(e)));
    api.adminSharedStorages().then(setStorages, (e) => onError(errorText(e)));
  }, [onError]);
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
          <Group grow align="flex-start">
            <Select
              label="Add to workspace (optional)"
              placeholder="None"
              clearable
              searchable
              data={workspaces.map((w) => ({ value: w.id, label: w.name }))}
              value={workspaceId}
              onChange={setWorkspaceId}
              nothingFoundMessage="No workspaces yet"
            />
            <Select
              label="Share a storage (optional)"
              placeholder="None"
              clearable
              data={storages.map((s) => ({ value: s.id, label: s.name }))}
              value={storageId}
              onChange={setStorageId}
              nothingFoundMessage="Add a shared storage first"
            />
          </Group>
          {storageId && (
            <NumberInput label="Storage limit for this person" placeholder="No limit" suffix=" MB" min={0} allowDecimal={false} value={limit} onChange={setLimit} />
          )}
          <Text size="xs" c="dimmed">
            The new account joins the workspace and can create its own on the shared storage, so there is nothing to set up after signing up.
          </Text>
          <Button
            leftSection={<IconPlus size={16} />}
            style={{ alignSelf: 'flex-start' }}
            onClick={() =>
              run(async () => {
                await api.adminCreateLink({
                  email: email.trim() || undefined,
                  role,
                  expiresInDays: Number(days) || null,
                  workspaceId,
                  storageId,
                  limitBytes: storageId && limit !== '' ? Number(limit) * MB : null,
                });
                setEmail('');
              })
            }
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
                {(l.workspace_name || l.storage_name) && (
                  <Text size="xs" c="dimmed">
                    {[l.workspace_name && `Joins ${l.workspace_name}`, l.storage_name && `Storage ${l.storage_name}${l.limit_bytes != null ? ` (${Math.round(l.limit_bytes / MB)} MB)` : ''}`].filter(Boolean).join(' · ')}
                  </Text>
                )}
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
