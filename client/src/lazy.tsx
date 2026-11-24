import { lazy, type ReactNode, Suspense, useRef } from 'react';
import { Loader } from '@mantine/core';

// Heavy screens load when first needed, so signing in and the sidebar don't wait for the
// editor, the PDF viewer or the admin pages.
export const PageView = lazy(() => import('./PageView').then((m) => ({ default: m.PageView })));
export const AdminPanel = lazy(() => import('./AdminPanel').then((m) => ({ default: m.AdminPanel })));
export const WorkspaceSettings = lazy(() => import('./Settings').then((m) => ({ default: m.WorkspaceSettings })));
export const ProjectSettings = lazy(() => import('./Settings').then((m) => ({ default: m.ProjectSettings })));
export const WorkspaceFiles = lazy(() => import('./WorkspaceFiles').then((m) => ({ default: m.WorkspaceFiles })));
export const UserSettings = lazy(() => import('./UserSettings').then((m) => ({ default: m.UserSettings })));

// Start fetching the editor's code at once when the URL is a page, rather than after the sidebar mounts.
if (/^\/(w|s)\//.test(window.location.pathname)) void import('./PageView');

/** A centred spinner while a lazy screen's code arrives. */
export function Loading({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className="page-loading page-loading-static" role="status"><Loader size="md" /></div>}>
      {children}
    </Suspense>
  );
}

/** Dialogs: render nothing (and fetch nothing) until the first time they're opened. */
export function OnceOpened({ open, children }: { open: boolean; children: ReactNode }) {
  const seen = useRef(false);
  if (open) seen.current = true;
  return seen.current ? <Suspense fallback={null}>{children}</Suspense> : null;
}
