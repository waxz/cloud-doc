import type { PageRoom } from './page-room.js';

export interface Env {
  DB: D1Database;
  PageRoom: DurableObjectNamespace<PageRoom>;
  ASSETS: Fetcher;
  /**
   * cloud-drive WebDAV URL of the drive, with the user in it
   * (https://user:password@host/dav/<drive>). Unset = no file storage.
   */
  CLOUD_DRIVE_URL?: string;
  /** Optional service binding to a cloud-drive Worker on the same account. */
  CLOUD_DRIVE?: Fetcher;
  /** PBKDF2 iterations for new password hashes (default 50,000; Workers allow up to 100,000). */
  PASSWORD_ITERATIONS?: string;
}
