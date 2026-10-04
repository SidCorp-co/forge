#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { baseRef } from './lib/base-branch.mjs';
import { gitOut, ROOT } from './lib/gate.mjs';
import { absentPrerequisites, blockedAside, remedyLines } from './lib/prerequisite.mjs';
import { CHECKS, CI_PARITY } from './lib/verify-checks.mjs';
import { ciParity, ciSteps, reportNotRunHere } from './lib/verify-ci-parity.mjs';
import { checksFor, entryEligibility, MODES, unlayered } from './lib/verify-layers.mjs';
import { markFor, tally, tallyLine } from './lib/verify-report.mjs';

const git = (args) => gitOut(args)?.trim() ?? null;

/** The ref the scope was taken against, for the lines that report what a check measured. */
let BASE_REF = null;

/** The merge-base with the branch this change will land on, or why there is none. */
function mergeBase() {
  const target = baseRef(ROOT);
  if (target.refusal) return { refusal: target.refusal };
  BASE_REF = target.ref;
  const base = git(['merge-base', target.ref, 'HEAD']);
  if (base === null) {
    return {
      refusal:
        `\`git merge-base ${target.ref} HEAD\` failed, so no check can be scoped. Fetch it:\n` +
        `  git fetch origin ${target.branch}`,
    };
  }
  return { base };
}

function assertEverySkipIsCovered() {
  const declared = CHECKS.filter((c) => c.skipIf);
  if (declared.length === 0) return;
  const steps = ciSteps();
  if (steps === null || steps.length === 0) {
    console.error(
      'verify: cannot read the steps out of .github/workflows/ci.yml, so no `skipIf` warrant\n' +
        'can be checked. Exit 2 — a skip whose CI cover cannot be confirmed is not a skip.\n',
    );
    process.exit(2);
  }
  const unwarranted = declared.filter((c) => !steps.includes(c.coveredBy));
  if (unwarranted.length === 0) return;
  console.error(`\nverify: ${unwarranted.length} check(s) may skip on a warrant nothing proves:`);
  for (const c of unwarranted) {
    console.error(`  ${c.label}: coveredBy ${c.coveredBy ? `\`${c.coveredBy}\`` : 'not declared'}`);
  }
  console.error(
    '\nA check that skips locally is claiming CI measures it instead. Declare `coveredBy` with\n' +
      'the ci.yml step that does, word for word — or drop the `skipIf`, because a skip nobody\n' +
      'can trace to a step that runs is exit 0 over an assertion nothing asserted. Exit 2.\n',
  );
  process.exit(2);
}

function assertEveryCheckIsLayered() {
  const missing = unlayered([...CHECKS, CI_PARITY]);
  if (missing.length === 0) return;
  console.error(
    `verify: ${missing.length} check(s) declare no layer, or no reason for it:\n` +
      missing.map((m) => `  ${m}`).join('\n') +
      '\nA check belongs to `entry` when it judges each file from that file alone, or fixed files\n' +
      'it names by path, and to\n' +
      '`shared` when its verdict on one file depends on others or on other branches — by what it\n' +
      'reads, never by its name or its cost (scripts/lib/verify-layers.mjs). Exit 2.\n',
  );
  process.exit(2);
}

function assertEveryCheckProvesScan() {
  const unproven = [...CHECKS, CI_PARITY].filter((c) => !c.scanned).map((c) => c.label);
  if (unproven.length === 0) return;
  console.error(
    `verify: ${unproven.length} check(s) declare no \`scanned\` pattern: ${unproven.join(', ')}\n` +
      "Each must match its own checker's success line, so an empty scope reads as exit 2\n" +
      'rather than as a pass. Exit 2 — this script cannot vouch for a run it cannot audit.\n',
  );
  process.exit(2);
}

function verdict(check, status, out) {
  if (status === 2) {
    return {
      ...check,
      code: 2,
      condition: 'blocked',
      out,
      why: 'could not run — the checker says so; its reason is below',
    };
  }

  if (check.skipIf?.test(out)) {
    return {
      ...check,
      code: status ?? 0,
      condition: 'skipped',
      out,
      note: `skipped — not reproducible here; \`${check.coveredBy}\` covers it in CI`,
    };
  }
  if (check.scanned) {
    const m = out.match(check.scanned);
    if (!m) return { ...check, code: 2, out, why: 'no file count in output — cannot prove it ran' };
    const n = Number(m[1]);
    if (n === 0 && !check.scopeMayBeEmpty) {
      return { ...check, code: 2, out, why: 'scanned 0 files — a scope nobody could compute' };
    }
    // What a PASSING check still has to say. `out` is printed only for a non-zero exit,
    // so a checker whose job is partly to report — a worklist, a scope it could not
    // measure — is silent on exactly the runs that are meant to carry it onward.
    const carried = check.carries ? out.match(check.carries)?.[1] : undefined;
    const note = n === 0 ? `no diff against ${BASE_REF} — nothing to scope` : carried;
    return { ...check, code: status ?? 1, out, files: n, note };
  }
  return { ...check, code: status ?? 1, out };
}

function runCheck(check, base) {
  const missing = absentPrerequisites(ROOT, check.needs);
  if (missing.length > 0) {
    return Promise.resolve({
      ...check,
      code: 2,
      condition: 'blocked',
      missing,
      why: blockedAside(missing),
    });
  }

  const cmd = check.cmd.map((a) => (a === '@@MERGE_BASE@@' ? base : a));
  if (cmd.includes('@@MERGE_BASE@@') || (check.scopeMayBeEmpty && base === null)) {
    return Promise.resolve({
      ...check,
      code: 2,
      condition: 'blocked',
      why: 'no base revision available — cannot scope the diff',
    });
  }
  const argv = check.json ? [...cmd, '--json'] : cmd;
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    child.on('error', (err) =>
      done({
        ...check,
        code: 2,
        condition: 'blocked',
        out,
        why: `could not spawn: ${err.message}`,
      }),
    );
    child.on('close', (status) => done(verdict(check, status, out)));
  });
}

function groupGate() {
  const tails = new Map();
  return async (group, fn) => {
    if (!group) return fn();
    const prev = tails.get(group) ?? Promise.resolve();
    let release;
    tails.set(
      group,
      prev.then(
        () =>
          new Promise((r) => {
            release = r;
          }),
      ),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
    }
  };
}

async function runAll(checks, base, width) {
  const results = new Array(checks.length);
  const tty = process.stdout.isTTY;
  const inGroup = groupGate();
  let next = 0;
  let landed = 0;
  const worker = async () => {
    for (let i = next++; i < checks.length; i = next++) {
      results[i] = await inGroup(checks[i].exclusive, () => runCheck(checks[i], base));
      landed += 1;
      if (tty) process.stdout.write(`  … ${landed}/${checks.length} checks${' '.repeat(20)}\r`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, checks.length) }, worker));
  if (tty) process.stdout.write(`${' '.repeat(48)}\r`);
  return results;
}

function reportBlocked(results) {
  const blocked = results.filter((r) => r.condition === 'blocked');
  if (blocked.length === 0) return;
  const remedies = [...new Set(blocked.flatMap((r) => remedyLines(r.missing ?? [])))];
  console.log(
    `\n  ${blocked.length} check(s) could not run. This is a report about THIS CHECKOUT,\n` +
      '  not a verdict on the repo — no rule below was measured, so none of them is\n' +
      '  claimed broken. Exit 2 all the same: a gate that did not run is not a pass.',
  );
  for (const line of remedies) console.log(`    ${line}`);
  if (remedies.length === 0) {
    console.log('    each names its own reason in its output below');
  }
}

function report(results, { code: parityCode, said }) {
  const counted = parityCode === 0 ? said.join('\n').match(CI_PARITY.scanned) : null;
  const parity = parityCode === 0 && !counted ? 2 : parityCode;
  const parityAside =
    parityCode === 0 && !counted
      ? '  printed no step count, so what it read is unknown'
      : counted
        ? `  ${counted[1]} ${CI_PARITY.unit}`
        : '';
  const width = Math.max(...results.map((r) => r.label.length), 18);
  console.log('');
  for (const r of results) {
    const mark = markFor(r);
    const files = r.files === undefined ? '' : `${r.files} ${r.unit ?? 'files'}`;
    const aside = r.why ?? r.note;
    console.log(
      `  ${mark}  ${r.axis.padEnd(10)} ${r.layer.padEnd(6)} ${r.label.padEnd(width)}  ${files}${aside ? `  ${aside}` : ''}`,
    );
  }
  console.log(
    `  ${parity === 0 ? 'ok  ' : 'FAIL'}  ${'meta'.padEnd(10)} ${CI_PARITY.layer.padEnd(6)} ${CI_PARITY.label.padEnd(width)}${parityAside}`,
  );
  console.log(`\n  ${tallyLine(tally([...results, { code: parity }]))}`);
  reportBlocked(results);
  reportNotRunHere();

  const failed = results.filter((r) => r.code !== 0 && r.out !== undefined);
  for (const r of failed) {
    console.error(`\n${'─'.repeat(72)}\n${r.axis} · ${r.label}\n`);
    console.error((r.out ?? '').trimEnd());
  }

  const codes = [...results.map((r) => r.code), parity];
  if (codes.includes(2)) return 2;
  return codes.some((c) => c !== 0) ? 1 : 0;
}

const args = process.argv.slice(2);
const bad = args.filter((a) => !['--ci-parity', '--entry', '--window'].includes(a));
if (bad.length || (args.includes('--entry') && args.includes('--window'))) {
  console.error(
    `usage: verify.mjs [--ci-parity | --entry | --window]\nunknown: ${bad.join(' ') || 'both --entry and --window'}`,
  );
  process.exit(2);
}

assertEveryCheckIsLayered();
assertEveryCheckProvesScan();
assertEverySkipIsCovered();

if (args.includes('--ci-parity')) process.exit(ciParity());

const scope = mergeBase();
if (scope.refusal) {
  console.error(`verify: ${scope.refusal}`);
  process.exit(2);
}
const base = scope.base;

let mode = args.includes('--entry') ? 'entry' : args.includes('--window') ? 'window' : 'whole';
if (mode === 'entry') {
  const judged = entryEligibility(ROOT, base);
  if (judged.refusal) {
    console.error(`verify --entry: ${judged.refusal}`);
    process.exit(2);
  }
  if (!judged.eligible) {
    console.log(
      'verify --entry: this change is not queue-eligible, so it takes the whole gate here:\n' +
        judged.surfaces.map((s) => `  ${s}`).join('\n'),
    );
    mode = 'whole';
  }
}
const checks = checksFor(mode, CHECKS);
console.log(
  `verify: ${checks.length} checks against ${base.slice(0, 8)} on ${BASE_REF} — ${MODES[mode]}`,
);
if (mode === 'entry') {
  const left = CHECKS.filter((c) => c.layer === 'shared').map((c) => c.label);
  console.log(`  a verify window pays the ${left.length} shared check(s) once: ${left.join(', ')}`);
}
const WIDTH = Number(process.env.VERIFY_CONCURRENCY) || 6;
const results = await runAll(checks, base, WIDTH);

const said = [];
process.exit(report(results, { code: ciParity(true, said), said }));
