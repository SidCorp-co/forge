#!/usr/bin/env node
// The subagent slot rule lives in one place (ISS-1245): scripts/lib/run-slots-fence.mjs says what
// the fence holds, and this walks the trees it holds over. Exits 1 on a crossing, 2 when it cannot run.
//
//   node scripts/check-run-slots.mjs --all

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dieAs, ROOT, walkFiles } from './lib/gate.mjs';
import { fenceFaults, OTHER_SLOTS, RULE, SHELL, SIZE_HOLDERS } from './lib/run-slots-fence.mjs';

const die = dieAs('check-run-slots');

const ROOTS = [
  'packages/core/src',
  'packages/core/tests',
  'packages/contracts/src',
  'packages/web-v2/src',
  'packages/runner/crates',
];
const SKIP_DIRS = ['node_modules', 'dist', 'coverage', '.next', '.turbo', 'target', 'drizzle'];
const keep = (_path, name) => /\.(ts|tsx|mjs|rs)$/.test(name);

function main() {
  if (process.argv[2] !== '--all') {
    die('the only mode is --all — a staged subset reports clean on a tree that is not');
  }
  for (const owner of [RULE, SHELL, ...Object.keys(SIZE_HOLDERS), ...Object.keys(OTHER_SLOTS)]) {
    if (!existsSync(join(ROOT, owner))) {
      die(
        `${owner} is not there, so the fence names a holder that no longer exists: move it with the code`,
      );
    }
  }
  const files = ROOTS.flatMap((rel) => walkFiles(rel, { skipDirs: SKIP_DIRS, keep }));
  if (files.length === 0) die(`no source files found under ${ROOTS.join(', ')}`);
  const faults = files.flatMap((rel) => fenceFaults(rel, readFileSync(join(ROOT, rel), 'utf8')));
  if (faults.length > 0) {
    console.error(`check-run-slots: ${faults.length} crossing(s) of the subagent slot fence:\n`);
    for (const f of faults) console.error(`  ${f.rel}:${f.line} — ${f.how}`);
    console.error(
      `\nHow many subagents a project may run is ${RULE}:slotsFor, called by ${SHELL} alone\n` +
        '(ISS-1245). Ask the shell (`readBoxSlots`, `refuseRunWithoutSlot`) for an answer instead of\n' +
        'working one out beside it; a file that truly declares or stores the box size is named in\n' +
        'scripts/lib/run-slots-fence.mjs:SIZE_HOLDERS with its reason.',
    );
    process.exit(1);
  }
  console.log(`run-slots: ${files.length} file(s) scanned, one slot rule`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
