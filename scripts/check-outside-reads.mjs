#!/usr/bin/env node
// A test reading a file outside its own package declares it with `// @direct-test-of <path>`, so a
// change to that file alone selects the test: in the direct selection `pnpm test:changed` and
// `pnpm merge-check` share, and, through the `changes` filter of the job that runs it, on `main`
// (ISS-134). The verdict is `lib/outside-reads.mjs`; this reads the tree and exits.
//
//   node scripts/check-outside-reads.mjs
//
// Exit 0 every outside read declared and filtered · 1 a refusal · 2 could not run.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';
import { aliasReader, knownFiles, VITEST_COLLECTIONS } from './lib/direct-tests.mjs';
import { dieAs, ROOT } from './lib/gate.mjs';
import { judgeOutsideReads, moduleLoader } from './lib/outside-reads.mjs';

const die = dieAs('outside-reads');

let known;
try {
  known = knownFiles(ROOT);
} catch (e) {
  die(e.message);
}
const read = (path) => {
  const abs = join(ROOT, path);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
};
const ciText = read('.github/workflows/ci.yml');
if (ciText === null) die('.github/workflows/ci.yml is missing, so no declaration can be checked');

let ts;
try {
  ts = createRequire(join(ROOT, 'packages/core/package.json'))('typescript');
} catch {
  die('the TypeScript compiler @forge/core declares is not installed — run `pnpm install`');
}

const tests = [];
for (const path of [...known].sort()) {
  if (!VITEST_COLLECTIONS.some((c) => c.test.test(path))) continue;
  const source = read(path);
  if (source === null)
    die(`${path} is known to git but not on disk — stage the deletion or restore it`);
  tests.push({ path, source });
}

const load = moduleLoader({ known, aliasesOf: aliasReader(ROOT), read });
const { refused, reads } = judgeOutsideReads({ ts, tests, known, load, ciText });

if (refused.length === 0) {
  console.log(
    `outside-reads: ${tests.length} test file(s) read, ${reads} read(s) outside a test's package, each declared and filtered`,
  );
  process.exit(0);
}
console.error(`outside-reads: ${refused.length} refusal(s):\n`);
for (const r of refused) console.error(`  ${r.path}: ${r.why}`);
console.error(
  '\nA test reading a file by path reaches it by no import, so a change to that file alone runs none of the tests that check it.',
);
process.exit(1);
