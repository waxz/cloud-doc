import schema from '../migrations/0001_schema.sql';
import adminStorage from '../migrations/0002_admin_storage.sql';
import workspaceStorageBindings from '../migrations/0003_workspace_storage_bindings.sql';
import notifications from '../migrations/0004_notifications.sql';
import messagesTodos from '../migrations/0005_messages_todos.sql';
import todoReferences from '../migrations/0006_todo_references.sql';
import commentVisibility from '../migrations/0007_comment_visibility.sql';
import pdfAnnotations from '../migrations/0008_pdf_annotations.sql';
import commentHighlightColor from '../migrations/0009_comment_highlight_color.sql';
import commentHighlightShape from '../migrations/0010_comment_highlight_shape.sql';
import commentQuoteIndex from '../migrations/0011_comment_quote_index.sql';
import usage from '../migrations/0012_usage.sql';
import indexes from '../migrations/0013_indexes.sql';
import workspaceFiles from '../migrations/0014_workspace_files_shared_storage.sql';
import linkWorkspaceStorage from '../migrations/0015_link_workspace_storage.sql';
import commentParent from '../migrations/0016_comment_parent.sql';
import storageRootPath from '../migrations/0017_storage_root_path.sql';
import appSettings from '../migrations/0018_app_settings.sql';

/**
 * Migrations bundled into the Worker, applied on first use so a plain
 * `wrangler deploy` is enough. Add new files here as well as in migrations/.
 * Uses Wrangler's `d1_migrations` table, so `wrangler d1 migrations apply`
 * still works and sees the same state.
 */
const MIGRATIONS: [name: string, sql: string][] = [
  ['0001_schema.sql', schema],
  ['0002_admin_storage.sql', adminStorage],
  ['0003_workspace_storage_bindings.sql', workspaceStorageBindings],
  ['0004_notifications.sql', notifications],
  ['0005_messages_todos.sql', messagesTodos],
  ['0006_todo_references.sql', todoReferences],
  ['0007_comment_visibility.sql', commentVisibility],
  ['0008_pdf_annotations.sql', pdfAnnotations],
  ['0009_comment_highlight_color.sql', commentHighlightColor],
  ['0010_comment_highlight_shape.sql', commentHighlightShape],
  ['0011_comment_quote_index.sql', commentQuoteIndex],
  ['0012_usage.sql', usage],
  ['0013_indexes.sql', indexes],
  ['0014_workspace_files_shared_storage.sql', workspaceFiles],
  ['0015_link_workspace_storage.sql', linkWorkspaceStorage],
  ['0016_comment_parent.sql', commentParent],
  ['0017_storage_root_path.sql', storageRootPath],
  ['0018_app_settings.sql', appSettings],
];

/** Splits a migration into statements (no semicolons inside strings in these files). */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function migrate(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS d1_migrations (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT UNIQUE,
         applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`
    )
    .run();
  const { results } = await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>();
  const applied = new Set(results.map((r) => r.name));
  for (const [name, sql] of MIGRATIONS) {
    if (applied.has(name)) continue;
    try {
      // One batch is one transaction: the bookkeeping row and the schema land together.
      await db.batch([db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name), ...statements(sql).map((s) => db.prepare(s))]);
    } catch (err) {
      // Another isolate may have applied it first (the INSERT hits the UNIQUE name).
      if (!(await db.prepare('SELECT 1 FROM d1_migrations WHERE name = ?').bind(name).first())) throw err;
    }
  }
}

let ready: Promise<void> | undefined;

/** Resolves once the schema is current; runs the check once per isolate. */
export function ensureSchema(db: D1Database): Promise<void> {
  ready ??= migrate(db).catch((err) => {
    ready = undefined; // try again on the next request
    throw err;
  });
  return ready;
}
