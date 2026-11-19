import type { Env } from './env.js';
import { HttpError } from './http.js';

/** True when cloud-drive is connected. */
export function storageEnabled(env: Env): boolean {
  return !!env.CLOUD_DRIVE_URL;
}

interface Target {
  /** Drive's WebDAV URL without credentials, no trailing slash. */
  base: string;
  authorization?: string;
}

/**
 * CLOUD_DRIVE_URL is the drive's WebDAV URL with the cloud-drive user in it,
 * e.g. https://user:password@drive.example.com/dav/drive. The credentials
 * become a Basic auth header (fetch refuses URLs that carry them).
 */
function target(env: Env): Target {
  let u: URL;
  try {
    u = new URL(env.CLOUD_DRIVE_URL ?? '');
  } catch {
    throw new HttpError(500, 'CLOUD_DRIVE_URL is not a valid URL');
  }
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  u.username = '';
  u.password = '';
  const pair = new TextEncoder().encode(`${user}:${pass}`);
  return {
    base: `${u.origin}${u.pathname.replace(/\/+$/, '')}`,
    ...(user ? { authorization: `Basic ${btoa(String.fromCharCode(...pair))}` } : {}),
  };
}

/** Calls cloud-drive (through the CLOUD_DRIVE service binding when there is one). */
function call(env: Env, key: string, init: RequestInit = {}): Promise<Response> {
  if (!storageEnabled(env)) {
    throw new HttpError(503, 'file storage is off: connect cloud-drive to use uploads and history');
  }
  const t = target(env);
  const path = ['wiki', ...key.split('/')].map(encodeURIComponent).join('/');
  const url = `${t.base}/${path}`;
  const headers = { ...(t.authorization ? { authorization: t.authorization } : {}), ...Object.fromEntries(new Headers(init.headers)) };
  return env.CLOUD_DRIVE ? env.CLOUD_DRIVE.fetch(url, { ...init, headers }) : fetch(url, { ...init, headers });
}

export async function drivePut(
  env: Env,
  key: string,
  body: BodyInit | null,
  contentType: string,
  length?: string | null
): Promise<void> {
  const res = await call(env, key, {
    method: 'PUT',
    body,
    headers: { 'content-type': contentType, ...(length ? { 'content-length': length } : {}) },
  });
  if (!res.ok) throw new HttpError(502, `cloud-drive upload failed: ${res.status} ${await res.text()}`);
}

export function driveGet(env: Env, key: string, range?: string | null): Promise<Response> {
  return call(env, key, { headers: range ? { range } : {} });
}

/** Deletes a file or folder; missing is fine. */
export async function driveDelete(env: Env, key: string): Promise<void> {
  if (!storageEnabled(env)) return; // nothing was ever stored
  const res = await call(env, key, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new HttpError(502, `cloud-drive delete failed: ${res.status}`);
}
