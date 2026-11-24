-- A storage's address is now a server (base) URL plus a folder path under it, so the app can check the
-- server and create the folder. `url` stays the full address everything reads; `root_path` is the part
-- of it that is the folder ('' for storages saved before, which are used as they were).
ALTER TABLE storages ADD COLUMN root_path TEXT NOT NULL DEFAULT '';
