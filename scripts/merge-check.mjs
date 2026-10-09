#!/usr/bin/env node
// The merge check, dev's whole gate before a merge (Issue to release r20 `rule-merge`; REQ-36 BC-9,
// BC-15, BC-17; ISS-472). On the change as it would land — HEAD containing the latest base — it runs
// only: the typecheck, the direct tests of the touched files in every package, the direct core
// integration tests, and `pnpm verify`. No import-graph widening, no whole-suite fallback. It writes
// the report the tracker records on the issue — each check with its kind and duration, recorded once
// (ISS-474) — which the merge mark then asks for.
//
//   pnpm merge-check                     against the latest origin/<base>, fetched first
//   pnpm merge-check --since <sha>       a landing already on its base: the change since <sha>
//   pnpm merge-check --report <path>     where the report goes (default: the OS temp directory)
//
// Exit 0: every check passed. 1: a check is red or the change is behind its base. 2: it could not run.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeTarget } from './lib/base-branch.mjs';
import {
  check,
  describeChecks,
  run,
  runDirectTests,
  runTypecheck,
  touchedBetween,
} from './lib/direct-test-run.mjs';
import { dieAs, gitOut, ROOT } from './lib/gate.mjs';
import {
  behindRefusal,
  dirtyRefusal,
  emptyRefusal,
  missingCheck,
  NOT_RUN_HERE,
  redChecks,
  reportOf,
} from './lib/merge-check.mjs';

const die = dieAs('merge-check');

const args = process.argv.slice(2);
const takes = new Set(['--since', '--report']);
for (const [i, a] of args.entries()) {
  if (a.startsWith('--') && !takes.has(a))
    die(`unknown flag ${a}; takes --since <sha>, --report <path>`);
  if (!a.startsWith('--') && !takes.has(args[i - 1])) die(`unexpected argument ${a}`);
}
const flagValue = (flag) => {
  const at = args.indexOf(flag);
  if (at === -1) return null;
  const v = args[at + 1];
  if (!v || v.startsWith('--')) die(`${flag} needs a value`);
  return v;
};
const since = flagValue('--since');

const git = (...a) => {
  const out = gitOut(a, ROOT);
  if (out === null) die(`git ${a.join(' ')} failed`);
  return out.trim();
};

const head = git('rev-parse', 'HEAD');
const dirty = dirtyRefusal(git('status', '--porcelain', '--untracked-files=all'));
if (dirty) die(dirty);

const target = mergeTarget(ROOT);
if (target.refusal) die(`no base to check against: ${target.refusal}`);
const branch = target.branch;

let baseSha;
const checks = [];
if (since) {
  baseSha = git('rev-parse', '--verify', `${since}^{commit}`);
  if (
    spawnSync('git', ['merge-base', '--is-ancestor', baseSha, head], { cwd: ROOT }).status !== 0
  ) {
    die(`--since ${since} is not an ancestor of HEAD, so the change since it is not one landing`);
  }
  checks.push(
    check({
      name: 'rebased-on-base',
      kind: 'base',
      scope: branch,
      command: `landed: ${baseSha.slice(0, 12)}..${head.slice(0, 12)} is already on ${branch}`,
      files: [],
      result: 'pass',
      startedAt: Date.now(),
      durationMs: 0,
    }),
  );
} else {
  const started = Date.now();
  const fetched = spawnSync('git', ['fetch', '--quiet', 'origin', branch], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (fetched.status !== 0) die(`git fetch origin ${branch} failed: ${fetched.stderr.trim()}`);
  baseSha = git('rev-parse', `refs/remotes/origin/${branch}`);
  const tipInHead =
    spawnSync('git', ['merge-base', '--is-ancestor', baseSha, head], { cwd: ROOT }).status === 0;
  const behind = behindRefusal({ branch, tip: baseSha, head, tipInHead });
  checks.push(
    check({
      name: 'rebased-on-base',
      kind: 'base',
      scope: branch,
      command: `git merge-base --is-ancestor origin/${branch} HEAD`,
      files: [],
      result: behind ? 'fail' : 'pass',
      startedAt: started,
      durationMs: Date.now() - started,
    }),
  );
  if (behind) {
    console.error(`merge-check: ${behind}`);
    process.exit(1);
  }
}

const touched = touchedBetween(ROOT, baseSha, head);
const empty = emptyRefusal({ branch, head, touched });
if (empty) die(empty);

console.log(
  `merge-check: ${head.slice(0, 12)} against ${branch} at ${baseSha.slice(0, 12)}${since ? ' (landed)' : ''}, ${touched.length} file(s) touched`,
);

checks.push(...runTypecheck(ROOT, { baseRef: baseSha, touched: touched.map((t) => t.path) }));
const direct = runDirectTests(ROOT, { touched, integration: true });
checks.push(...direct.checks);

const verify = run(['pnpm', 'verify'], ROOT, { env: { ...process.env, GITHUB_BASE_REF: branch } });
checks.push(
  check({
    name: 'verify',
    kind: 'conformance',
    scope: 'workspace',
    command: `GITHUB_BASE_REF=${branch} pnpm verify`,
    files: [],
    result: verify.ok ? 'pass' : 'fail',
    startedAt: verify.startedAt,
    durationMs: verify.durationMs,
  }),
);

const missing = missingCheck(checks);
if (missing)
  die(
    `the run made no \`${missing}\` check, which every merge needs; this is a defect of the script`,
  );

const report = reportOf({
  branch,
  baseSha,
  head,
  mode: since ? 'landed' : 'pre-merge',
  touched,
  checks,
});
const path = flagValue('--report') ?? join(tmpdir(), `forge-merge-check-${head.slice(0, 12)}.json`);
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);

console.log('\nmerge-check: what ran');
for (const line of describeChecks(checks)) console.log(line);
for (const n of NOT_RUN_HERE) console.log(`  not run here: ${n.name} — ${n.why} (${n.owner})`);
if (direct.untested.length) {
  console.log(
    `  no direct test reaches: ${direct.untested.join(', ')}\n  (a test guarding one by path declares it with \`@direct-test-of <path>\`)`,
  );
}

const red = redChecks(checks);
if (red.length) {
  console.error(
    `\nmerge-check: MERGE_CHECK_RED — ${red.map((c) => `${c.name} (${c.scope})`).join(', ')}. Report: ${path}`,
  );
  process.exit(1);
}
console.log(
  `\nmerge-check: passed. Record it on the issue before the merge mark, with the report as the body:\n` +
    `  POST /api/issues/<issue id>/merge-check   < ${path}`,
);
