-- Limits on a workspace, set by the instance admin (for a limited playground, say). NULL = no limit.
-- storage_limit counts what the workspace keeps in storage: uploaded files plus page history, in bytes.
ALTER TABLE workspaces ADD COLUMN storage_limit INTEGER;
ALTER TABLE workspaces ADD COLUMN max_pages INTEGER;
