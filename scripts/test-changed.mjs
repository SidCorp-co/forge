#!/usr/bin/env node
// A developer's run before a push (REQ-36 BC-7, BC-17): the typecheck and the DIRECT tests of what
// this checkout changed against the branch it lands on, committed or not, in every package, and a
// line for each thing it ran. The selection is `scripts/lib/direct-tests.mjs`'s; nothing widens it.
//
//   pnpm test:changed                 typecheck and direct unit tests
//   pnpm test:changed --integration   the direct core integration tests too (a throwaway Postgres)
//
// The merge gate is `pnpm merge-check`, which runs this on the change rebased onto the latest base
// with the integration tests and `pnpm verify`, and writes the record the merge needs.

import { spawnSync } from 'node:child_process';
import { baseRef } from './lib/base-branch.mjs';
import {
  describeChecks,
  runDirectTests,
  runTypecheck,
  touchedBetween,
} from './lib/direct-test-run.mjs';
import { dieAs, ROOT } from './lib/gate.mjs';

const die = dieAs('test-changed');

const args = process.argv.slice(2);
const unknown = args.find((a) => a !== '--integration');
if (unknown) die(`unknown argument ${unknown}; takes --integration`);
const integration = args.includes('--integration');

const target = baseRef(ROOT);
if (target.refusal) die(`no base to measure against: ${target.refusal}`);
const mb = spawnSync('git', ['merge-base', target.ref, 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
if (mb.status !== 0) die(`git merge-base ${target.ref} HEAD failed: ${mb.stderr.trim()}`);
const base = mb.stdout.trim();

const touched = touchedBetween(ROOT, base);
console.log(
  `test-changed: ${touched.length} file(s) changed against ${target.ref} (${base.slice(0, 9)}), committed or not`,
);
if (touched.length === 0) {
  console.log('test-changed: nothing changed, so nothing to run');
  process.exit(0);
}

const checks = runTypecheck(ROOT, { baseRef: target.ref, touched: touched.map((t) => t.path) });
const direct = runDirectTests(ROOT, { touched, integration });
checks.push(...direct.checks);

console.log('\ntest-changed: what ran');
for (const line of describeChecks(checks)) console.log(line);
if (!integration && direct.integrationSelected.length) {
  console.log(
    `\n  not run: ${direct.integrationSelected.length} direct core integration test(s) — pass --integration, or the merge check runs them`,
  );
}
if (direct.untested.length) {
  console.log(
    `\n  no direct test reaches ${direct.untested.length} touched code file(s):\n${direct.untested.map((p) => `    ${p}`).join('\n')}\n  A test that guards one by path, not by import, declares it with \`@direct-test-of <path>\`.`,
  );
}
process.exit(checks.some((c) => c.result === 'fail') ? 1 : 0);
