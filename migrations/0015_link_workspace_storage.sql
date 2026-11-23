-- A registration link can also put the new account into a workspace and give it a shared storage
-- (with a limit), so the person can start working right after signing up.
ALTER TABLE registration_links ADD COLUMN workspace_id TEXT;
ALTER TABLE registration_links ADD COLUMN workspace_role TEXT NOT NULL DEFAULT 'member';
ALTER TABLE registration_links ADD COLUMN storage_id TEXT;
ALTER TABLE registration_links ADD COLUMN limit_bytes INTEGER;
