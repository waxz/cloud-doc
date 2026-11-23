import type { PageRoom } from './page-room.js';

export interface Env {
  DB: D1Database;
  PageRoom: DurableObjectNamespace<PageRoom>;
  ASSETS: Fetcher;
  /** PBKDF2 iterations for new password hashes (default 50,000; Workers allow up to 100,000). */
  PASSWORD_ITERATIONS?: string;
  /** Optional secret: when set, storage passwords are encrypted in D1 (see worker/secret.ts). */
  STORAGE_KEY?: string;
}
