#!/usr/bin/env node
// Every tracked test file must be collected by some runner, and a suite that is
// skipped unconditionally must say why.
//
// Both halves come from real findings, on 2026-08-25. `packages/tests` held 64
// test files that no runner collected — no package.json, so pnpm never saw the
// directory and turbo never ran it — and they had been testing two deleted
// packages since 2026-08-23. Separately, the device-runner E2E sat behind
// `describe.skipIf(!process.env.FORGE_E2E_REAL_PAIR)` waiting on endpoints that
// had already shipped; when the flag was finally set it failed immediately, with
// three bugs accumulated in a code path nothing had executed for months.
//
// Neither is visible to a test runner: a file it never collects produces no
// output at all, and a skipped suite reports as a pass.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_RE,
  isSuiteSkip,
  judge,
  SKIPS_PATH,
  TEST_FILE_RE,
} from './lib/test-reachability.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split('\n').filter(Boolean);
}

/**
 * Ask one vitest project which files it would collect.
 *
 * Returns repo-relative paths, or `null` when the runner could not answer.
 */
function collect(configRel) {
  const cwd = resolve(ROOT, dirname(configRel));
  const r = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'list', '--filesOnly', '--config', configRel.split('/').pop()],
    { cwd, encoding: 'utf8', timeout: 300_000 },
  );
  if (r.status !== 0) return null;
  const files = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => TEST_FILE_RE.test(l))
    .map((l) => relative(ROOT, resolve(cwd, l)));
  // cm:guard an empty answer is a FAILED answer, never "this runner collects nothing". A `vitest list` that errors prints to stderr and exits non-zero, but one whose config loaded and matched nothing looks identical to a successful empty run — and treating either as zero would make every file that runner owns look unreachable, or worse, let a broken runner shrink the collected set until the gate passes on a repo that runs no tests at all.
  return files.length > 0 ? files : null;
}

function readSkips() {
  const p = join(ROOT, SKIPS_PATH);
  if (!existsSync(p)) return {};
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    return doc.declared ?? {};
  } catch {
    return null;
  }
}

const tracked = git(['ls-files']);
if (!tracked) {
  console.error('test-reachability: could not list tracked files — not a git repository?');
  process.exit(2);
}

const testFiles = tracked.filter((f) => TEST_FILE_RE.test(f));
const configs = tracked.filter((f) => CONFIG_RE.test(f));

if (configs.length === 0) {
  console.error('test-reachability: found no vitest config — nothing could collect anything');
  process.exit(2);
}

const collectedPerRunner = Object.fromEntries(configs.map((cfg) => [cfg, collect(cfg)]));
const declaredSkips = readSkips();
const skipHits = testFiles.filter((f) =>
  readFileSync(join(ROOT, f), 'utf8').split('\n').some(isSuiteSkip),
);

const verdict = judge({ testFiles, collectedPerRunner, declaredSkips, skipHits });
if (verdict.code === 2) {
  console.error(`test-reachability: ${verdict.reason} — cannot judge coverage`);
  process.exit(2);
}
const { unreachable, undeclaredSkips } = verdict;

if (verdict.code === 0) {
  const declared = Object.keys(declaredSkips).length;
  const note = declared > 0 ? `, ${declared} declared skip(s)` : '';
  console.log(
    `test-reachability: ${testFiles.length} tracked test file(s), all collected by ${configs.length} runner(s)${note}`,
  );
  process.exit(0);
}

if (unreachable.length > 0) {
  console.error(`\ntest-reachability: ${unreachable.length} test file(s) no runner collects:\n`);
  for (const f of unreachable) console.error(`  ${f}`);
  console.error(
    '\nA file no runner collects produces no output, so it reads as a suite that passes.',
  );
  console.error("Delete it, or bring it into a vitest config's include list.");
}

if (undeclaredSkips.length > 0) {
  console.error(`\ntest-reachability: ${undeclaredSkips.length} file(s) skip a whole suite:\n`);
  for (const f of undeclaredSkips) console.error(`  ${f}`);
  console.error(`\nA skipped describe reports as a passing file. Declare it in ${SKIPS_PATH}:`);
  console.error('  { "declared": { "<path>": "<why it cannot run here>" } }');
  console.error('and the reason is the point — "waiting on X" is how the last one rotted.');
}

process.exit(1);
