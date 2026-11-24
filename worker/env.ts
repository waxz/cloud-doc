import type { PageRoom } from './page-room.js';

export interface Env {
  DB: D1Database;
  PageRoom: DurableObjectNamespace<PageRoom>;
  ASSETS: Fetcher;
  /** PBKDF2 iterations for new password hashes (default 50,000; Workers allow up to 100,000). */
  PASSWORD_ITERATIONS?: string;
  /** Optional secret: when set, storage passwords are encrypted in D1 (see worker/secret.ts). */
  STORAGE_KEY?: string;
  /**
   * Optional secret (16+ characters) that switches on admin recovery mode: whoever knows it can set a new password for
   * an admin account from the sign-in page. Set and change it in the Cloudflare dashboard (Variables and Secrets).
   */
  RECOVERY_SECRET?: string;
}
