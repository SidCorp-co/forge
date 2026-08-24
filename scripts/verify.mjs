#!/usr/bin/env node
// Conformance entrypoint — the one command to run after coding, before pushing.
//
// The mechanism is this script, not the hooks. Claude Code hooks need a plugin
// installed and git hooks need `pnpm install` plus no SKIP_* in the env, so
// neither can be what correctness depends on. Everything reachable from here
// works with a bare checkout and a node binary.
//
// Four contracts, ordered by what breaks without them:
//   1. CI parity — every step in ci.yml is run here or explicitly declared as
//      covered by another root script. `--ci-parity` proves it.
//   2. Fail-closed — a checker that scanned zero files exits 2, never 0. A
//      green report from a check that never ran is worse than no check at all.
//   3. Report everything — no early exit, so one fix cycle instead of six.
//   4. Advisory — `cm impact` on changed files: the pull-side replacement for
//      the PreToolUse hook that used to push guards into an agent's context.
//
// Modes: (none) full run · --ci-parity only the parity proof · --no-advisory
// Exit: 0 clean · 1 violations · 2 a check could not run.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CI_PATH = join(ROOT, '.github', 'workflows', 'ci.yml');

// cm:guard every entry needs a `scanned` pattern that matches the checker's OWN success line. Without it a checker that walked an empty scope reports clean and this script forwards that as a pass — the exact fail-open shape codemap's own CLI documents as the only bug class it has ever shipped.
const CHECKS = [
  {
    axis: 'language',
    label: 'source-language',
    cmd: ['node', 'scripts/check-source-language.mjs', '--all'],
    // cm:edge naming -> scripts/check-source-language.mjs — parses that script's success line; reword it there and the fail-closed count silently stops matching
    scanned: /across (\d+) files/,
  },
  {
    axis: 'behaviour',
    label: 'test-signal',
    cmd: ['node', 'scripts/check-test-signal.mjs', '--all'],
    // cm:edge naming -> scripts/check-test-signal.mjs — same coupling as above
    scanned: /^test-signal: (\d+) test file/m,
  },
  {
    axis: 'behaviour',
    label: 'flow-coverage',
    cmd: ['node', 'scripts/check-flow-coverage.mjs', '--all'],
    scanned: /: (\d+) step\(s\) across/,
    unit: 'flow steps',
    // cm:guard the skip is only legitimate because CI runs this WITH --require-sources after producing the reports, and ci-parity proves that step exists. Drop it there and this becomes a check that never runs anywhere.
    skipIf: /skipped — no coverage report/,
  },
  {
    // cm:guard WHOLE TREE, never `--since`. A scoped run walks the diff against origin/main, and for a commit pushed straight to `main` that diff is EMPTY — cm prints its success line over zero files and this script forwards a green. 15 CM001 errors reached main that way before anyone looked. Legacy prose is frozen by content in the baseline, so a whole-tree run costs nothing and has no blind spot; if it ever goes red on untouched files, the baseline is stale, not the rule.
    // cm:guard this comment sits ABOVE `label:` on purpose — conformance-audit R2 proves a check declares a `scanned:` pattern by looking at most 400 characters past its label, so prose wedged between the two reads as a check with no scan proof and fails the audit.
    axis: 'knowledge',
    label: 'codemap prose',
    cmd: ['.forge/codemap/cm', 'verify'],
    scanned: /"files":\s*(\d+)/,
    json: true,
  },
  {
    axis: 'knowledge',
    label: 'codemap referential',
    cmd: ['.forge/codemap/cm', 'verify', '--tier', 'referential'],
    scanned: /"files":\s*(\d+)/,
    json: true,
  },
  {
    axis: 'knowledge',
    label: 'codemap structural',
    cmd: ['.forge/codemap/cm', 'verify', '--tier', 'structural'],
    scanned: /"files":\s*(\d+)/,
    json: true,
  },
  {
    axis: 'relations',
    label: 'archmap',
    cmd: ['./.forge/archmap/archmap', 'check'],
    scanned: /archmap · (\d+) files/,
  },
  {
    axis: 'form',
    label: 'core lint',
    cmd: ['pnpm', '--filter', '@forge/core', 'lint'],
    scanned: /Checked (\d+)/,
  },
  {
    axis: 'form',
    label: 'lint-budget',
    cmd: ['node', 'scripts/check-lint-budget.mjs', '--all'],
    // cm:edge naming -> scripts/check-lint-budget.mjs — parses that script's success line
    scanned: /^lint-budget: (\d+) file/m,
  },
  {
    axis: 'form',
    label: 'size-budget',
    cmd: ['node', 'scripts/check-size-budget.mjs', '--all'],
    // cm:edge naming -> scripts/check-size-budget.mjs — parses that script's success line
    scanned: /^size-budget: (\d+) file/m,
  },
  // cm:guard the checkers in `scripts/` hold every other axis and were themselves held by nothing — no lint, no typecheck, because `turbo run lint` only fans out to workspace packages and this directory is in none. Measured 2026-08-25 the day it got a config: 21 diagnostics, one of them a real `useIterableCallbackReturn`. Fixed rather than frozen, so this check has no baseline and none is wanted.
  {
    axis: 'form',
    label: 'scripts lint',
    // cm:edge lockstep -> scripts/biome.json — that file is the config biome resolves for this directory; `root: false` is what stops it leaking into the package configs
    cmd: ['pnpm', 'exec', 'biome', 'check', 'scripts'],
    scanned: /^Checked (\d+) files/m,
  },
  {
    axis: 'form',
    label: 'core typecheck',
    // cm:why `tsc --noEmit` alone prints NOTHING on success, so a tsconfig whose include matched no file is indistinguishable from a clean compile — --extendedDiagnostics is here only for its `Files:` count, and CI's plain `typecheck` script stays a subset of this
    cmd: ['pnpm', '--filter', '@forge/core', 'exec', 'tsc', '--noEmit', '--extendedDiagnostics'],
    scanned: /^Files:\s+(\d+)/m,
  },
  // cm:guard this check exists because `pnpm verify` was 13/13 green while the `runner` job in ci.yml was red: 0.7.6 shipped with an unformatted file, which failed runner-ci AND runner-release, so no GitHub Release was cut and the install channel had nothing to serve (2026-08-18). CI_COVERAGE had declared the hole honestly the whole time — a declared hole is still a hole.
  // cm:edge lockstep -> scripts/check-runner-gates.mjs — that script runs the four cargo commands; its own edge points back at the ci.yml step they mirror
  {
    axis: 'runner',
    label: 'cargo gates',
    cmd: ['node', 'scripts/check-runner-gates.mjs'],
    // cm:edge naming -> scripts/check-runner-gates.mjs — parses that script's success line
    scanned: /^runner-gates: (\d+) crate file\(s\) in scope/m,
    unit: 'crate files',
    scopeMayBeEmpty: true,
    skipIf: /skipped — cargo not available/,
  },
  {
    axis: 'meta',
    label: 'conformance levels',
    cmd: ['node', 'scripts/conformance-status.mjs'],
    // cm:edge naming -> scripts/conformance-status.mjs — parses that script's success line
    scanned: /^conformance-status: (\d+) axes measured/m,
    unit: 'axes',
  },
  {
    axis: 'meta',
    label: 'conformance audit',
    cmd: ['node', 'scripts/conformance-audit.mjs'],
    // cm:edge naming -> scripts/conformance-audit.mjs — parses that script's success line
    scanned: /^conformance-audit: (\d+) rules evaluated/m,
    unit: 'rules',
  },
];

// cm:edge contract -> .github/workflows/ci.yml — every `- run:` line and every named step there must appear as a key here; `--ci-parity` fails on an unlisted one. Adding a CI step without a line here is the drift this map exists to catch.
const CI_COVERAGE = {
  'node scripts/check-source-language.mjs --all': 'verify',
  'node scripts/check-test-signal.mjs --all': 'verify',
  'node scripts/check-size-budget.mjs --all': 'verify',
  'node scripts/conformance-status.mjs': 'verify',
  'node scripts/conformance-audit.mjs': 'verify',
  'node scripts/verify.mjs --ci-parity': 'verify, as its own final check',
  '.forge/codemap/cm verify': 'verify',
  '.forge/codemap/cm verify --tier referential': 'verify',
  '.forge/codemap/cm verify --tier structural': 'verify',
  './.forge/archmap/archmap check': 'verify',
  'pnpm exec biome check scripts': 'verify',
  'pnpm --filter @forge/core lint': 'verify',
  'pnpm --filter @forge/core typecheck': 'verify',
  'pnpm --filter web-v2 lint': 'verify, as the lint-budget check',
  'pnpm --filter web-v2 exec vitest run --passWithNoTests': 'pnpm test',
  'pnpm --filter web-v2 build': 'pnpm build',
  'pnpm --filter @forge/core test': 'pnpm test',
  'pnpm --filter @forge/core build': 'pnpm build',
  'TEST_DB_MODE=container pnpm --filter @forge/core test:integration:coverage':
    'pnpm --filter @forge/core test:integration',
  'node scripts/check-flow-coverage.mjs --all --require-sources': 'verify, minus --require-sources',
  'Lockfile sync + fmt + clippy + test (same gates as runner-ci)':
    'verify, via scripts/check-runner-gates.mjs when packages/runner changed',
  'Check Markdown links': 'docs job, lychee action',
  'Require every CI job to have passed or been skipped': 'the ci-passed gate itself',
};

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function mergeBase() {
  return git(['merge-base', 'origin/main', 'HEAD']);
}

// cm:guard the guard above is only a rule while THIS function refuses the entry that breaks it — two entries sat here for a day with no `scanned`, and nothing said so because the rule lived in a comment. A prose invariant with no code behind it is a wish.
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

function runCheck(check, base) {
  const cmd = check.cmd.map((a) => (a === '@@MERGE_BASE@@' ? base : a));
  if (cmd.includes('@@MERGE_BASE@@') || (check.scopeMayBeEmpty && base === null)) {
    return { ...check, code: 2, why: 'origin/main not available — cannot scope the diff' };
  }
  const argv = check.json ? [...cmd, '--json'] : cmd;
  const r = spawnSync(argv[0], argv.slice(1), { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

  if (r.error) return { ...check, code: 2, out, why: `could not spawn: ${r.error.message}` };
  if (r.status === 2) return { ...check, code: 2, out, why: 'checker reported it could not run' };

  if (check.skipIf?.test(out)) {
    return {
      ...check,
      code: r.status ?? 0,
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
    return { ...check, code: r.status ?? 1, out, files: n, note };
  }
  return { ...check, code: r.status ?? 1, out };
}

function advisory(base) {
  if (!base) return null;
  const changed = git(['diff', '--name-only', base, 'HEAD']);
  const staged = git(['diff', '--name-only', '--cached']);
  const dirty = git(['diff', '--name-only']);
  // cm:why untracked is not optional here — a brand-new file is exactly the case with no LSP history and the highest chance of walking into a guard nobody told the author about
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  const files = [
    ...new Set([changed, staged, dirty, untracked].filter(Boolean).join('\n').split('\n')),
  ].filter((f) => f && existsSync(join(ROOT, f)));
  if (files.length === 0) return null;

  const hits = [];
  for (const f of files.slice(0, 40)) {
    const r = spawnSync('.forge/codemap/cm', ['impact', f, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (r.status !== 0 || !r.stdout) continue;
    try {
      // cm:edge contract -> .forge/codemap/cm — these five key names are `cm impact --json`'s output shape; a rename there turns this advisory silently empty, which reads as "no couplings" rather than as a break
      const d = JSON.parse(r.stdout);
      const rows = [
        ...(d.guards ?? []).map((x) => ['guard', x.text ?? x.raw]),
        ...(d.hacks ?? []).map((x) => ['hack ', x.text ?? x.raw]),
        ...(d.outgoing ?? []).map((x) => ['edge ', `${x.kind} -> ${x.target} — ${x.text ?? ''}`]),
        ...(d.incoming ?? []).map((x) => ['edge←', `${x.kind} from ${x.file} — ${x.text ?? ''}`]),
        ...(d.flows ?? []).flatMap((f) =>
          (f.steps ?? []).map((s) => [
            'flow ',
            `${f.name}/${s.step}${s.after ? ` after:${s.after}` : ''} — ${s.text ?? ''}`,
          ]),
        ),
      ];
      if (rows.length) hits.push({ file: f, rows });
    } catch {}
  }
  return hits.length ? hits : null;
}

// cm:edge naming -> scripts/check-lockstep.mjs — reads that script's --json shape; it ships advisory on purpose, so a non-zero exit here must NOT reach the summary or a rename would silently start failing verify
function lockstepDrift(base) {
  if (!base) return null;
  const r = spawnSync('node', ['scripts/check-lockstep.mjs', '--json', '--since', base], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const body = r.stdout.slice(r.stdout.indexOf('{'));
    const pairs = JSON.parse(body).oneSided ?? [];
    return pairs.length ? pairs : null;
  } catch {
    return null;
  }
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

// cm:guard `ci-passed` runs `if: always()`, so a job in its `needs` that the assertion loop never names CANNOT block a merge — listing a job is not gating it, only the loop gates. Measured 2026-08-13: archmap sat in `needs` and out of the loop while CLAUDE.md called it the relations gate.
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

// cm:guard print on a CLEAN run too, never only on failure — a green `verify` silent about what it skipped reads as a green BUILD, and on 2026-08-14 that shipped six red integration tests inside a report that said "verified"
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

// cm:guard keep to gates a local run can actually reproduce — a step needing a CI-only secret prints advice nobody can take, and unusable advice is how the usable lines stop being read
const RUN_ELSEWHERE_HINT = ['test:integration', 'web-v2', '@forge/core test', '@forge/core build'];

function report(results, adv, parity) {
  const width = Math.max(...results.map((r) => r.label.length), 18);
  console.log('');
  for (const r of results) {
    const mark = r.code === 0 ? 'ok  ' : r.code === 2 ? 'FAIL' : 'red ';
    const files = r.files === undefined ? '' : `${r.files} ${r.unit ?? 'files'}`;
    const aside = r.why ?? r.note;
    console.log(
      `  ${mark}  ${r.axis.padEnd(10)} ${r.label.padEnd(width)}  ${files}${aside ? `  ${aside}` : ''}`,
    );
  }
  console.log(`  ${parity === 0 ? 'ok  ' : 'FAIL'}  ${'meta'.padEnd(10)} ci-parity`);
  reportNotRunHere();

  const failed = results.filter((r) => r.code !== 0);
  for (const r of failed) {
    console.error(`\n${'─'.repeat(72)}\n${r.axis} · ${r.label}\n`);
    console.error((r.out ?? '').trimEnd());
  }

  if (adv) {
    console.log(
      `\n${'─'.repeat(72)}\nDeclared couplings on files you changed — read before pushing:\n`,
    );
    for (const h of adv) {
      console.log(`  ${h.file}`);
      for (const [tag, text] of h.rows) console.log(`    ${tag}  ${text}`);
    }
  }

  if (drift) {
    console.log(
      `\n${'─'.repeat(72)}\n${drift.length} declared lockstep pair(s) where only one half moved:\n`,
    );
    for (const p of drift) {
      console.log(`  changed   ${p.moved}`);
      console.log(`  untouched ${p.still}`);
      if (p.why) console.log(`            ${p.why}`);
      console.log('');
    }
    console.log(
      '\n  Advice, not a verdict — a rename moves one side alone. Make the matching\n' +
        '  change, or delete the cm:edge if the pair no longer holds.',
    );
  }

  // cm:guard the lockstep drift above is ADVISORY and must stay out of this reduction — a `cm:edge lockstep` means "the other side likely needs this too", and blocking a rename on it teaches people to route around verify, which costs more than the check earns
  const codes = [...results.map((r) => r.code), parity];
  if (codes.includes(2)) return 2;
  return codes.some((c) => c !== 0) ? 1 : 0;
}

const args = process.argv.slice(2);
const bad = args.filter((a) => !['--ci-parity', '--no-advisory'].includes(a));
if (bad.length) {
  console.error(`usage: verify.mjs [--ci-parity] [--no-advisory]\nunknown: ${bad.join(' ')}`);
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
const tty = process.stdout.isTTY;
const results = [];
for (const check of CHECKS) {
  if (tty) process.stdout.write(`  … ${check.label}${' '.repeat(24)}\r`);
  results.push(runCheck(check, base));
}
if (tty) process.stdout.write(`${' '.repeat(48)}\r`);

const adv = args.includes('--no-advisory') ? null : advisory(base);
const drift = args.includes('--no-advisory') ? null : lockstepDrift(base);
process.exit(report(results, adv, ciParity(true)));
