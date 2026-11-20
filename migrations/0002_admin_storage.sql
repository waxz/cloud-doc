-- Instance admin, registration links, per-user WebDAV storage, uploaded files
-- and storage limits. Additive: existing data is kept.

-- WebDAV folders a user stores files and page history in. `url` has no
-- credentials; the password never leaves the server.
CREATE TABLE storages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX storages_user ON storages (user_id);

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member'));
ALTER TABLE users ADD COLUMN can_create_workspaces INTEGER NOT NULL DEFAULT 1;
-- Bytes a user may keep in their storages (uploads and history); NULL = no limit.
ALTER TABLE users ADD COLUMN storage_limit INTEGER;
ALTER TABLE users ADD COLUMN default_storage_id TEXT REFERENCES storages (id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;

-- On an existing install, the first account becomes the admin.
UPDATE users SET role = 'admin' WHERE id = (SELECT id FROM users ORDER BY created_at LIMIT 1);

-- A user's storage for one workspace, overriding their default.
CREATE TABLE workspace_storage (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  storage_id TEXT NOT NULL REFERENCES storages (id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, user_id)
);

-- One-time sign-up links an admin hands out (sign-up is closed otherwise).
CREATE TABLE registration_links (
  token TEXT PRIMARY KEY,
  email TEXT COLLATE NOCASE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  used_at INTEGER,
  used_by TEXT REFERENCES users (id) ON DELETE SET NULL
);

-- Files uploaded to a page, in the uploader's storage at `key`.
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  owner_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  storage_id TEXT REFERENCES storages (id) ON DELETE SET NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX files_page ON files (page_id, created_at);
CREATE INDEX files_owner ON files (owner_id);

-- History snapshots now live in a user's storage too.
ALTER TABLE page_versions ADD COLUMN storage_id TEXT REFERENCES storages (id) ON DELETE SET NULL;
ALTER TABLE page_versions ADD COLUMN owner_id TEXT REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX page_versions_owner ON page_versions (owner_id);

-- A page's emoji, mirrored from its live document like the title.
ALTER TABLE pages ADD COLUMN icon TEXT NOT NULL DEFAULT '';
