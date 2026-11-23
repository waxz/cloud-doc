-- Storages can be shared with every member of one or more workspaces.
-- This is separate from workspace_storage, which is a member's personal
-- override for choosing how to write in a workspace.
CREATE TABLE workspace_storage_bindings (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  storage_id TEXT NOT NULL REFERENCES storages (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, storage_id)
);
CREATE INDEX workspace_storage_bindings_storage ON workspace_storage_bindings (storage_id);
