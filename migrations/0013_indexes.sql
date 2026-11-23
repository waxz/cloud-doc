-- Lookups that had no index: a user's sent messages, deleting a thread, a comment's notifications.
CREATE INDEX IF NOT EXISTS private_messages_sender ON private_messages (sender_id, created_at);
CREATE INDEX IF NOT EXISTS comments_thread ON comments (thread_id);
CREATE INDEX IF NOT EXISTS notifications_comment ON notifications (comment_id);
