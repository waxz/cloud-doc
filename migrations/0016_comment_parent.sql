-- A reply can answer another reply: parent_id is the comment it answers (null for a reply straight to the thread's first comment).
ALTER TABLE comments ADD COLUMN parent_id TEXT;
CREATE INDEX comments_parent ON comments (parent_id);
