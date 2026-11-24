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
  SegmentedControl,
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
  IconChevronRight,
  IconLogout,
  IconMoon,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconPaperclip,
  IconPlus,
  IconSearch,
  IconSelector,
  IconSettings,
  IconShieldLock,
  IconSun,
  IconUsersGroup,
  IconX,
} from '@tabler/icons-react';
import { DeletePageDialog } from './DeletePageDialog';
import { WorkspaceFiles } from './WorkspaceFiles';
import { WorkspaceForm } from './WorkspaceForm';
import { AdminPanel, Loading, OnceOpened, PageView, ProjectSettings, UserSettings, WorkspaceSettings } from './lazy';
import { getFavorites, requestFind } from './util';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, atLeast, type DeletePreview, type Me, type Page, type Project, type SearchHit, type Workspace } from './api';
import { PageTree } from './PageTree';
import { href, navigate } from './route';
import { colorFor, errorText, pollWhenVisible } from './util';

interface Props {
  me: Me;
  workspace: Workspace;
  pageId?: string;
  commentId?: string;
  dark: boolean;
  /** Reloads the signed-in user's workspaces; resolves once they are in place. */
  onMeChanged: () => void | Promise<unknown>;
  onSignOut: () => void;
  onError: (message: string) => void;
}

export function Shell({ me, workspace, pageId, commentId, dark, onMeChanged, onSignOut, onError }: Props) {
  const [navOpen, nav] = useDisclosure(false);
  // On a computer the sidebar can be hidden to give the page the whole window (remembered per browser).
  const [navHidden, setNavHidden] = useState(() => {
    try { return localStorage.getItem('cloud-doc-nav-hidden') === '1'; } catch { return false; }
  });
  // lets the stylesheet give the page more room while the explorer is away
  useEffect(() => {
    document.body.classList.toggle('nav-hidden', navHidden);
    return () => document.body.classList.remove('nav-hidden');
  }, [navHidden]);
  const hideNav = useCallback((hidden: boolean) => {
    setNavHidden(hidden);
    try { localStorage.setItem('cloud-doc-nav-hidden', hidden ? '1' : '0'); } catch { /* not remembered */ }
  }, []);
  useEffect(() => {
    // Ctrl/Cmd+\ hides or shows the sidebar
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === '\\') {
        event.preventDefault();
        hideNav(!navHidden);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navHidden, hideNav]);
  const phone = useMediaQuery('(max-width: 48em)');
  const { toggleColorScheme } = useMantineColorScheme();
  const [projects, setProjects] = useState<Project[]>([]);
  const [pages, setPages] = useState<Record<string, Page[]>>({});
  const [query, setQuery] = useState('');
  // Search either the words inside pages (on the server) or just page titles (instant, here, no request).
  const [searchMode, setSearchMode] = useState<'text' | 'title'>(() => {
    try { return localStorage.getItem('cloud-doc-search-mode') === 'title' ? 'title' : 'text'; } catch { return 'text'; }
  });
  const pickSearchMode = (mode: 'text' | 'title') => {
    setSearchMode(mode);
    try { localStorage.setItem('cloud-doc-search-mode', mode); } catch { /* not remembered */ }
  };
  // Projects folded shut in the explorer (remembered per browser).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('cloud-doc-collapsed') ?? '{}') as Record<string, boolean>; } catch { return {}; }
  });
  const toggleProject = (id: string) => setCollapsed((c) => {
    const next = { ...c, [id]: !c[id] };
    if (!next[id]) delete next[id];
    try { localStorage.setItem('cloud-doc-collapsed', JSON.stringify(next)); } catch { /* not remembered */ }
    return next;
  });
  const searchInput = useRef<HTMLInputElement>(null);
  const [favorites, setFavorites] = useState(getFavorites);
  useEffect(() => {
    const sync = () => setFavorites(getFavorites());
    window.addEventListener('cloud-doc-favorites', sync);
    // Ctrl/Cmd+K jumps to search from anywhere.
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('cloud-doc-favorites', sync);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [wsSettings, setWsSettings] = useState(false);
  const [projectDialog, setProjectDialog] = useState<{ project: Project | null } | null>(null);
  const [newWorkspace, setNewWorkspace] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  useEffect(() => {
    const open = () => setFilesOpen(true);
    window.addEventListener('cloud-doc-open-workspace-files', open);
    return () => window.removeEventListener('cloud-doc-open-workspace-files', open);
  }, []);
  const [userSettings, setUserSettings] = useState<'profile' | 'storage' | null>(null);
  const [admin, setAdmin] = useState(false);
  /** Files picked from the tree's "Upload file…", handed to the page once it's open. */
  const [pendingUpload, setPendingUpload] = useState<{ pageId: string; files: File[] } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<string | null>(null);
  const wid = workspace.id;

  // The whole tree comes in one request; state is only replaced when something changed, so a
  // poll that finds nothing new doesn't re-render the sidebar.
  const lastTree = useRef('');
  const members = useRef(2);
  const refresh = useCallback(async () => {
    try {
      const tree = await api.tree(wid);
      members.current = tree.members;
      const text = JSON.stringify(tree);
      if (text === lastTree.current) return;
      lastTree.current = text;
      setProjects(tree.projects);
      setPages(tree.pages);
    } catch (e) {
      onError(errorText(e));
    }
  }, [wid, onError]);

  useEffect(() => {
    refresh();
    // Other people's new pages and renames show up without a reload. Every refresh costs
    // one request per project, so poll slowly, only while the tab is visible, and never
    // twice within 30 s however often the window is focused.
    // On your own there is nobody else to hear from, so it only refreshes when you come back to the tab.
    let last = Date.now();
    return pollWhenVisible(() => {
      if (members.current <= 1 && Date.now() - last < 15 * 60_000) return;
      last = Date.now();
      refresh();
    }, 120_000, 45_000);
  }, [refresh]);


  useEffect(() => {
    if (!query.trim() || searchMode === 'title') return setHits(null);
    const t = setTimeout(() => api.search(wid, query).then(setHits, (e) => onError(errorText(e))), 200);
    return () => clearTimeout(t);
  }, [query, searchMode, wid, onError]);

  /** Opens a page. A search stays up (it only ends with its exit button), so several results can be visited in turn. */
  const open = (id: string | null, keepSearch = false) => {
    navigate(href.workspace(wid, id ?? undefined));
    if (!keepSearch) setQuery('');
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

  // Deleting asks first, and says what happens to the page's files (they belong to the workspace).
  const [deleting, setDeleting] = useState<{ page: Page; preview: DeletePreview | null } | null>(null);
  const deletePage = async (page: Page) => {
    setDeleting({ page, preview: null });
    try {
      setDeleting({ page, preview: await api.deletePreview(page.id) });
    } catch (e) {
      setDeleting(null);
      onError(errorText(e));
    }
  };
  const confirmDelete = async (deleteFiles: boolean) => {
    if (!deleting) return;
    const { page } = deleting;
    try {
      const outcome = await api.deletePage(page.id, deleteFiles ? 'delete' : 'keep');
      setDeleting(null);
      const list = pages[page.project_id] ?? [];
      const gone = new Set<string>();
      const collect = (id: string) => (gone.add(id), list.filter((p) => p.parent_id === id).forEach((c) => collect(c.id)));
      collect(page.id);
      setPages((m) => ({ ...m, [page.project_id]: list.filter((p) => !gone.has(p.id)) }));
      if (pageId && gone.has(pageId)) open(null);
      if (deleteFiles && outcome.filesKept > 0) onError(`Deleted. ${outcome.filesKept} file${outcome.filesKept === 1 ? ' was' : 's were'} kept because other pages use ${outcome.filesKept === 1 ? 'it' : 'them'} or you may not delete ${outcome.filesKept === 1 ? 'it' : 'them'}.`);
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

  const favoritePages = useMemo(() => {
    const all = Object.values(pages).flat();
    return favorites.map((id) => all.find((p) => p.id === id)).filter((p): p is Page => !!p);
  }, [favorites, pages]);
  const projectName = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p.name])), [projects]);
  // Title search: matching pages across the workspace, each with the pages above it, found without asking the server.
  const titleHits = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (searchMode !== 'title' || !q) return null;
    const all = Object.values(pages).flat();
    const byId = new Map(all.map((p) => [p.id, p]));
    const trail = (p: Page): string => {
      const names: string[] = [];
      for (let up = p.parent_id ? byId.get(p.parent_id) : undefined, n = 0; up && n < 8; up = up.parent_id ? byId.get(up.parent_id) : undefined, n++) names.unshift(up.title || 'Untitled');
      return [projectName[p.project_id] ?? '', ...names].filter(Boolean).join(' / ');
    };
    return all.filter((p) => (p.title || 'Untitled').toLocaleLowerCase().includes(q)).slice(0, 50).map((p) => ({ page: p, trail: trail(p) }));
  }, [query, searchMode, pages, projectName]);
  const linkFor = useCallback((id: string) => href.workspace(wid, id), [wid]);
  const showSidebar = (
    <Tooltip label="Show sidebar (Ctrl+\)">
      <ActionIcon variant="subtle" color="gray" size="lg" aria-label="Show sidebar" onClick={() => hideNav(false)}><IconLayoutSidebarLeftExpand size={18} /></ActionIcon>
    </Tooltip>
  );
  const themeToggle = (
    <Tooltip label={dark ? 'Light mode' : 'Dark mode'}>
      <ActionIcon variant="subtle" color="gray" size="lg" aria-label={dark ? 'Light mode' : 'Dark mode'} onClick={() => toggleColorScheme()}>
        {dark ? <IconSun size={18} /> : <IconMoon size={18} />}
      </ActionIcon>
    </Tooltip>
  );
  const burger = phone ? <Burger opened={navOpen} onClick={nav.toggle} size="sm" aria-label="Pages" /> : navHidden ? showSidebar : null;

  return (
    <AppShell navbar={{ width: 288, breakpoint: 'sm', collapsed: { mobile: !navOpen, desktop: navHidden } }} padding={0}>
      <AppShell.Navbar className="navbar">
        <AppShell.Section p="xs" pb={4}>
          <Group gap={4} wrap="nowrap">
            <Menu position="bottom-start" width={260} withinPortal>
              <Menu.Target>
                <UnstyledButton className="ws-switch" style={{ flex: 1, minWidth: 0 }}>
                  <Avatar size={26} radius="sm" color={colorFor(wid)} variant="filled">
                    {(workspace.displayName ?? workspace.name).slice(0, 1).toUpperCase()}
                  </Avatar>
                  <Text fw={600} size="sm" truncate="end" style={{ flex: 1 }}>
                    {workspace.displayName ?? workspace.name}
                  </Text>
                  <IconSelector size={14} />
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>Workspaces</Menu.Label>
                {me.workspaces.map((w) => (
                  <Menu.Item key={w.id} onClick={() => navigate(href.workspace(w.id))} fw={w.id === wid ? 600 : 400}>
                    {w.displayName ?? w.name}
                  </Menu.Item>
                ))}
                {(me.canCreateWorkspaces || me.user.role === 'admin') && (
                  <Menu.Item leftSection={<IconPlus size={15} />} onClick={() => setNewWorkspace(true)}>
                    New workspace
                  </Menu.Item>
                )}
              </Menu.Dropdown>
            </Menu>
            {phone && (
              <ActionIcon variant="subtle" color="gray" onClick={nav.close} aria-label="Close pages">
                <IconX size={18} />
              </ActionIcon>
            )}
          {!phone && (
              <Tooltip label="Hide sidebar (Ctrl+\)">
                <ActionIcon variant="subtle" color="gray" aria-label="Hide sidebar" onClick={() => hideNav(true)}><IconLayoutSidebarLeftCollapse size={18} /></ActionIcon>
              </Tooltip>
            )}
          </Group>
          <Group gap={4} mt={6} grow wrap="nowrap">
            <Button variant="subtle" color="gray" size="compact-sm" justify="flex-start" leftSection={<IconUsersGroup size={15} />} onClick={() => setWsSettings(true)} aria-label="Workspace settings">
              Settings
            </Button>
            <Button variant="subtle" color="gray" size="compact-sm" justify="flex-start" leftSection={<IconPaperclip size={15} />} onClick={() => setFilesOpen(true)} aria-label="Workspace files">
              Files
            </Button>
          </Group>
          <TextInput
            mt={6}
            size="sm"
            placeholder={searchMode === 'title' ? 'Find a page by title  (Ctrl K)' : 'Search pages  (Ctrl K)'}
            ref={searchInput}
            leftSection={<IconSearch size={15} />}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
            rightSection={query && <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Exit search" onClick={() => setQuery('')}><IconX size={14} /></ActionIcon>}
          />
          <SegmentedControl
            mt={6}
            size="xs"
            fullWidth
            value={searchMode}
            onChange={(v) => pickSearchMode(v as 'text' | 'title')}
            data={[{ value: 'text', label: 'Text' }, { value: 'title', label: 'Titles' }]}
            aria-label="What to search"
          />
        </AppShell.Section>
        <AppShell.Section grow component={ScrollArea} px="xs" type="auto">
          {titleHits ? (
            <Stack gap={2}>
              {titleHits.length === 0 && <Text size="sm" c="dimmed" p={8}>No page with that title</Text>}
              {titleHits.map(({ page: p, trail }) => (
                <div key={p.id} className={`hit${p.id === pageId ? ' is-active' : ''}`} onClick={() => open(p.id, true)}>
                  <div className="hit-title">{p.icon ? `${p.icon} ` : ''}{p.title || 'Untitled'}</div>
                  {trail && <div className="hit-project">{trail}</div>}
                </div>
              ))}
            </Stack>
          ) : hits ? (
            <Stack gap={2}>
              {hits.length === 0 && (
                <Text size="sm" c="dimmed" p={8}>
                  No matches
                </Text>
              )}
              {hits.map((h) => (
                <div key={h.id} className={`hit${h.id === pageId ? ' is-active' : ''}`}>
                  <div className="hit-title" onClick={() => open(h.id, true)}>{h.title || 'Untitled'} <span className="hit-project">· {projectName[h.project_id]}</span></div>
                  {h.matches.length > 0 ? h.matches.map((m) => (
                    <div
                      key={m.n}
                      className="hit-match"
                      title="Jump to this match"
                      onClick={() => {
                        requestFind({ pageId: h.id, words: query.split(/\s+/).filter(Boolean), n: m.n, before: m.before, text: m.text });
                        open(h.id, true);
                      }}
                    >
                      <span className="hit-before">…{m.before}</span><mark>{m.text}</mark><span className="hit-after">{m.after}…</span>
                    </div>
                  )) : (
                    // Title-only match: the page text has nothing to show.
                    <div className="hit-snippet" dangerouslySetInnerHTML={{ __html: escapeSnippet(h.snippet) }} />
                  )}
                </div>
              ))}
            </Stack>
          ) : (
            <>
            {favoritePages.length > 0 && (
              <div className="project">
                <Text size="xs" fw={600} c="dimmed" tt="uppercase" className="project-head">Favorites</Text>
                {favoritePages.map((p) => (
                  <div key={p.id} className={`hit${p.id === pageId ? ' is-active' : ''}`} onClick={() => open(p.id)}>
                    <div className="hit-title">{p.icon ? `${p.icon} ` : ''}{p.title || 'Untitled'}</div>
                  </div>
                ))}
              </div>
            )}
            {projects.map((project) => (
              <div key={project.id} className="project">
                <Group justify="space-between" className="project-head" wrap="nowrap" gap={0}>
                  <UnstyledButton
                    onClick={() => toggleProject(project.id)}
                    aria-expanded={!collapsed[project.id]}
                    aria-label={`${collapsed[project.id] ? 'Expand' : 'Collapse'} ${project.name}`}
                    style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: 1 }}
                  >
                    {collapsed[project.id] ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
                    <Text size="xs" fw={600} c="dimmed" tt="uppercase" truncate="end">
                      {project.name}
                    </Text>
                    {collapsed[project.id] && <Text size="xs" c="dimmed">({(pages[project.id] ?? []).length})</Text>}
                  </UnstyledButton>
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
                {!collapsed[project.id] && <PageTree
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
                />}
              </div>
            ))}
            </>
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
                Settings and storage
              </Menu.Item>
              {me.user.role === 'admin' && (
                <Menu.Item leftSection={<IconShieldLock size={15} />} onClick={() => setAdmin(true)}>
                  Admin
                </Menu.Item>
              )}
              <Menu.Divider />
              <Menu.Item color="red" leftSection={<IconLogout size={15} />} onClick={onSignOut}>
                Sign out
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </AppShell.Section>
      </AppShell.Navbar>
      <AppShell.Main className="main">
        {!pageId && !phone && navHidden && <div style={{ position: 'fixed', top: 8, left: 8, zIndex: 30 }}>{showSidebar}</div>}
        {pageId ? (
          <Loading>
          <PageView
            key={pageId}
            pageId={pageId}
            initialCommentId={commentId}
            me={me.user}
            dark={dark}
            leading={burger}
            trailing={themeToggle}
            linkFor={linkFor}
            onTitle={onTitle}
            onIcon={onIcon}
            onError={onError}
            pendingUpload={pendingUpload?.pageId === pageId ? pendingUpload.files : undefined}
            onPendingTaken={() => setPendingUpload(null)}
            onNeedStorage={() => setUserSettings('storage')}
          />
          </Loading>
        ) : (
          <div className="empty">
            {burger && <div className="empty-burger">{burger}</div>}
            <div style={{ position: 'absolute', top: 8, right: 8 }}>{themeToggle}</div>
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
      <OnceOpened open={wsSettings}>
      <WorkspaceSettings
        workspace={workspace}
        me={me.user}
        opened={wsSettings}
        onClose={() => setWsSettings(false)}
        onChanged={onMeChanged}
        onError={onError}
      />
      </OnceOpened>
      <OnceOpened open={!!projectDialog}>
      <ProjectSettings
        project={projectDialog?.project ?? null}
        workspaceId={wid}
        opened={!!projectDialog}
        onClose={() => setProjectDialog(null)}
        onChanged={() => refresh()}
        onError={onError}
      />
      </OnceOpened>
      <NewWorkspace
        opened={newWorkspace}
        onClose={() => setNewWorkspace(false)}
        onCreated={async (w) => {
          // The new workspace must be in the list before its address opens, or the app thinks it doesn't exist.
          await onMeChanged();
          navigate(href.workspace(w.id));
        }}
        onError={onError}
      />
      <OnceOpened open={!!userSettings}><UserSettings opened={!!userSettings} tab={userSettings ?? 'profile'} onClose={() => setUserSettings(null)} onChanged={onMeChanged} onError={onError} /></OnceOpened>
      {me.user.role === 'admin' && <OnceOpened open={admin}><AdminPanel me={me.user} opened={admin} onClose={() => setAdmin(false)} onError={onError} /></OnceOpened>}
      <WorkspaceFiles workspaceId={wid} opened={filesOpen} onClose={() => setFilesOpen(false)} me={me.user} pageId={pageId ?? null} canInsert={!!pageId} onOpenPage={(id) => open(id)} onError={onError} />
      <DeletePageDialog page={deleting?.page ?? null} preview={deleting?.preview ?? null} onCancel={() => setDeleting(null)} onConfirm={confirmDelete} />
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
  return (
    <Modal opened={opened} onClose={onClose} title="New workspace">
      {opened && <WorkspaceForm onCreated={(w) => { onCreated(w); onClose(); }} onError={onError} />}
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
