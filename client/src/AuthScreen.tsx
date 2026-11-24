import { Alert, Anchor, Button, Loader, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconFileText } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { api, type Me } from './api';
import { errorText } from './util';

type Mode = { kind: 'signin' } | { kind: 'setup' } | { kind: 'register'; token: string };

interface Props {
  mode: Mode;
  /** The admin's contact address, shown for people who forgot their password. */
  adminEmail?: string;
  /** Open registration is on: anyone may create an account (a limited playground). */
  openSignup?: boolean;
  /** Whether the Worker has a RECOVERY_SECRET, which switches on the admin recovery form. */
  recovery?: boolean;
  note?: string;
  onAuthed: (me: Me) => void;
}

/**
 * Sign in; or, on a fresh install, create the first account (the admin);
 * or create an account from an admin's registration link.
 */
export function AuthScreen({ mode, adminEmail, recovery, openSignup, note, onAuthed }: Props) {
  const [recovering, setRecovering] = useState(false);
  const [joining, setJoining] = useState(false);
  const [secret, setSecret] = useState('');
  const [email, setEmail] = useState('');
  const [lockedEmail, setLockedEmail] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [joins, setJoins] = useState('');
  const [linkState, setLinkState] = useState<'loading' | 'ok' | string>(mode.kind === 'register' ? 'loading' : 'ok');
  const creating = mode.kind !== 'signin' || joining;
  const token = mode.kind === 'register' ? mode.token : undefined;

  useEffect(() => {
    if (!token) return;
    api.registration(token).then(
      (info) => {
        if (info.email) (setEmail(info.email), setLockedEmail(true));
        setJoins([info.workspace && `You'll join the workspace “${info.workspace}”`, info.storage && `with the shared storage “${info.storage}” ready to use`].filter(Boolean).join(' '));
        setLinkState('ok');
      },
      (e) => setLinkState(errorText(e))
    );
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onAuthed(recovering ? await api.recover(secret, email, password) : creating ? await api.signup(email, name, password, token) : await api.login(email, password));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const heading = recovering ? 'Admin recovery' : joining ? 'Join the playground' : mode.kind === 'setup' ? 'Set up Cloud Doc' : mode.kind === 'register' ? 'Create your account' : 'Sign in';

  return (
    <div className="auth">
      <Paper withBorder radius="lg" p="xl" w={400} maw="100%" shadow="sm">
        <Stack gap={4} mb="lg" align="center">
          <IconFileText size={36} stroke={1.4} />
          <Title order={3}>{heading}</Title>
          {recovering && (
            <Text size="sm" c="dimmed" ta="center">
              Enter the recovery secret set for this Worker in the Cloudflare dashboard, and choose a new password for the admin account.
            </Text>
          )}
          {mode.kind === 'setup' && (
            <Text size="sm" c="dimmed" ta="center">
              This is a new install. The account you create now is the admin, who invites everyone else.
            </Text>
          )}
          {joins && (
            <Text size="sm" c="dimmed" ta="center">
              {joins}.
            </Text>
          )}
          {note && (
            <Text size="sm" c="dimmed" ta="center">
              {note}
            </Text>
          )}
        </Stack>
        {linkState === 'loading' ? (
          <Loader size="sm" mx="auto" display="block" />
        ) : linkState !== 'ok' ? (
          <Alert color="red" variant="light" title="Can't use this link">
            {linkState}. Ask your admin for a new one.
          </Alert>
        ) : (
          <form onSubmit={submit}>
            <Stack gap="sm">
              {recovering && (
                <PasswordInput label="Recovery secret" autoComplete="off" value={secret} onChange={(e) => setSecret(e.currentTarget.value)} required />
              )}
              <TextInput
                label={recovering ? 'Admin email (if there is more than one admin)' : 'Email'}
                type="email"
                autoComplete="email"
                value={email}
                readOnly={lockedEmail}
                variant={lockedEmail ? 'filled' : 'default'}
                onChange={(e) => setEmail(e.currentTarget.value)}
                required={!recovering}
              />
              {creating && <TextInput label="Name" autoComplete="name" value={name} onChange={(e) => setName(e.currentTarget.value)} required />}
              <PasswordInput
                label={recovering ? 'New password' : 'Password'}
                autoComplete={creating || recovering ? 'new-password' : 'current-password'}
                description={creating || recovering ? 'At least 8 characters' : undefined}
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                required
              />
              {error && (
                <Text size="sm" c="red">
                  {error}
                </Text>
              )}
              <Button type="submit" loading={busy} fullWidth mt="xs">
                {recovering ? 'Reset password and sign in' : creating ? 'Create account' : 'Sign in'}
              </Button>
              {mode.kind === 'signin' && joining && (
                <Text size="sm" ta="center">
                  <Anchor component="button" type="button" onClick={() => setJoining(false)}>
                    Back to sign in
                  </Anchor>
                </Text>
              )}
              {mode.kind === 'signin' && !recovering && !joining && (
                <Stack gap={2}>
                  <Text size="sm" c="dimmed" ta="center">
                    {openSignup ? (
                      <>
                        New here?{' '}
                        <Anchor component="button" type="button" onClick={() => setJoining(true)}>
                          Create an account
                        </Anchor>{' '}
                        to try the playground.
                      </>
                    ) : (
                      'New here? Ask an admin for a registration link.'
                    )}
                  </Text>
                  <Text size="sm" c="dimmed" ta="center">
                    Forgot your password?{' '}
                    {adminEmail ? (
                      <>
                        Email the admin at{' '}
                        <Anchor href={`mailto:${adminEmail}?subject=${encodeURIComponent('Cloud Doc: please reset my password')}`}>{adminEmail}</Anchor>.
                      </>
                    ) : (
                      'Ask the admin to reset it.'
                    )}
                  </Text>
                  {recovery && (
                    <Text size="sm" ta="center">
                      <Anchor component="button" type="button" onClick={() => setRecovering(true)}>
                        I am the admin: use recovery mode
                      </Anchor>
                    </Text>
                  )}
                </Stack>
              )}
              {recovering && (
                <Text size="sm" ta="center">
                  <Anchor component="button" type="button" onClick={() => setRecovering(false)}>
                    Back to sign in
                  </Anchor>
                </Text>
              )}
            </Stack>
          </form>
        )}
      </Paper>
    </div>
  );
}
