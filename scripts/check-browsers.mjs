// Fails when the built app contains syntax that older iPhones can't read. Safari rejects a whole file for one unreadable
// regular expression, so a page can fail to render on an iPhone SE or an old iPad while working on a new phone.
// Usage: node scripts/check-browsers.mjs   (after `npm run build`)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = new URL('../dist/client/assets/', import.meta.url);
const checks = [
  ['regular-expression lookbehind (Safari 16.4+)', /\(\?<[=!]/],
  ['class static block (Safari 16.4+)', /\bstatic\s*\{/],
];
let bad = 0;
for (const name of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
  const text = readFileSync(new URL(name, dir), 'utf8');
  for (const [what, re] of checks) {
    const hit = re.exec(text);
    if (hit) {
      bad++;
      console.error(`${name}: ${what}\n    …${text.slice(Math.max(0, hit.index - 60), hit.index + 60).replace(/\s+/g, ' ')}…`);
    }
  }
}
// And the real test: ask esbuild, which knows what each Safari can read, to parse every file for Safari 15.
const tmp = mkdtempSync(join(tmpdir(), 'check-browsers-'));
const files = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => fileURLToPath(new URL(f, dir)));
const run = spawnSync('npx', ['esbuild', ...files, '--target=safari15', '--log-level=warning', `--outdir=${tmp}`], { encoding: 'utf8' });
rmSync(tmp, { recursive: true, force: true });
const complaints = `${run.stderr}${run.stdout}`.split('\n').filter((l) => /not available in the configured target|ERROR/.test(l));
if (run.status !== 0 || complaints.length) {
  bad += Math.max(1, complaints.length);
  console.error(complaints.slice(0, 10).join('\n') || run.stderr);
}
if (bad) {
  console.error(`\n${bad} problem(s): this build would not load on older iPhones. Rewrite the code without that syntax.`);
  process.exit(1);
}
console.log('built files use only syntax Safari 15 can read');
