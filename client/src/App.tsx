import { WorkspaceForm } from './WorkspaceForm';
import { Alert, Button, Loader, Paper, Stack, Text, TextInput, Title, useComputedColorScheme } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type Me } from './api';
import { AuthScreen } from './AuthScreen';
import { href, navigate, useRoute } from './route';
import { SharedView } from './SharedView';
import { Shell } from './Shell';
import { errorText } from './util';

export function App() {
  const route = useRoute();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  /** Whether this is a fresh install (no accounts yet), asked when signed out. */
  const [setup, setSetup] = useState<boolean | undefined>(undefined);
  const [contact, setContact] = useState({ adminEmail: '', recovery: false });
  // Set when the very first requests fail, so the page says so (with a Retry) instead of spinning for ever.
  const [unreachable, setUnreachable] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState('');
  const dark = useComputedColorScheme('light') === 'dark';
  const onError = useCallback((m: string) => setError(m), []);

  const loadMe = useCallback(
    () =>
      api.me().then((m) => (setUnreachable(''), setMe(m)), (e) => {
        if (e instanceof ApiError && e.status === 401) (setUnreachable(''), setMe(null));
        else setUnreachable(errorText(e));
      }),
    []
  );
  useEffect(() => {
    loadMe();
  }, [loadMe]);
  useEffect(() => {
    if (me === null) api.authStatus().then((s) => (setUnreachable(''), setSetup(s.setup), setContact({ adminEmail: s.adminEmail, recovery: s.recovery })), (e) => setUnreachable(errorText(e)));
  }, [me]);
  // A registration link opened while signed in: nothing to do there.
  useEffect(() => {
    if (me && route.name === 'register') navigate('/');
  }, [me, route.name]);

  // Home (or a workspace you're not in): go to your first workspace, if any.
  const known = route.name === 'workspace' && !!me?.workspaces.some((w) => w.id === route.wid);
  const firstId = me?.workspaces[0]?.id;
  // A workspace address we don't know yet (just created, or just joined): reload the list once before deciding it isn't there.
  const refreshedFor = useRef('');
  useEffect(() => {
    if (!me || route.name === 'share' || known) return;
    if (route.name === 'workspace' && refreshedFor.current !== route.wid) {
      refreshedFor.current = route.wid;
      void loadMe();
      return;
    }
    if (firstId) {
      if (route.name === 'workspace') setError("That workspace doesn't exist, or you aren't a member of it.");
      navigate(href.workspace(firstId));
    }
  }, [me, route.name, route.name === 'workspace' ? route.wid : '', known, firstId, loadMe]);

  const banner = error && (
    <Alert color="red" variant="filled" className="error" withCloseButton onClose={() => setError('')}>
      {error}
    </Alert>
  );

  const retry = () => {
    setUnreachable('');
    void loadMe();
    if (me === null) api.authStatus().then((s) => (setSetup(s.setup), setContact({ adminEmail: s.adminEmail, recovery: s.recovery })), (e) => setUnreachable(errorText(e)));
  };
  if (unreachable && (me === undefined || (me === null && setup === undefined))) {
    return (
      <div className="auth">
        <Paper withBorder radius="lg" p="xl" w={420} maw="100%">
          <Stack gap="sm">
            <Title order={4}>Can't reach Cloud Doc</Title>
            <Text size="sm" c="dimmed">{unreachable}.</Text>
            <Text size="xs" c="dimmed">
              If this keeps happening: on Cloudflare's free plan a Worker stops answering for the rest of the day after 100,000 requests (or when its database allowance is used up), and starts again at 00:00 UTC.
            </Text>
            <Button onClick={retry}>Try again</Button>
          </Stack>
        </Paper>
      </div>
    );
  }
  if (me === undefined) return <Loader m="xl" size="sm" />;

  const signOut = async () => {
    await api.logout();
    setMe(null);
    navigate('/');
  };

  if (route.name === 'share' && !signingIn) {
    return (
      <>
        {banner}
        <SharedView token={route.token} pageId={route.pageId} me={me} dark={dark} onSignIn={() => setSigningIn(true)} onError={onError} />
      </>
    );
  }

  if (!me) {
    if (setup === undefined) return <Loader m="xl" size="sm" />;
    const mode = setup ? ({ kind: 'setup' } as const) : route.name === 'register' ? ({ kind: 'register', token: route.token } as const) : ({ kind: 'signin' } as const);
    return (
      <>
        {banner}
        <AuthScreen
          mode={mode}
          adminEmail={contact.adminEmail}
          recovery={contact.recovery}
          note={signingIn ? 'Sign in to use this link.' : undefined}
          onAuthed={(m) => {
            setMe(m);
            setSigningIn(false);
            if (route.name === 'register') navigate('/');
          }}
        />
      </>
    );
  }

  if (route.name === 'workspace') {
    const workspace = me.workspaces.find((w) => w.id === route.wid);
    if (workspace) {
      return (
        <>
          {banner}
          <Shell me={me} workspace={workspace} pageId={route.pageId} commentId={route.commentId} dark={dark} onMeChanged={loadMe} onSignOut={signOut} onError={onError} />
        </>
      );
    }
  }

  if (firstId) return null; // redirecting to it
  return (
    <>
      {banner}
      <FirstWorkspace canCreate={me.canCreateWorkspaces || me.user.role === 'admin'} onCreated={loadMe} onSignOut={signOut} onError={onError} />
    </>
  );
}

function FirstWorkspace({
  canCreate,
  onCreated,
  onSignOut,
  onError,
}: {
  canCreate: boolean;
  onCreated: () => void;
  onSignOut: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState('');
  if (!canCreate) {
    return (
      <div className="auth">
        <Paper withBorder radius="lg" p="xl" w={400} maw="100%">
          <Stack>
            <Title order={4}>No workspace yet</Title>
            <Text size="sm" c="dimmed">
              You're not in a workspace yet. Ask someone to add you to theirs, then reload this page.
            </Text>
            <Button variant="subtle" onClick={onSignOut}>
              Sign out
            </Button>
          </Stack>
        </Paper>
      </div>
    );
  }
  return (
    <div className="auth">
      <Paper withBorder radius="md" p="lg" w={380} maw="calc(100vw - 32px)">
        <WorkspaceForm onCreated={() => onCreated()} onError={onError}>
          <Title order={4}>Create a workspace</Title>
          <Text size="sm" c="dimmed">
            A workspace holds your projects and the people you work with. If someone invited you, ask them to add the email you signed up
            with.
          </Text>
        </WorkspaceForm>
        <Button variant="subtle" fullWidth mt="sm" onClick={onSignOut}>
          Sign out
        </Button>
      </Paper>
    </div>
  );
}
