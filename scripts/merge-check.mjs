#!/usr/bin/env node
// The merge check, dev's whole gate before a merge (Issue to release r20 `rule-merge`; REQ-36 BC-9,
// BC-15, BC-17; ISS-472). On the change as it would land — HEAD containing the latest base — it runs
// only: the typecheck, the direct tests of the touched files in every package, the direct core
// integration tests, the issue's kept probes run against the change (`lib/merge-probes.mjs`), and
// `pnpm verify`. No import-graph widening, no whole-suite fallback. It writes
// the report the tracker records on the issue — each check with its kind and duration, recorded once
// (ISS-474) — which the merge mark then asks for. On the fast lane (REQ-39 BC-7: a change a person
// approved in its live preview) it runs the typecheck and the direct tests only, and the report names
// the change's patch id, which core holds to the one the approved preview served.
//
//   pnpm merge-check --probes <file>     against the latest origin/<base>, fetched first, running the
//                                        kept probes of the issue whose criteria read <file> holds
//                                        (`GET /api/issues/:id/criteria`, saved)
//   pnpm merge-check --probes none       a run that names no issue (CI's): it runs no probe, and core
//                                        refuses MERGE_PROBE_MISSING where the issue keeps one
//   pnpm merge-check --probe-origin <url>  the origin serving a build of the change: a command probe
//                                        reads it as FORGE_PROBE_ORIGIN, a request probe is sent to it
//   pnpm merge-check --since <sha>       a landing already on its base: the change since <sha>
//   pnpm merge-check --report <path>     where the report goes (default: the OS temp directory)
//   pnpm merge-check --lane fast         the fast lane: no integration tests, no probes, no verify
//
// Exit 0: every check passed. 1: a check or probe is red, a probe is missing, or the change is behind
// its base. 2: it could not run.

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
  LANES,
  missingCheck,
  NOT_RUN_HERE,
  notRunOnLane,
  passedMessage,
  patchIdOf,
  redChecks,
  reportOf,
  verifyCommand,
  verifyEnv,
} from './lib/merge-check.mjs';
import { originOf, probeRefusalLines, readProbesFlag, runProbes } from './lib/merge-probes.mjs';

const die = dieAs('merge-check');

const args = process.argv.slice(2);
const takes = new Set(['--since', '--report', '--lane', '--probes', '--probe-origin']);
for (const [i, a] of args.entries()) {
  if (a.startsWith('--') && !takes.has(a))
    die(
      `unknown flag ${a}; takes --probes <criteria.json | none>, --probe-origin <url>, --since <sha>, --report <path>, --lane <${LANES.join(' | ')}>`,
    );
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
const lane = flagValue('--lane') ?? 'full';
if (!LANES.includes(lane)) die(`--lane ${lane} is not a lane; the lanes are ${LANES.join(', ')}`);

// The kept probes, read before anything runs: a full-lane merge needs them (REQ-36 BC-9), and a run
// that cannot say whose they are says so with `none` rather than passing them by silence.
const probesFlag = flagValue('--probes');
const originFlag = flagValue('--probe-origin');
let criteria = null;
let origin = null;
if (lane === 'fast') {
  if (probesFlag !== null || originFlag !== null)
    die('the fast lane runs no probes (REQ-39 BC-7); drop --probes and --probe-origin');
} else {
  if (probesFlag === null)
    die(
      "a merge runs its issue's kept probes: pass --probes <file>, the saved answer of " +
        '`GET /api/issues/<issue id>/criteria`, or --probes none for a run that names no issue',
    );
  const read = readProbesFlag(probesFlag);
  if (read.refusal) die(read.refusal);
  criteria = read.criteria;
  if (originFlag !== null) {
    const o = originOf(originFlag);
    if (o.refusal) die(o.refusal);
    origin = o.origin;
  }
}

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

const diff = spawnSync('git', ['diff', '--binary', baseSha, head], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 512 * 1024 * 1024,
});
if (diff.status !== 0) die(`git diff ${baseSha.slice(0, 12)} ${head.slice(0, 12)} failed`);
const printed = spawnSync('git', ['patch-id', '--stable'], {
  cwd: ROOT,
  input: diff.stdout,
  encoding: 'utf8',
});
const read = patchIdOf(printed.stdout ?? '');
if (read.refusal) die(read.refusal);
const patchId = read.id;

console.log(
  `merge-check: ${head.slice(0, 12)} against ${branch} at ${baseSha.slice(0, 12)}${since ? ' (landed)' : ''}, ${touched.length} file(s) touched, ${lane} lane, patch id ${patchId}`,
);

checks.push(...runTypecheck(ROOT, { baseRef: baseSha, touched: touched.map((t) => t.path) }));
const direct = runDirectTests(ROOT, { touched, integration: lane === 'full' });
checks.push(...direct.checks);

const probeRun =
  lane === 'full'
    ? await runProbes(criteria, { root: ROOT, origin })
    : { checks: [], bindings: [], missing: [], red: [] };
checks.push(...probeRun.checks);

if (lane === 'full') {
  // A landed run hands verify the landing's base: the base branch's tip is HEAD there, and every
  // delta-scoped gate would otherwise measure an empty change (ISS-472 round 3).
  const landedSince = since ? baseSha : null;
  const verify = run(['pnpm', 'verify'], ROOT, {
    env: verifyEnv({ branch, since: landedSince, env: process.env }),
  });
  checks.push(
    check({
      name: 'verify',
      kind: 'conformance',
      scope: 'workspace',
      command: verifyCommand({ branch, since: landedSince }),
      files: [],
      result: verify.ok ? 'pass' : 'fail',
      startedAt: verify.startedAt,
      durationMs: verify.durationMs,
    }),
  );
}

const missing = missingCheck(checks, lane);
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
  probes: probeRun.bindings,
  lane,
  patchId,
});
const path = flagValue('--report') ?? join(tmpdir(), `forge-merge-check-${head.slice(0, 12)}.json`);
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);

console.log('\nmerge-check: what ran');
for (const line of describeChecks(checks)) console.log(line);
for (const n of [...notRunOnLane(lane), ...NOT_RUN_HERE])
  console.log(`  not run here: ${n.name} — ${n.why} (${n.owner})`);
if (direct.untested.length) {
  console.log(
    `  no direct test reaches: ${direct.untested.join(', ')}\n  (a test guarding one by path declares it with \`@direct-test-of <path>\`)`,
  );
}

const red = redChecks(checks);
const probeFaults = probeRefusalLines(probeRun);
for (const line of probeFaults) console.error(`\nmerge-check: ${line}. Report: ${path}`);
if (red.length) {
  console.error(
    `\nmerge-check: MERGE_CHECK_RED — ${red.map((c) => `${c.name} (${c.scope})`).join(', ')}. Report: ${path}`,
  );
}
if (red.length || probeFaults.length) process.exit(1);
console.log(`\n${passedMessage({ mode: report.mode, branch, baseSha, head, path })}`);
