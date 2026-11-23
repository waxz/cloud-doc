// Makes sure the STORAGE_KEY secret exists, so WebDAV passwords are encrypted from the first one saved.
// It only ever creates the key: an existing one is never replaced (that would make saved passwords unreadable).
//
//   node scripts/ensure-storage-key.mjs --local            writes STORAGE_KEY to .dev.vars if missing (npm run dev)
//   node scripts/ensure-storage-key.mjs --remote           adds the secret to the deployed Worker if missing (npm run deploy)
//   node scripts/ensure-storage-key.mjs --remote --strict  the same, but fails if it can't (after the first deploy)
//
// STORAGE_KEY in the environment is used as the value when given; otherwise a random one is made.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = new Set(process.argv.slice(2));
const strict = args.has('--strict');
const value = process.env.STORAGE_KEY?.trim() || randomBytes(32).toString('base64url');

function local() {
  const file = '.dev.vars';
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (/^\s*STORAGE_KEY\s*=\s*\S/m.test(text)) return;
  writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}STORAGE_KEY=${value}\n`, { mode: 0o600 });
  console.log('STORAGE_KEY: created in .dev.vars (kept out of git). Keep it: saved storage passwords need it.');
}

function wrangler(argv, input) {
  return spawnSync('npx', ['--no-install', 'wrangler', ...argv], { input, encoding: 'utf8', shell: process.platform === 'win32' });
}

function remote() {
  const listed = wrangler(['secret', 'list', '--format', 'json']);
  if (listed.status === 0) {
    try {
      if (JSON.parse(listed.stdout).some((s) => s.name === 'STORAGE_KEY')) return console.log('STORAGE_KEY: already set.');
    } catch {
      /* fall through and try to set it */
    }
  }
  const put = wrangler(['secret', 'put', 'STORAGE_KEY'], value);
  if (put.status === 0) return console.log('STORAGE_KEY: created as a Worker secret. Keep a copy if you want to restore the Worker elsewhere.');
  const why = `${put.stderr || put.stdout || listed.stderr || ''}`.trim().split('\n').slice(-2).join(' ');
  const message = `STORAGE_KEY: could not be created (${why || 'wrangler failed'}). Create it with: npx wrangler secret put STORAGE_KEY`;
  if (strict) {
    console.error(message);
    process.exit(1);
  }
  // Before the first deploy the Worker doesn't exist yet; the step after the deploy tries again.
  console.log(`${message}\n(This is normal before the first deploy: it is retried right after.)`);
}

if (args.has('--local')) local();
else if (args.has('--remote')) remote();
else {
  console.error('usage: ensure-storage-key.mjs --local | --remote [--strict]');
  process.exit(2);
}
