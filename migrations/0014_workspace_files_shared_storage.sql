-- Files belong to a workspace, not to one page: several pages can use the same file, and
-- deleting a page no longer deletes it. `page_id` only remembers where it was uploaded from.
-- file_refs says which pages use a file (kept up to date when a page is saved).
-- Storages can also be shared by the admin: `storage_grants` lets chosen users use one,
-- each with a limit, to hold the workspaces they create.

ALTER TABLE storages ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;

CREATE TABLE storage_grants (
  storage_id TEXT NOT NULL REFERENCES storages (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  limit_bytes INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (storage_id, user_id)
);
CREATE INDEX storage_grants_user ON storage_grants (user_id);

-- Whose allocation a workspace's use of a shared storage counts against.
ALTER TABLE workspace_storage_bindings ADD COLUMN granted_user_id TEXT REFERENCES users (id) ON DELETE SET NULL;

CREATE TABLE files_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages (id) ON DELETE SET NULL,
  owner_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  storage_id TEXT REFERENCES storages (id) ON DELETE SET NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO files_new (id, workspace_id, page_id, owner_id, storage_id, key, name, mime, size, created_at)
  SELECT f.id, pr.workspace_id, f.page_id, f.owner_id, f.storage_id, f.key, f.name, f.mime, f.size, f.created_at
  FROM files f JOIN pages p ON p.id = f.page_id JOIN projects pr ON pr.id = p.project_id;
DROP TABLE files;
ALTER TABLE files_new RENAME TO files;
CREATE INDEX files_page ON files (page_id, created_at);
CREATE INDEX files_owner ON files (owner_id);
CREATE INDEX files_workspace ON files (workspace_id, created_at);
CREATE INDEX files_storage ON files (storage_id);

CREATE TABLE file_refs (
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, page_id)
);
CREATE INDEX file_refs_page ON file_refs (page_id);
-- Until pages are saved again, the page a file was uploaded from is assumed to use it.
INSERT INTO file_refs (file_id, page_id) SELECT id, page_id FROM files WHERE page_id IS NOT NULL;
