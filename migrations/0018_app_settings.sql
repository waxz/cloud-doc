-- Instance-wide settings an admin edits in the admin panel (for now: the contact email shown on the sign-in page).
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
