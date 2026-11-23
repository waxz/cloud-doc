/**
 * Encryption of stored storage passwords (WebDAV credentials), so a copy of the database alone
 * doesn't hand out access to people's drives.
 *
 * Set the secret `STORAGE_KEY` (any long random string) and new or changed passwords are saved
 * as `enc1:<iv>:<ciphertext>` (AES-256-GCM, key = SHA-256 of the secret). Passwords saved before
 * stay readable and are encrypted the next time they're saved. Without the secret nothing is
 * encrypted, which is how the app works out of the box.
 */
const PREFIX = 'enc1:';
let secret: string | undefined;
let keyPromise: Promise<CryptoKey> | undefined;

/** Called with the environment's secret on each request (cheap; the key itself is derived once). */
export function useStorageKey(value: string | undefined): void {
  if (value === secret) return;
  secret = value;
  keyPromise = undefined;
}

const key = () =>
  (keyPromise ??= crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(secret ?? ''))
    .then((raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])));

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** The form to store: encrypted when a secret is set, as given otherwise. */
export async function sealPassword(plain: string): Promise<string> {
  if (!secret || !plain) return plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(plain)));
  return `${PREFIX}${b64(iv)}:${b64(data)}`;
}

/** The password to use, from either stored form. */
export async function openPassword(stored: string): Promise<string> {
  if (!stored.startsWith(PREFIX)) return stored;
  if (!secret) throw new Error('storage passwords are encrypted but STORAGE_KEY is not set');
  const [iv, data] = stored.slice(PREFIX.length).split(':');
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv!) }, await key(), unb64(data!)));
  } catch {
    throw new Error('could not decrypt a storage password: is STORAGE_KEY the one it was saved with?');
  }
}
