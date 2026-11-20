import { Alert, Button, Loader, Paper, Stack, Text, TextInput, Title, useComputedColorScheme } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
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
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState('');
  const dark = useComputedColorScheme('light') === 'dark';
  const onError = useCallback((m: string) => setError(m), []);

  const loadMe = useCallback(
    () =>
      api.me().then(setMe, (e) => {
        if (e instanceof ApiError && e.status === 401) setMe(null);
        else setError(errorText(e));
      }),
    []
  );
  useEffect(() => {
    loadMe();
  }, [loadMe]);
  useEffect(() => {
    if (me === null) api.authStatus().then((s) => setSetup(s.setup), (e) => setError(errorText(e)));
  }, [me]);
  // A registration link opened while signed in: nothing to do there.
  useEffect(() => {
    if (me && route.name === 'register') navigate('/');
  }, [me, route.name]);

  // Home (or a workspace you're not in): go to your first workspace, if any.
  const known = route.name === 'workspace' && !!me?.workspaces.some((w) => w.id === route.wid);
  const firstId = me?.workspaces[0]?.id;
  useEffect(() => {
    if (me && route.name !== 'share' && !known && firstId) navigate(href.workspace(firstId));
  }, [me, route.name, known, firstId]);

  const banner = error && (
    <Alert color="red" variant="filled" className="error" withCloseButton onClose={() => setError('')}>
      {error}
    </Alert>
  );

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
          <Shell me={me} workspace={workspace} pageId={route.pageId} dark={dark} onMeChanged={loadMe} onSignOut={signOut} onError={onError} />
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
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.createWorkspace(name.trim());
              onCreated();
            } catch (err) {
              onError(errorText(err));
            }
          }}
        >
          <Stack>
            <Title order={4}>Create a workspace</Title>
            <Text size="sm" c="dimmed">
              A workspace holds your projects and the people you work with. If someone invited you, ask them to add the email you signed up
              with.
            </Text>
            <TextInput label="Workspace name" value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
            <Button type="submit" disabled={!name.trim()}>
              Create
            </Button>
            <Button variant="subtle" onClick={onSignOut}>
              Sign out
            </Button>
          </Stack>
        </form>
      </Paper>
    </div>
  );
}
