-- A cap on the number of comments in a workspace (NULL = none), so comments can't be used to fill the database.
ALTER TABLE workspaces ADD COLUMN max_comments INTEGER;
