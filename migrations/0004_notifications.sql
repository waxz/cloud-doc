CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL REFERENCES comments (id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX notifications_user ON notifications (user_id, read_at, created_at);
