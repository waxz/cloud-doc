import { ActionIcon, Badge, Button, Divider, Group, Modal, MultiSelect, Select, Stack, Switch, Table, Text, TextInput } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type Invite,
  type Member,
  type Project,
  type ProjectMember,
  ROLE_LABEL,
  type RegisteredMember,
  type Role,
  type User,
  type Workspace,
  type WorkspaceStorageInfo,
} from './api';
import { errorText } from './util';
import { WorkspaceBackup } from './WorkspaceBackup';
import { WorkspaceUsage } from './WorkspaceUsage';

interface WorkspaceProps {
  workspace: Workspace;
  me: User;
  opened: boolean;
  onClose: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
}

export function WorkspaceSettings({ workspace, me, opened, onClose, onChanged, onError }: WorkspaceProps) {
  const [name, setName] = useState(workspace.name);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [availableMembers, setAvailableMembers] = useState<RegisteredMember[]>([]);
  const [memberSearch, setMemberSearch] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [note, setNote] = useState('');
  const [workspaceStorages, setWorkspaceStorages] = useState<WorkspaceStorageInfo | null>(null);
  const isAdmin = workspace.role !== 'member';
  const isOwner = workspace.role === 'owner';
  const deleteWorkspace = async () => {
    if (!confirm(`Delete "${workspace.displayName}" with all projects, pages, files and history?`)) return;
    try {
      await api.deleteWorkspace(workspace.id);
      onClose();
      onChanged();
    } catch (e) {
      onError(errorText(e));
    }
  };

  const load = useCallback(async () => {
    try {
      const [r, available, storageInfo] = await Promise.all([
        api.members(workspace.id),
        isAdmin ? api.availableMembers(workspace.id, '') : Promise.resolve([]),
        isAdmin ? api.workspaceStorages(workspace.id) : Promise.resolve(null),
      ]);
      setMembers(r.members);
      setInvites(r.invites);
      setAvailableMembers(available);
      setWorkspaceStorages(storageInfo);
    } catch (e) {
      onError(errorText(e));
    }
  }, [workspace.id, isAdmin, onError]);
  useEffect(() => {
    if (opened) {
      setName(workspace.name);
      setNote('');
      setMemberSearch('');
      setEmail('');
      load();
    }
  }, [opened, workspace.name, load]);

  useEffect(() => {
    if (!opened || !isAdmin) return;
    const timeout = window.setTimeout(() => {
      api.availableMembers(workspace.id, memberSearch).then(setAvailableMembers, (e) => onError(errorText(e)));
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [opened, isAdmin, workspace.id, memberSearch, onError]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      onError(errorText(e));
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Workspace settings" size="lg">
      <Stack>
        <Group align="end">
          <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} disabled={!isAdmin} style={{ flex: 1 }} />
          {isOwner && (
            <Button variant="light" disabled={!name.trim() || name === workspace.name} onClick={() => run(async () => (await api.renameWorkspace(workspace.id, name.trim()), onChanged()))}>
              Rename
            </Button>
          )}
        </Group>
        {isAdmin && <WorkspaceUsage workspaceId={workspace.id} me={me} onError={onError} />}
        {isAdmin && workspaceStorages && (
          <>
            <Divider label="WebDAV storages" labelPosition="left" />
            <MultiSelect
              label="Where this workspace keeps its files and history"
              description="Everyone in the workspace uses these, without needing a storage of their own. Add your own storage or one the admin shared with you; the workspace always keeps at least one."
              data={workspaceStorages.storages.map((s) => ({ value: s.id, label: s.shared ? `${s.name} (shared)` : s.name }))}
              value={workspaceStorages.assigned}
              searchable
              onChange={(storageIds) => storageIds.length > 0 && run(() => api.setWorkspaceStorages(workspace.id, storageIds).then(load))}
              placeholder="Select a storage"
            />
          </>
        )}
        <Divider label="Members" labelPosition="left" />
        {isAdmin && (
          <Group align="end">
            <Select
              label="Add registered member"
              placeholder="Search name or email"
              searchable
              clearable
              nothingFoundMessage="No registered members found"
              value={email}
              onChange={(v) => setEmail(v ?? '')}
              onSearchChange={setMemberSearch}
              data={availableMembers.map((m) => ({ value: m.email, label: `${m.name} — ${m.email}` }))}
              style={{ flex: 1 }}
            />
            <Select w={120} value={role} onChange={(v) => v && setRole(v)} data={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]} allowDeselect={false} />
            <Button
              disabled={!email.trim()}
              onClick={() =>
                run(async () => {
                  const r = await api.addMember(workspace.id, email.trim(), role);
                  setNote(r.invited ? `${email.trim()} has no account yet; they'll join when they sign up with that email.` : '');
                  setEmail('');
                })
              }
            >
              Add
            </Button>
          </Group>
        )}
        {note && (
          <Text size="xs" c="dimmed">
            {note}
          </Text>
        )}
        <Table>
          <Table.Tbody>
            {members.map((m) => (
              <Table.Tr key={m.id}>
                <Table.Td>
                  <Text size="sm">{m.name}</Text>
                  <Text size="xs" c="dimmed">
                    {m.email}
                  </Text>
                </Table.Td>
                <Table.Td w={140}>
                  {m.role === 'owner' || !isAdmin ? (
                    <Badge variant="light">{m.role}</Badge>
                  ) : (
                    <Select size="xs" value={m.role} onChange={(v) => v && run(() => api.setMemberRole(workspace.id, m.id, v))} data={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]} allowDeselect={false} />
                  )}
                </Table.Td>
                <Table.Td w={40}>
                  {m.role !== 'owner' && (isAdmin || m.id === me.id) && (
                    <ActionIcon variant="subtle" color="red" aria-label={m.id === me.id ? 'Leave' : 'Remove'} onClick={() => run(() => api.removeMember(workspace.id, m.id))}>
                      ×
                    </ActionIcon>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
            {invites.map((i) => (
              <Table.Tr key={i.email}>
                <Table.Td>
                  <Text size="sm">{i.email}</Text>
                  <Text size="xs" c="dimmed">
                    Invited, no account yet
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge variant="outline">{i.role}</Badge>
                </Table.Td>
                <Table.Td>
                  {isAdmin && (
                    <ActionIcon variant="subtle" color="red" aria-label="Remove invite" onClick={() => run(() => api.removeInvite(workspace.id, i.email))}>
                      ×
                    </ActionIcon>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {isOwner && <WorkspaceBackup workspace={workspace} onChanged={() => { void load(); onChanged(); }} onError={onError} />}
        {isOwner && (
          <>
            <Divider />
            <Button variant="light" color="red" onClick={deleteWorkspace} style={{ alignSelf: 'flex-start' }}>
              Delete workspace
            </Button>
          </>
        )}
      </Stack>
    </Modal>
  );
}

const DEFAULT_ROLE_OPTIONS = [
  { value: 'none', label: 'Private: only people added below' },
  ...(['viewer', 'commenter', 'editor', 'admin'] as Role[]).map((r) => ({ value: r, label: `Everyone in the workspace: ${ROLE_LABEL[r].toLowerCase()}` })),
];

interface ProjectProps {
  project: Project | null;
  /** Null while creating a new project. */
  workspaceId: string;
  opened: boolean;
  onClose: () => void;
  onChanged: (created?: Project) => void;
  onError: (message: string) => void;
}

export function ProjectSettings({ project, workspaceId, opened, onClose, onChanged, onError }: ProjectProps) {
  const [name, setName] = useState('');
  const [defaultRole, setDefaultRole] = useState('editor');
  const [readOnly, setReadOnly] = useState(false);
  const [members, setMembers] = useState<ProjectMember[]>([]);

  useEffect(() => {
    if (!opened) return;
    setName(project?.name ?? '');
    setDefaultRole(project ? (project.defaultRole ?? 'none') : 'editor');
    setReadOnly(!!project?.readOnly);
    if (project) api.projectMembers(project.id).then(setMembers, (e) => onError(errorText(e)));
    else setMembers([]);
  }, [opened, project, onError]);

  const roleValue = (v: string): Role | null => (v === 'none' ? null : (v as Role));

  const save = async () => {
    try {
      if (project) {
        await api.updateProject(project.id, { name: name.trim(), defaultRole: roleValue(defaultRole), readOnly });
        onChanged();
      } else {
        onChanged(await api.createProject(workspaceId, name.trim(), roleValue(defaultRole), readOnly));
      }
      onClose();
    } catch (e) {
      onError(errorText(e));
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={project ? 'Project settings' : 'New project'} size="lg">
      <Stack>
        <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
        <Select label="Who has access" value={defaultRole} onChange={(v) => v && setDefaultRole(v)} data={DEFAULT_ROLE_OPTIONS} allowDeselect={false} />
        <Switch
          label="Read only"
          description="Everyone with access can read this project but not edit it, whatever their role below. Workspace owners and admins (and this project's admins) still can: good for a demo or reference project. Leave it off and any member with edit access can edit."
          checked={readOnly}
          onChange={(e) => setReadOnly(e.currentTarget.checked)}
        />
        <Group justify="space-between">
          {project ? (
            <Button
              variant="subtle"
              color="red"
              onClick={async () => {
                if (!confirm(`Delete "${project.name}" with all its pages, files and history?`)) return;
                try {
                  await api.deleteProject(project.id);
                  onChanged();
                  onClose();
                } catch (e) {
                  onError(errorText(e));
                }
              }}
            >
              Delete project
            </Button>
          ) : (
            <span />
          )}
          <Button disabled={!name.trim()} onClick={save}>
            {project ? 'Save' : 'Create'}
          </Button>
        </Group>
        {project && (
          <>
            <Divider label="People" labelPosition="left" />
            <Text size="xs" c="dimmed">
              Workspace owners and admins can always administer every project. Someone's role here is the higher of the default above and
              what you pick for them.
            </Text>
            <Table>
              <Table.Tbody>
                {members.map((m) => (
                  <Table.Tr key={m.id}>
                    <Table.Td>
                      <Text size="sm">{m.name}</Text>
                      <Text size="xs" c="dimmed">
                        {m.email}
                      </Text>
                    </Table.Td>
                    <Table.Td w={190}>
                      {m.workspace_role !== 'member' ? (
                        <Badge variant="light">Workspace {m.workspace_role}</Badge>
                      ) : (
                        <Select
                          size="xs"
                          value={m.role ?? 'default'}
                          data={[{ value: 'default', label: 'Default' }, ...(['viewer', 'commenter', 'editor', 'admin'] as Role[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))]}
                          allowDeselect={false}
                          onChange={async (v) => {
                            try {
                              await api.setProjectMember(project.id, m.id, v === 'default' ? null : (v as Role));
                              setMembers(await api.projectMembers(project.id));
                            } catch (e) {
                              onError(errorText(e));
                            }
                          }}
                        />
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </>
        )}
      </Stack>
    </Modal>
  );
}
