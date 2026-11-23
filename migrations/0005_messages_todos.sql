CREATE TABLE private_messages (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX private_messages_recipient ON private_messages (recipient_id, read_at, created_at);

CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_type TEXT,
  source_id TEXT,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX todos_user ON todos (user_id, completed_at, created_at);
