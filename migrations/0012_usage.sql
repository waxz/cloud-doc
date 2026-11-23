-- Per-user request counts in one-hour buckets, for the admin's usage panel.
CREATE TABLE usage_hourly (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  hour INTEGER NOT NULL, -- unix time / 3600000, floored
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  bytes_in INTEGER NOT NULL DEFAULT 0,
  bytes_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, hour)
);
CREATE INDEX usage_hourly_hour ON usage_hourly (hour);
