ALTER TABLE comments ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'mentioned'));
ALTER TABLE comments ADD COLUMN visible_to_json TEXT NOT NULL DEFAULT '[]';
