#!/usr/bin/env node
// Conformance entrypoint — the one command to run after coding, before pushing.
//
// The mechanism is this script, not the hooks. Claude Code hooks need a plugin
// installed and git hooks need `pnpm install` plus no SKIP_* in the env, so
// neither can be what correctness depends on. Everything reachable from here
// works with a bare checkout and a node binary.
//
// Three contracts, ordered by what breaks without them:
//   1. CI parity — every step in ci.yml is run here or explicitly declared as
//      covered by another root script, and the one step that lives in the
//      setup-workspace composite rather than in ci.yml still runs before the
//      install it guards. `--ci-parity` proves both.
//   2. Fail-closed — a checker that scanned zero files exits 2, never 0. A
//      green report from a check that never ran is worse than no check at all.
//   2b. One proposition per verdict — "the rule holds", "the rule is broken"
//      and "I could not run" are three answers; see `MARKS` in lib/verify-report.mjs.
//   3. Report everything — no early exit, so one fix cycle instead of six.
//
// Modes: (none) full · --ci-parity the parity proof
// Exit: 0 clean · 1 violations · 2 a check could not run.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absentPrerequisites, blockedAside, remedyLines } from './lib/prerequisite.mjs';
import { markFor, tally, tallyLine } from './lib/verify-report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CI_PATH = join(ROOT, '.github', 'workflows', 'ci.yml');
const COMPOSITE_PATH = join(ROOT, '.github', 'actions', 'setup-workspace', 'action.yml');

const CHECKS = [
  {
    axis: 'language',
    label: 'source-language',
    cmd: ['node', 'scripts/check-source-language.mjs', '--all'],
    scanned: /across (\d+) files/,
  },
  {
    axis: 'record',
    label: 'release-record',
    cmd: ['node', 'scripts/check-release-record.mjs'],
    scanned: /^release-record: (\d+) entr/m,
    unit: 'release entries',
  },
  {
    axis: 'behaviour',
    label: 'test-signal',
    cmd: ['node', 'scripts/check-test-signal.mjs', '--all'],
    scanned: /^test-signal: (\d+) test file/m,
  },
  {
    axis: 'behaviour',
    label: 'test-reachability',
    cmd: ['node', 'scripts/check-test-reachability.mjs'],
    scanned: /^test-reachability: (\d+) tracked test file/m,
    needs: ['deps'],
    unit: 'test files',
  },
  {
    axis: 'behaviour',
    label: 'flow-coverage',
    cmd: ['node', 'scripts/check-flow-coverage.mjs', '--all'],
    scanned: /: (\d+) step\(s\) across/,
    unit: 'flow steps',
    skipIf: /skipped — (no|stale) coverage report/,
  },
  {
    axis: 'knowledge',
    label: 'flow-map',
    cmd: ['node', 'scripts/build-flow-map.mjs', '--check'],
    scanned: /: (\d+) flow\(s\) across/,
    unit: 'flows',
  },
  {
    axis: 'knowledge',
    label: 'pat-surface',
    cmd: ['node', 'scripts/check-pat-surface.mjs'],
    scanned:
      /^pat-surface: \d+ resource\(s\) · \d+ permission group\(s\) · \d+ covered prefix\(es\) · \d+ router file\(s\) · (\d+) route/m,
    unit: 'PAT-reachable routes',
  },
  {
    axis: 'knowledge',
    label: 'injected-doc-modes',
    cmd: ['node', 'scripts/check-injected-doc-modes.mjs'],
    scanned: /^injected-doc-modes: (\d+) mode-specific claim/m,
    unit: 'mode-specific claims',
  },
  {
    axis: 'knowledge',
    label: 'retired-model',
    cmd: ['node', 'scripts/check-retired-model.mjs'],
    scanned: /^check-retired-model: (\d+) files scanned/m,
    unit: 'files',
  },
  {
    axis: 'knowledge',
    label: 'honest-costs',
    cmd: ['node', 'scripts/check-honest-costs.mjs'],
    scanned: /^honest-costs: (\d+) document/m,
    unit: 'documents',
  },
  {
    axis: 'relations',
    label: 'archmap',
    cmd: ['./.forge/archmap/archmap', 'check'],
    scanned: /archmap · (\d+) files/,
    needs: ['deps', 'observability-build'],
  },
  {
    axis: 'form',
    label: 'core lint',
    cmd: ['pnpm', '--filter', '@forge/core', 'lint'],
    scanned: /Checked (\d+)/,
    needs: ['deps'],
  },
  {
    axis: 'form',
    label: 'lint-budget',
    cmd: ['node', 'scripts/check-lint-budget.mjs', '--all'],
    scanned: /^lint-budget: (\d+) file/m,
    needs: ['deps'],
  },
  {
    axis: 'form',
    label: 'size-budget',
    cmd: ['node', 'scripts/check-size-budget.mjs', '--all'],
    scanned: /^size-budget: (\d+) file/m,
    needs: ['deps'],
  },
  {
    axis: 'form',
    label: 'scripts lint',
    cmd: ['pnpm', 'exec', 'biome', 'check', 'scripts'],
    scanned: /^Checked (\d+) files/m,
    needs: ['deps'],
  },
  {
    axis: 'form',
    label: 'core typecheck',
    cmd: ['pnpm', '--filter', '@forge/core', 'exec', 'tsc', '--noEmit', '--extendedDiagnostics'],
    scanned: /^Files:\s+(\d+)/m,
    needs: ['deps', 'observability-build'],
  },
  {
    axis: 'runner',
    label: 'cargo gates',
    cmd: ['node', 'scripts/check-runner-gates.mjs'],
    scanned: /^runner-gates: (\d+) crate file\(s\) in scope/m,
    unit: 'crate files',
    scopeMayBeEmpty: true,
    skipIf: /skipped — cargo not available/,
  },
  {
    axis: 'meta',
    label: 'lockfile-transport',
    cmd: ['node', 'scripts/check-lockfile-transport.mjs'],
    scanned: /^lockfile-transport: (\d+) resolution\(s\), none over SSH/m,
    unit: 'resolutions',
  },
  {
    axis: 'meta',
    label: 'conformance levels',
    cmd: ['node', 'scripts/conformance-status.mjs'],
    scanned: /^conformance-status: (\d+) axes measured/m,
    unit: 'axes',
  },
  {
    axis: 'meta',
    label: 'conformance audit',
    cmd: ['node', 'scripts/conformance-audit.mjs'],
    scanned: /^conformance-audit: (\d+) rules evaluated/m,
    unit: 'rules',
  },
];

const CI_COVERAGE = {
  'node scripts/check-honest-costs.mjs': 'verify',
  'node scripts/check-release-record.mjs': 'verify',
  'node scripts/check-injected-doc-modes.mjs': 'verify',
  'node scripts/check-retired-model.mjs': 'verify',
  'node scripts/check-pat-surface.mjs': 'verify',
  'node scripts/check-source-language.mjs --all': 'verify',
  'node scripts/check-test-signal.mjs --all': 'verify',
  'node scripts/check-size-budget.mjs --all': 'verify',
  'node scripts/check-lint-budget.mjs --all': 'verify',
  'node scripts/conformance-status.mjs': 'verify',
  'node scripts/conformance-audit.mjs': 'verify',
  'node scripts/verify.mjs --ci-parity': 'verify, as its own final check',
  './.forge/archmap/archmap check': 'verify',
  'node scripts/check-test-reachability.mjs': 'verify',
  'pnpm exec biome check scripts': 'verify',
  'pnpm --filter @forge/core lint': 'verify',
  'pnpm --filter @forge/core typecheck': 'verify',
  'pnpm --filter web-v2 lint': 'verify, as the lint-budget check',
  'pnpm --filter @forge/contracts test': 'pnpm test',
  'pnpm --filter web-v2 exec vitest run --passWithNoTests': 'pnpm test',
  'pnpm --filter web-v2 build': 'pnpm build',
  'pnpm --filter @forge/core test': 'pnpm test',
  'pnpm --filter @forge/core build': 'pnpm build',
  'TEST_DB_MODE=container pnpm --filter @forge/core test:integration:coverage':
    'pnpm --filter @forge/core test:integration',
  'node scripts/check-flow-coverage.mjs --all --require-sources': 'verify, minus --require-sources',
  'Lockfile sync + fmt + clippy + test':
    'verify, via scripts/check-runner-gates.mjs when packages/runner changed — on THIS box only, while CI runs the same step on all three platforms',
  'Check Markdown links': 'docs job, gaurav-nelson/github-action-markdown-link-check',
  'Whether a pull_request run already proved this exact tree':
    "nothing local — it reads the event and the commit's parent count, which exist only on CI",
  'Require every CI job to have passed or been skipped': 'the ci-passed gate itself',
};

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function mergeBase() {
  return git(['merge-base', 'origin/main', 'HEAD']);
}

function assertEveryCheckProvesScan() {
  const unproven = CHECKS.filter((c) => !c.scanned).map((c) => c.label);
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
      note: 'skipped — prerequisite absent locally, CI runs it',
    };
  }
  if (check.scanned) {
    const m = out.match(check.scanned);
    if (!m) return { ...check, code: 2, out, why: 'no file count in output — cannot prove it ran' };
    const n = Number(m[1]);
    if (n === 0 && !check.scopeMayBeEmpty) {
      return { ...check, code: 2, out, why: 'scanned 0 files — a scope nobody could compute' };
    }
    const note = n === 0 ? 'no diff against origin/main — nothing to scope' : undefined;
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
      why: 'origin/main not available — cannot scope the diff',
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

async function runAll(checks, base, width) {
  const results = new Array(checks.length);
  const tty = process.stdout.isTTY;
  let next = 0;
  let landed = 0;
  const worker = async () => {
    for (let i = next++; i < checks.length; i = next++) {
      results[i] = await runCheck(checks[i], base);
      landed += 1;
      if (tty) process.stdout.write(`  … ${landed}/${checks.length} checks${' '.repeat(20)}\r`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, checks.length) }, worker));
  if (tty) process.stdout.write(`${' '.repeat(48)}\r`);
  return results;
}

function ciSteps() {
  if (!existsSync(CI_PATH)) return null;
  const lines = readFileSync(CI_PATH, 'utf8').split('\n');
  const steps = [];
  for (const line of lines) {
    const run = line.match(/^\s+- run:\s+(\S.*?)\s*$/);
    if (run && run[1] !== '|') steps.push(run[1]);
    const named = line.match(/^\s+- name:\s+(\S.*?)\s*$/);
    if (named) steps.push(named[1]);
  }
  return steps;
}

function ciGateParity() {
  const text = readFileSync(CI_PATH, 'utf8');
  const needs = /ci-passed:[\s\S]*?needs:\s*\[([^\]]*)\]/.exec(text);
  if (!needs)
    return { code: 2, why: 'cannot find ci-passed.needs — the parser, not the workflow, is wrong' };
  const declared = needs[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const asserted = [
    ...text.matchAll(/"([a-z0-9-]+):\$\{\{\s*needs\.[a-z0-9-]+\.result\s*\}\}"/g),
  ].map((m) => m[1]);
  const unasserted = declared.filter((j) => j !== 'changes' && !asserted.includes(j));
  if (unasserted.length === 0) return { code: 0, count: declared.length };
  return { code: 1, unasserted };
}

function composedGuardParity() {
  if (!existsSync(COMPOSITE_PATH)) {
    return { code: 2, why: 'cannot find .github/actions/setup-workspace/action.yml' };
  }
  const runs = [...readFileSync(COMPOSITE_PATH, 'utf8').matchAll(/^\s+run:\s+(\S.*?)\s*$/gm)].map(
    (m) => m[1],
  );
  if (runs.length === 0) {
    return { code: 2, why: 'parsed 0 run steps out of the composite — the parser, not the action' };
  }
  const guard = runs.findIndex((r) => r.includes('check-lockfile-transport.mjs'));
  const install = runs.findIndex((r) => r.startsWith('pnpm install'));
  if (install < 0)
    return { code: 2, why: 'the composite runs no `pnpm install` — the parser again' };
  if (guard < 0)
    return { code: 1, why: 'the composite no longer runs check-lockfile-transport.mjs' };
  if (guard >= install) {
    return {
      code: 1,
      why:
        guard === install
          ? 'the composite runs check-lockfile-transport.mjs and `pnpm install` in one step, where their order cannot be read'
          : 'the composite runs check-lockfile-transport.mjs AFTER `pnpm install`',
    };
  }
  return { code: 0 };
}

function ciParity(quiet) {
  const steps = ciSteps();
  if (steps === null) {
    console.error('ci-parity: .github/workflows/ci.yml not found');
    return 2;
  }
  if (steps.length === 0) {
    console.error(
      'ci-parity: parsed 0 steps out of ci.yml — the parser, not the workflow, is wrong',
    );
    return 2;
  }
  const gate = ciGateParity();
  if (gate.code !== 0) {
    console.error(
      `\nci-parity: ${gate.why ?? `${gate.unasserted.length} job(s) in ci-passed.needs that ci-passed never asserts:`}`,
    );
    for (const j of gate.unasserted ?? []) console.error(`  ${j}`);
    console.error(
      '\n`ci-passed` runs `if: always()`. A job it needs but never names in the result',
    );
    console.error('loop completes, is ignored, and cannot block the merge — the gate reads as');
    console.error('enforced and is not. Add it to the loop in .github/workflows/ci.yml.\n');
    return gate.code;
  }

  const composed = composedGuardParity();
  if (composed.code !== 0) {
    console.error(`\nci-parity: ${composed.why}`);
    console.error(
      '\nEvery job that installs the workspace reaches `pnpm install` through that composite,\n' +
        'and the lockfile entry the checker refuses is the one that kills the install — so a\n' +
        'check placed after it never runs at all. Six jobs died inside the install with exit 128\n' +
        'and nothing named the cause for two days (ISS-1045). Restore the step between\n' +
        '`actions/setup-node` and `pnpm install` in .github/actions/setup-workspace/action.yml.\n',
    );
    return composed.code;
  }

  const missing = steps.filter((s) => !(s in CI_COVERAGE));
  if (missing.length === 0) {
    if (!quiet) {
      console.log(
        `ci-parity: ${steps.length} CI step(s) declared, ${gate.count} gate job(s) asserted`,
      );
    }
    return 0;
  }
  console.error(`\nci-parity: ${missing.length} CI step(s) not declared in CI_COVERAGE:`);
  for (const m of missing) console.error(`  ${m}`);
  console.error('\nAdd each to CI_COVERAGE in scripts/verify.mjs — either "verify" (this script');
  console.error('runs it) or the root script that does. An undeclared step is a gate that CI');
  console.error('enforces and `pnpm verify` silently skips.\n');
  return 1;
}

function reportNotRunHere() {
  const elsewhere = Object.entries(CI_COVERAGE)
    .filter(([, where]) => !where.startsWith('verify'))
    .filter(([step]) => RUN_ELSEWHERE_HINT.some((h) => step.includes(h)));
  if (elsewhere.length === 0) return;
  console.log(`\n  CI runs these too — verify does NOT. Run them before you trust a green:`);
  for (const cmd of [...new Set(elsewhere.map(([, where]) => where))].sort()) {
    console.log(`    ${cmd}`);
  }
}

const RUN_ELSEWHERE_HINT = ['test:integration', 'web-v2', '@forge/core test', '@forge/core build'];

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

function report(results, parity) {
  const width = Math.max(...results.map((r) => r.label.length), 18);
  console.log('');
  for (const r of results) {
    const mark = markFor(r);
    const files = r.files === undefined ? '' : `${r.files} ${r.unit ?? 'files'}`;
    const aside = r.why ?? r.note;
    console.log(
      `  ${mark}  ${r.axis.padEnd(10)} ${r.label.padEnd(width)}  ${files}${aside ? `  ${aside}` : ''}`,
    );
  }
  console.log(`  ${parity === 0 ? 'ok  ' : 'FAIL'}  ${'meta'.padEnd(10)} ci-parity`);
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
const bad = args.filter((a) => !['--ci-parity'].includes(a));
if (bad.length) {
  console.error(`usage: verify.mjs [--ci-parity]\nunknown: ${bad.join(' ')}`);
  process.exit(2);
}

assertEveryCheckProvesScan();

if (args.includes('--ci-parity')) process.exit(ciParity());

const base = mergeBase();
if (base === null) {
  console.error('verify: `git merge-base origin/main HEAD` failed. Fetch origin first:');
  console.error('  git fetch origin main');
  process.exit(2);
}

console.log(`verify: ${CHECKS.length} checks against ${base.slice(0, 8)}`);
const WIDTH = Number(process.env.VERIFY_CONCURRENCY) || 6;
const results = await runAll(CHECKS, base, WIDTH);

process.exit(report(results, ciParity(true)));
