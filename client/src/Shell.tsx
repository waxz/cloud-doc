import {
  ActionIcon,
  AppShell,
  Avatar,
  Burger,
  Button,
  Group,
  Menu,
  Modal,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import {
  IconChevronDown,
  IconLogout,
  IconMoon,
  IconPlus,
  IconSearch,
  IconSelector,
  IconSettings,
  IconShieldLock,
  IconSun,
  IconDatabase,
  IconUsersGroup,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdminPanel } from './AdminPanel';
import { api, atLeast, type Me, type Page, type Project, type SearchHit, type Workspace } from './api';
import { PageTree } from './PageTree';
import { PageView } from './PageView';
import { href, navigate } from './route';
import { ProjectSettings, WorkspaceSettings } from './Settings';
import { UserSettings } from './UserSettings';
import { colorFor, errorText } from './util';

interface Props {
  me: Me;
  workspace: Workspace;
  pageId?: string;
  dark: boolean;
  onMeChanged: () => void;
  onSignOut: () => void;
  onError: (message: string) => void;
}

export function Shell({ me, workspace, pageId, dark, onMeChanged, onSignOut, onError }: Props) {
  const [navOpen, nav] = useDisclosure(false);
  const phone = useMediaQuery('(max-width: 48em)');
  const { toggleColorScheme } = useMantineColorScheme();
  const [projects, setProjects] = useState<Project[]>([]);
  const [pages, setPages] = useState<Record<string, Page[]>>({});
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [wsSettings, setWsSettings] = useState(false);
  const [projectDialog, setProjectDialog] = useState<{ project: Project | null } | null>(null);
  const [newWorkspace, setNewWorkspace] = useState(false);
  const [userSettings, setUserSettings] = useState<'profile' | 'storage' | null>(null);
  const [admin, setAdmin] = useState(false);
  /** Files picked from the tree's "Upload file…", handed to the page once it's open. */
  const [pendingUpload, setPendingUpload] = useState<{ pageId: string; files: File[] } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<string | null>(null);
  const wid = workspace.id;

  const refresh = useCallback(async () => {
    try {
      const list = await api.projects(wid);
      setProjects(list);
      const entries = await Promise.all(list.map(async (p) => [p.id, await api.pages(p.id)] as const));
      setPages(Object.fromEntries(entries));
    } catch (e) {
      onError(errorText(e));
    }
  }, [wid, onError]);

  useEffect(() => {
    refresh();
    // Other people's new pages and renames show up without a reload.
    const timer = setInterval(refresh, 20_000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  useEffect(() => {
    if (!query.trim()) return setHits(null);
    const t = setTimeout(() => api.search(wid, query).then(setHits, (e) => onError(errorText(e))), 200);
    return () => clearTimeout(t);
  }, [query, wid, onError]);

  const open = (id: string | null) => {
    navigate(href.workspace(wid, id ?? undefined));
    setQuery('');
    nav.close();
  };

  const createPage = async (projectId: string, parentId: string | null) => {
    try {
      const page = await api.createPage(projectId, parentId);
      setPages((m) => ({ ...m, [projectId]: [...(m[projectId] ?? []), page] }));
      open(page.id);
    } catch (e) {
      onError(errorText(e));
    }
  };

  const deletePage = async (page: Page) => {
    if (!confirm(`Delete "${page.title || 'Untitled'}" with its subpages, files and history?`)) return;
    try {
      await api.deletePage(page.id);
      const list = pages[page.project_id] ?? [];
      const gone = new Set<string>();
      const collect = (id: string) => (gone.add(id), list.filter((p) => p.parent_id === id).forEach((c) => collect(c.id)));
      collect(page.id);
      setPages((m) => ({ ...m, [page.project_id]: list.filter((p) => !gone.has(p.id)) }));
      if (pageId && gone.has(pageId)) open(null);
    } catch (e) {
      onError(errorText(e));
    }
  };

  const movePage = async (page: Page, parentId: string | null, position?: number) => {
    // Show it right away; the server's answer (or a reload on error) settles it.
    setPages((m) => ({
      ...m,
      [page.project_id]: (m[page.project_id] ?? []).map((p) => (p.id === page.id ? { ...p, parent_id: parentId, position: position ?? Number.MAX_SAFE_INTEGER } : p)),
    }));
    try {
      const moved = await api.movePage(page.id, parentId, position);
      // Only the placement: the title and icon here are fresher than the saved ones.
      setPages((m) => ({
        ...m,
        [page.project_id]: (m[page.project_id] ?? []).map((p) => (p.id === page.id ? { ...p, parent_id: moved.parent_id, position: moved.position } : p)),
      }));
    } catch (e) {
      onError(errorText(e));
      refresh();
    }
  };

  const patchPage = useCallback(
    (id: string, patch: Partial<Page>) =>
      setPages((m) => Object.fromEntries(Object.entries(m).map(([k, list]) => [k, list.map((p) => (p.id === id ? { ...p, ...patch } : p))]))),
    []
  );
  const onTitle = useCallback((id: string, title: string) => patchPage(id, { title }), [patchPage]);
  const onIcon = useCallback((id: string, icon: string) => patchPage(id, { icon }), [patchPage]);

  const projectName = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p.name])), [projects]);
  const linkFor = useCallback((id: string) => href.workspace(wid, id), [wid]);
  const burger = phone ? <Burger opened={navOpen} onClick={nav.toggle} size="sm" aria-label="Pages" /> : null;

  return (
    <AppShell navbar={{ width: 288, breakpoint: 'sm', collapsed: { mobile: !navOpen } }} padding={0}>
      <AppShell.Navbar className="navbar">
        <AppShell.Section p="xs" pb={4}>
          <Group gap={4} wrap="nowrap">
            <Menu position="bottom-start" width={260} withinPortal>
              <Menu.Target>
                <UnstyledButton className="ws-switch" style={{ flex: 1, minWidth: 0 }}>
                  <Avatar size={26} radius="sm" color={colorFor(wid)} variant="filled">
                    {workspace.name.slice(0, 1).toUpperCase()}
                  </Avatar>
                  <Text fw={600} size="sm" truncate="end" style={{ flex: 1 }}>
                    {workspace.name}
                  </Text>
                  <IconSelector size={14} />
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>Workspaces</Menu.Label>
                {me.workspaces.map((w) => (
                  <Menu.Item key={w.id} onClick={() => navigate(href.workspace(w.id))} fw={w.id === wid ? 600 : 400}>
                    {w.name}
                  </Menu.Item>
                ))}
                {(me.canCreateWorkspaces || me.user.role === 'admin') && (
                  <Menu.Item leftSection={<IconPlus size={15} />} onClick={() => setNewWorkspace(true)}>
                    New workspace
                  </Menu.Item>
                )}
                <Menu.Divider />
                <Menu.Item leftSection={<IconUsersGroup size={15} />} onClick={() => setWsSettings(true)}>
                  Workspace settings
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
            {phone && (
              <ActionIcon variant="subtle" color="gray" onClick={nav.close} aria-label="Close pages">
                <IconX size={18} />
              </ActionIcon>
            )}
          </Group>
          <TextInput
            mt={8}
            size="sm"
            placeholder="Search pages"
            leftSection={<IconSearch size={15} />}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            rightSection={query && <IconX size={14} style={{ cursor: 'pointer' }} onClick={() => setQuery('')} />}
          />
        </AppShell.Section>
        <AppShell.Section grow component={ScrollArea} px="xs" type="auto">
          {hits ? (
            <Stack gap={2}>
              {hits.length === 0 && (
                <Text size="sm" c="dimmed" p={8}>
                  No matches
                </Text>
              )}
              {hits.map((h) => (
                <div key={h.id} className="hit" onClick={() => open(h.id)}>
                  <div className="hit-title">{h.title || 'Untitled'}</div>
                  <div className="hit-project">{projectName[h.project_id]}</div>
                  {/* snippet() output: page text with <mark> tags added by FTS5 */}
                  <div className="hit-snippet" dangerouslySetInnerHTML={{ __html: escapeSnippet(h.snippet) }} />
                </div>
              ))}
            </Stack>
          ) : (
            projects.map((project) => (
              <div key={project.id} className="project">
                <Group justify="space-between" className="project-head" wrap="nowrap" gap={0}>
                  <Text size="xs" fw={600} c="dimmed" tt="uppercase" truncate="end">
                    {project.name}
                  </Text>
                  <Group gap={0} wrap="nowrap" className="project-actions">
                    {atLeast(project.role, 'admin') && (
                      <Tooltip label="Project settings">
                        <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => setProjectDialog({ project })} aria-label={`Settings for ${project.name}`}>
                          <IconSettings size={14} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                    {atLeast(project.role, 'editor') && (
                      <Tooltip label="New page">
                        <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => createPage(project.id, null)} aria-label={`New page in ${project.name}`}>
                          <IconPlus size={14} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Group>
                </Group>
                <PageTree
                  projectId={project.id}
                  pages={pages[project.id] ?? []}
                  canEdit={atLeast(project.role, 'editor')}
                  activeId={pageId}
                  linkFor={linkFor}
                  onOpen={open}
                  onCreate={(parentId) => createPage(project.id, parentId)}
                  onDelete={deletePage}
                  onMove={movePage}
                  onUpload={(p) => {
                    uploadTarget.current = p.id;
                    fileInput.current?.click();
                  }}
                />
              </div>
            ))
          )}
          <Button variant="subtle" color="gray" size="compact-sm" leftSection={<IconPlus size={14} />} onClick={() => setProjectDialog({ project: null })} my="xs">
            New project
          </Button>
        </AppShell.Section>
        <AppShell.Section p="xs" className="nav-footer">
          <Menu position="top-start" width={240} withinPortal>
            <Menu.Target>
              <UnstyledButton className="me-button">
                <Avatar size={28} radius="xl" color={colorFor(me.user.id)} variant="filled">
                  {me.user.name.slice(0, 1).toUpperCase()}
                </Avatar>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" fw={500} truncate="end">
                    {me.user.name}
                  </Text>
                  <Text size="xs" c="dimmed" truncate="end">
                    {me.user.email}
                  </Text>
                </div>
                <IconChevronDown size={14} />
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconSettings size={15} />} onClick={() => setUserSettings('profile')}>
                Settings
              </Menu.Item>
              <Menu.Item leftSection={<IconDatabase size={15} />} onClick={() => setUserSettings('storage')}>
                Storage
              </Menu.Item>
              {me.user.role === 'admin' && (
                <Menu.Item leftSection={<IconShieldLock size={15} />} onClick={() => setAdmin(true)}>
                  Admin
                </Menu.Item>
              )}
              <Menu.Item leftSection={dark ? <IconSun size={15} /> : <IconMoon size={15} />} onClick={() => toggleColorScheme()}>
                {dark ? 'Light mode' : 'Dark mode'}
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item color="red" leftSection={<IconLogout size={15} />} onClick={onSignOut}>
                Sign out
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </AppShell.Section>
      </AppShell.Navbar>
      <AppShell.Main className="main">
        {pageId ? (
          <PageView
            key={pageId}
            pageId={pageId}
            me={me.user}
            dark={dark}
            leading={burger}
            linkFor={linkFor}
            onTitle={onTitle}
            onIcon={onIcon}
            onError={onError}
            pendingUpload={pendingUpload?.pageId === pageId ? pendingUpload.files : undefined}
            onPendingTaken={() => setPendingUpload(null)}
            onNeedStorage={() => setUserSettings('storage')}
          />
        ) : (
          <div className="empty">
            {burger && <div className="empty-burger">{burger}</div>}
            <Stack align="center" gap="xs">
              <Text c="dimmed">Pick a page, or start a new one.</Text>
              {projects[0] && atLeast(projects[0].role, 'editor') && (
                <Button variant="light" leftSection={<IconPlus size={16} />} onClick={() => createPage(projects[0]!.id, null)}>
                  New page in {projects[0].name}
                </Button>
              )}
            </Stack>
          </div>
        )}
      </AppShell.Main>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = '';
          const target = uploadTarget.current;
          if (!target || !files.length) return;
          setPendingUpload({ pageId: target, files });
          open(target);
        }}
      />
      <WorkspaceSettings
        workspace={workspace}
        me={me.user}
        opened={wsSettings}
        onClose={() => setWsSettings(false)}
        onChanged={onMeChanged}
        onError={onError}
      />
      <ProjectSettings
        project={projectDialog?.project ?? null}
        workspaceId={wid}
        opened={!!projectDialog}
        onClose={() => setProjectDialog(null)}
        onChanged={() => refresh()}
        onError={onError}
      />
      <NewWorkspace
        opened={newWorkspace}
        onClose={() => setNewWorkspace(false)}
        onCreated={(w) => {
          onMeChanged();
          navigate(href.workspace(w.id));
        }}
        onError={onError}
      />
      <UserSettings opened={!!userSettings} tab={userSettings ?? 'profile'} onClose={() => setUserSettings(null)} onChanged={onMeChanged} onError={onError} />
      {me.user.role === 'admin' && <AdminPanel me={me.user} opened={admin} onClose={() => setAdmin(false)} onError={onError} />}
    </AppShell>
  );
}

export function NewWorkspace({
  opened,
  onClose,
  onCreated,
  onError,
}: {
  opened: boolean;
  onClose: () => void;
  onCreated: (w: Workspace) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  return (
    <Modal opened={opened} onClose={onClose} title="New workspace">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            onCreated(await api.createWorkspace(name.trim()));
            setName('');
            onClose();
          } catch (err) {
            onError(errorText(err));
          }
        }}
      >
        <Stack>
          <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
          <Button type="submit" disabled={!name.trim()}>
            Create
          </Button>
        </Stack>
      </form>
    </Modal>
  );
}

/** Escapes snippet text but keeps the <mark> highlights FTS5 inserted. */
function escapeSnippet(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>');
}
