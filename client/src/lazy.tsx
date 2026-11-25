import { Component, lazy, type ReactNode, Suspense, useRef } from 'react';
import { Button, Loader, Stack, Text } from '@mantine/core';

// Heavy screens load when first needed, so signing in and the sidebar don't wait for the
// editor, the PDF viewer or the admin pages.
export const PageView = lazy(() => import('./PageView').then((m) => ({ default: m.PageView })));
export const AdminPanel = lazy(() => import('./AdminPanel').then((m) => ({ default: m.AdminPanel })));
export const WorkspaceSettings = lazy(() => import('./Settings').then((m) => ({ default: m.WorkspaceSettings })));
export const ProjectSettings = lazy(() => import('./Settings').then((m) => ({ default: m.ProjectSettings })));
export const WorkspaceFiles = lazy(() => import('./WorkspaceFiles').then((m) => ({ default: m.WorkspaceFiles })));
export const UserSettings = lazy(() => import('./UserSettings').then((m) => ({ default: m.UserSettings })));

// (The editor's code is deliberately not fetched ahead of time with a second import(): an old Safari that fails to run the
// chunk once can answer the second import() with a half-run module, which shows up as nonsense errors; a single import
// reports the real one.)

/**
 * When a screen's code can't be loaded or fails as it starts (an old browser that can't read it, a connection that dropped
 * halfway), say so and show why, with a way to try again: otherwise React removes everything and the page is just blank.
 */
class LoadErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty" role="alert">
        <Stack align="center" gap="xs" maw={420} px="md">
          <Text fw={600}>This page couldn't be shown</Text>
          <Text size="sm" c="dimmed" ta="center">
            Part of the app didn't load or didn't start in this browser. Reloading often fixes a dropped connection; if it keeps happening, updating iOS or the browser may help.
          </Text>
          <Text size="xs" c="dimmed" ta="center" style={{ wordBreak: 'break-word' }}>{String(this.state.error.message || this.state.error).slice(0, 300)}</Text>
          <Button variant="light" onClick={() => window.location.reload()}>Reload</Button>
        </Stack>
      </div>
    );
  }
}

/** A centred spinner while a lazy screen's code arrives (and a clear message if it never does). */
export function Loading({ children }: { children: ReactNode }) {
  return (
    <LoadErrorBoundary>
      <Suspense fallback={<div className="page-loading page-loading-static" role="status"><Loader size="md" /></div>}>
        {children}
      </Suspense>
    </LoadErrorBoundary>
  );
}

/** Dialogs: render nothing (and fetch nothing) until the first time they're opened. */
export function OnceOpened({ open, children }: { open: boolean; children: ReactNode }) {
  const seen = useRef(false);
  if (open) seen.current = true;
  return seen.current ? <Suspense fallback={null}>{children}</Suspense> : null;
}
