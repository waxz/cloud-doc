import schema from '../migrations/0001_schema.sql';
import adminStorage from '../migrations/0002_admin_storage.sql';

/**
 * Migrations bundled into the Worker, applied on first use so a plain
 * `wrangler deploy` is enough. Add new files here as well as in migrations/.
 * Uses Wrangler's `d1_migrations` table, so `wrangler d1 migrations apply`
 * still works and sees the same state.
 */
const MIGRATIONS: [name: string, sql: string][] = [
  ['0001_schema.sql', schema],
  ['0002_admin_storage.sql', adminStorage],
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
