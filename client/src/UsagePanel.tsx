import { Badge, Card, Group, Loader, Progress, SimpleGrid, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { type AdminStats, api, type UserUsage } from './api';
import { errorText, formatBytes, timeAgo } from './util';

const HOUR = 3_600_000;
const num = (n: number) => n.toLocaleString();

/** Admin: what each user stores and how much they ask of the server. */
export function UsagePanel({ onError }: { onError: (message: string) => void }) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  useEffect(() => {
    const load = () => api.adminStats().then(setStats, (e) => onError(errorText(e)));
    load();
    // Refreshing costs requests too, so this is slow and only while the tab is visible.
    const timer = window.setInterval(() => document.visibilityState === 'visible' && load(), 60_000);
    return () => window.clearInterval(timer);
  }, [onError]);
  if (!stats) return <Loader size="sm" />;

  const total24 = stats.users.reduce((n, u) => n + u.requests_24h, 0);
  const errors24 = stats.users.reduce((n, u) => n + u.errors_24h, 0);
  const stored = stats.users.reduce((n, u) => n + u.storage_used, 0);
  const hours = Array.from({ length: 24 }, (_, i) => {
    const hour = stats.hour - 23 + i;
    const row = stats.series.find((r) => r.hour === hour);
    return { hour, requests: row?.requests ?? 0, errors: row?.errors ?? 0 };
  });
  const peak = Math.max(1, ...hours.map((h) => h.requests));
  const share = (total24 / stats.dailyLimit) * 100;

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
        <Stat label="Requests, 24 h" value={num(total24)} />
        <Stat label="Of the free plan's daily 100k" value={`${share < 0.1 && total24 ? '<0.1' : share.toFixed(1)}%`} color={share > 80 ? 'red' : share > 50 ? 'orange' : undefined} />
        <Stat label="Errors, 24 h" value={num(errors24)} color={errors24 ? 'orange' : undefined} />
        <Stat label="Stored (all users)" value={formatBytes(stored)} />
      </SimpleGrid>

      <Card withBorder padding="sm" radius="md">
        <Text size="xs" c="dimmed" mb={6}>Requests per hour, last 24 h (peak {num(peak)})</Text>
        <div className="usage-bars" role="img" aria-label="Requests per hour for the last 24 hours">
          {hours.map((h) => (
            <div key={h.hour} className="usage-bar" title={`${new Date(h.hour * HOUR).toLocaleString([], { weekday: 'short', hour: 'numeric' })}: ${num(h.requests)} requests${h.errors ? `, ${num(h.errors)} errors` : ''}`}>
              <div className="usage-bar-fill" style={{ height: `${(h.requests / peak) * 100}%` }} />
            </div>
          ))}
        </div>
      </Card>

      <Stack gap="xs">
        {stats.users.map((u) => <UserRow key={u.id} u={u} />)}
      </Stack>
      <Text size="xs" c="dimmed">
        Counts signed-in API calls and live-sync connections, gathered in memory and saved about once a minute, so recent
        figures are close estimates. Page assets and sign-in calls aren't counted, and Cloudflare's own dashboard is the
        authority on the bill.
      </Text>
    </Stack>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Card withBorder padding="xs" radius="md">
      <Text size="xs" c="dimmed">{label}</Text>
      <Text fw={600} size="lg" c={color}>{value}</Text>
    </Card>
  );
}

function UserRow({ u }: { u: UserUsage }) {
  const perHour = u.requests_24h / 24;
  return (
    <Card withBorder padding="sm" radius="md">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <div style={{ minWidth: 0 }}>
          <Group gap={6}>
            <Text fw={500}>{u.name}</Text>
            {u.role === 'admin' && <Badge size="xs" variant="light">Admin</Badge>}
            {!!u.disabled && <Badge size="xs" color="red" variant="light">Disabled</Badge>}
          </Group>
          <Text size="xs" c="dimmed" truncate="end">{u.email}</Text>
        </div>
        <Text size="xs" c="dimmed" style={{ flex: 'none' }}>{u.last_active ? `active ${timeAgo(u.last_active)}` : 'no activity yet'}</Text>
      </Group>
      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs" mt="xs">
        <Metric label="Requests 24 h / 7 d / 30 d" value={`${num(u.requests_24h)} / ${num(u.requests_7d)} / ${num(u.requests_30d)}`} />
        <Metric label="Rate, 24 h average · busiest hour" value={`${perHour < 10 ? perHour.toFixed(1) : Math.round(perHour)}/h · ${num(u.peak_hour)}/h`} />
        <Metric label="Errors · traffic in / out, 24 h" value={`${num(u.errors_24h)} · ${formatBytes(u.bytes_in_24h)} / ${formatBytes(u.bytes_out_24h)}`} />
        <Metric label="Files · comments" value={`${num(u.files)} · ${num(u.comments)}`} />
      </SimpleGrid>
      <Group justify="space-between" mt="xs" mb={2}>
        <Text size="xs" c="dimmed">Stored by them</Text>
        <Text size="xs">{formatBytes(u.storage_used)}</Text>
      </Group>
      {u.grants.map((g) => {
        const pct = g.limit_bytes ? Math.min(100, (g.used / g.limit_bytes) * 100) : 0;
        return (
          <div key={g.storage_name}>
            <Group justify="space-between" mb={2} mt={4}>
              <Text size="xs" c="dimmed">Shared “{g.storage_name}”</Text>
              <Text size="xs">{formatBytes(g.used)}{g.limit_bytes != null && ` / ${formatBytes(g.limit_bytes)}`}</Text>
            </Group>
            {g.limit_bytes != null && <Progress value={pct} size="sm" color={pct > 90 ? 'red' : pct > 70 ? 'orange' : 'blue'} />}
          </div>
        );
      })}
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Text size="xs" c="dimmed">{label}</Text>
      <Text size="sm">{value}</Text>
    </div>
  );
}
