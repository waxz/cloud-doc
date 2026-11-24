-- A read-only project: members can read it but not edit it. Project and workspace admins still can.
ALTER TABLE projects ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
