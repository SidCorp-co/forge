#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseRef } from './lib/base-branch.mjs';
import { notRunHereLines } from './lib/not-run-here.mjs';
import { absentPrerequisites, blockedAside, remedyLines } from './lib/prerequisite.mjs';
import { checksFor, entryEligibility, MODES, unlayered } from './lib/verify-layers.mjs';
import { markFor, tally, tallyLine } from './lib/verify-report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CI_PATH = join(ROOT, '.github', 'workflows', 'ci.yml');
const COMPOSITE_PATH = join(ROOT, '.github', 'actions', 'setup-workspace', 'action.yml');

const CHECKS = [
  {
    axis: 'language',
    label: 'source-language',
    layer: 'entry',
    reads: "each source file's own strings, judged file by file",
    cmd: ['node', 'scripts/check-source-language.mjs', '--all'],
    scanned: /across (\d+) files/,
  },
  {
    axis: 'record',
    label: 'release-record',
    layer: 'entry',
    reads: 'CHANGELOG.md against its base revision, one fixed file',
    cmd: ['node', 'scripts/check-release-record.mjs'],
    scanned: /^release-record: (\d+) entr/m,
    unit: 'release entries',
  },
  {
    axis: 'behaviour',
    label: 'test-signal',
    layer: 'entry',
    reads: "each test file's own assertions, judged file by file",
    cmd: ['node', 'scripts/check-test-signal.mjs', '--all'],
    scanned: /^test-signal: (\d+) test file/m,
  },
  {
    axis: 'behaviour',
    label: 'test-reachability',
    layer: 'shared',
    reads: "every tracked test file against every runner's include globs",
    cmd: ['node', 'scripts/check-test-reachability.mjs'],
    scanned: /^test-reachability: (\d+) tracked test file/m,
    needs: ['deps'],
    unit: 'test files',
  },
  {
    axis: 'behaviour',
    label: 'whole-tree-gates',
    layer: 'shared',
    reads: 'every test file for whole-tree declarations, across packages',
    cmd: ['node', 'scripts/check-whole-tree-gates.mjs'],
    scanned: /^whole-tree-gates: (\d+) test file\(s\) read/m,
    unit: 'test files',
  },
  {
    axis: 'behaviour',
    label: 'flow-coverage',
    layer: 'shared',
    reads: "every cm:flow step against the integration suite's coverage report",
    cmd: ['node', 'scripts/check-flow-coverage.mjs', '--all'],
    scanned: /: (\d+) step\(s\) across/,
    unit: 'flow steps',
    skipIf: /skipped — (no|stale) coverage report/,
    coveredBy: 'node scripts/check-flow-coverage.mjs --all --require-sources',
  },
  {
    axis: 'knowledge',
    label: 'pat-surface',
    layer: 'shared',
    reads: 'every router file against the PAT permission groups',
    cmd: ['node', 'scripts/check-pat-surface.mjs'],
    scanned:
      /^pat-surface: \d+ resource\(s\) · \d+ permission group\(s\) · \d+ covered prefix\(es\) · \d+ router file\(s\) · (\d+) route/m,
    unit: 'PAT-reachable routes',
  },
  {
    axis: 'knowledge',
    label: 'injected-doc-modes',
    layer: 'shared',
    reads: "injected documents' mode claims against the code they describe",
    cmd: ['node', 'scripts/check-injected-doc-modes.mjs'],
    scanned: /^injected-doc-modes: (\d+) mode-specific claim/m,
    unit: 'mode-specific claims',
  },
  {
    axis: 'knowledge',
    label: 'retired-model',
    layer: 'entry',
    reads: "each file's own model literals, judged file by file",
    cmd: ['node', 'scripts/check-retired-model.mjs'],
    scanned: /^check-retired-model: (\d+) files scanned/m,
    unit: 'files',
  },
  {
    axis: 'knowledge',
    label: 'status-tuples',
    layer: 'shared',
    reads:
      'status vocabularies across three packages; a subset reports clean on a tree that is not',
    cmd: ['node', 'scripts/check-status-tuples.mjs', '--all'],
    scanned: /^status-tuples: (\d+) file\(s\) scanned/m,
    unit: 'files',
  },
  {
    axis: 'knowledge',
    label: 'doc-citations',
    layer: 'shared',
    reads: "every document's citations against the files and symbols they name",
    cmd: ['node', 'scripts/check-doc-citations.mjs', '--all'],
    scanned: /^doc-citations: (\d+) document\(s\) scanned/m,
    carries: /^doc-citations worklist: (.+)$/m,
    unit: 'documents',
  },
  {
    axis: 'knowledge',
    label: 'honest-costs',
    layer: 'entry',
    reads: "each proposal document's own costs table, judged document by document",
    cmd: ['node', 'scripts/check-honest-costs.mjs'],
    scanned: /^honest-costs: (\d+) document/m,
    unit: 'documents',
  },
  {
    axis: 'relations',
    label: 'archmap',
    layer: 'shared',
    reads: 'the whole import graph against the declared architecture',
    cmd: ['./.forge/archmap/archmap', 'check'],
    exclusive: 'archmap',
    scanned: /archmap · (\d+) files/,
    needs: ['deps', 'archmap-resolver', 'observability-build', 'contracts-build'],
  },
  {
    axis: 'form',
    label: 'core lint',
    layer: 'entry',
    reads: "each file in packages/core by biome's per-file rules",
    cmd: ['pnpm', '--filter', '@forge/core', 'lint'],
    scanned: /Checked (\d+)/,
    needs: ['deps'],
  },
  {
    axis: 'form',
    label: 'lint-budget',
    layer: 'entry',
    reads: "each file's lint findings against its own frozen baseline entry",
    cmd: ['node', 'scripts/check-lint-budget.mjs', '--all'],
    scanned: /^lint-budget: (\d+) file/m,
    needs: ['deps'],
  },
  {
    axis: 'form',
    label: 'size-budget',
    layer: 'entry',
    reads: "each file's and function's length against its own frozen baseline entry",
    cmd: ['node', 'scripts/check-size-budget.mjs', '--all'],
    scanned: /^size-budget: (\d+) file/m,
    needs: ['deps'],
  },
  {
    axis: 'form',
    label: 'provider-literals',
    layer: 'entry',
    reads: "each file's own provider literals, judged file by file",
    cmd: ['node', 'scripts/check-provider-literals.mjs', '--all'],
    scanned: /^provider-literals: (\d+) file\(s\) scanned/m,
    unit: 'files',
  },
  {
    axis: 'form',
    label: 'integration-declarations',
    layer: 'shared',
    reads: 'every provider declaration against every module that implements one',
    cmd: ['node', 'scripts/check-integration-declarations.mjs', '--all'],
    scanned: /^integration-declarations: (\d+) provider\(s\) declared/m,
    needs: ['deps'],
    unit: 'providers',
  },
  {
    axis: 'relations',
    label: 'merged-at-writers',
    layer: 'shared',
    reads:
      'every writer of merged_at across the tree; a subset reports clean on a tree that is not',
    cmd: ['node', 'scripts/check-merged-at-writers.mjs', '--all'],
    scanned: /^merged-at-writers: (\d+) file\(s\) scanned/m,
  },
  {
    axis: 'form',
    label: 'lazy-module-init',
    layer: 'shared',
    reads: 'module initialisation across the import graph; the property is repo-wide',
    cmd: ['node', 'scripts/check-lazy-module-init.mjs', '--all'],
    scanned: /^lazy-module-init: (\d+) file\(s\) scanned/m,
    needs: ['deps'],
  },
  {
    axis: 'form',
    label: 'scripts lint',
    layer: 'entry',
    reads: "each file in scripts/ by biome's per-file rules",
    cmd: ['pnpm', 'exec', 'biome', 'check', 'scripts'],
    scanned: /^Checked (\d+) files/m,
    needs: ['deps'],
  },
  {
    axis: 'form',
    label: 'core typecheck',
    layer: 'shared',
    reads: 'the whole packages/core program, every file typed against every other',
    cmd: ['pnpm', '--filter', '@forge/core', 'exec', 'tsc', '--noEmit', '--extendedDiagnostics'],
    scanned: /^Files:\s+(\d+)/m,
    needs: ['deps', 'observability-build', 'contracts-build'],
  },
  {
    axis: 'runner',
    label: 'cargo gates',
    layer: 'entry',
    reads: 'the runner crates, and only when this change touched packages/runner',
    cmd: ['node', 'scripts/check-runner-gates.mjs'],
    scanned: /^runner-gates: (\d+) crate file\(s\) in scope/m,
    unit: 'crate files',
    scopeMayBeEmpty: true,
  },
  {
    axis: 'comment',
    label: 'comment-budget',
    layer: 'entry',
    reads: "each file's comment findings against its own frozen baseline entry",
    cmd: ['node', 'scripts/check-comment-budget.mjs', '--all'],
    scanned: /^comment-budget: (\d+) file\(s\) scanned/m,
    scoped: {
      cmd: ['node', 'scripts/check-comment-budget.mjs', '--changed'],
      scopeMayBeEmpty: true,
    },
    needs: ['deps'],
  },
  {
    axis: 'meta',
    label: 'lockfile-transport',
    layer: 'entry',
    reads: 'pnpm-lock.yaml, one fixed file',
    cmd: ['node', 'scripts/check-lockfile-transport.mjs'],
    scanned: /^lockfile-transport: (\d+) resolution\(s\), none over SSH/m,
    unit: 'resolutions',
  },
  {
    axis: 'meta',
    label: 'migration-order',
    layer: 'shared',
    reads: "every open branch's migration journal; the subject is the set, not this branch",
    cmd: ['node', 'scripts/check-migration-order.mjs'],
    scanned: /^migration-order: (\d+) migration\(s\) landing/m,
    unit: 'migrations landing',
    // 0 is the ordinary reading: most trees land no migration, and the checker says so rather
    // than reading a set it has nothing to compare against.
    scopeMayBeEmpty: true,
  },
  {
    axis: 'meta',
    label: 'conformance levels',
    layer: 'shared',
    reads: "every axis's gates and baselines against origin/main",
    cmd: ['node', 'scripts/conformance-status.mjs'],
    scanned: /^conformance-status: (\d+) axes measured/m,
    unit: 'axes',
  },
  {
    axis: 'meta',
    label: 'conformance audit',
    layer: 'shared',
    reads: 'every conformance rule across the whole tree',
    cmd: ['node', 'scripts/conformance-audit.mjs'],
    exclusive: 'archmap',
    scanned: /^conformance-audit: (\d+) rules evaluated/m,
    unit: 'rules',
  },
];

/** The parity proof every mode runs last; its layer and its scan proof are declared like any check's. */
const CI_PARITY = {
  label: 'ci-parity',
  layer: 'entry',
  reads: 'ci.yml and the setup-workspace composite, two fixed files',
  scanned: /^ci-parity: (\d+) CI step\(s\) declared/m,
  unit: 'CI steps',
};

const CI_COVERAGE = {
  'node scripts/check-honest-costs.mjs': 'verify',
  'node scripts/check-status-tuples.mjs --all': 'verify',
  'node scripts/check-doc-citations.mjs --all': 'verify',
  'node scripts/check-release-record.mjs': 'verify',
  'node scripts/check-injected-doc-modes.mjs': 'verify',
  'node scripts/check-retired-model.mjs': 'verify',
  'node scripts/check-pat-surface.mjs': 'verify',
  'node scripts/check-source-language.mjs --all': 'verify',
  'node scripts/check-test-signal.mjs --all': 'verify',
  'node scripts/check-size-budget.mjs --all': 'verify',
  'node scripts/check-lint-budget.mjs --all': 'verify',
  'node scripts/check-provider-literals.mjs --all': 'verify',
  'node scripts/check-integration-declarations.mjs --all': 'verify',
  'node scripts/check-lazy-module-init.mjs --all': 'verify',
  'node scripts/check-merged-at-writers.mjs --all': 'verify',
  'node scripts/check-comment-budget.mjs --all': 'verify',
  'node scripts/check-migration-order.mjs': 'verify',
  'node scripts/conformance-status.mjs': 'verify',
  'node scripts/conformance-audit.mjs': 'verify',
  'node scripts/verify.mjs --ci-parity': 'verify, as its own final check',
  'node scripts/check-archmap-ready.mjs':
    'verify, as the `archmap-resolver` prerequisite the archmap check declares in `needs`',
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
    'verify, via scripts/check-runner-gates.mjs when packages/runner changed — on THIS box only, while CI runs the same step on ubuntu before the merge and on macOS and Windows after it',
  'node scripts/check-whole-tree-gates.mjs --run':
    'verify, the declarations half; pnpm test runs the declared files themselves',
  'node scripts/build-images.mjs':
    'pnpm images, which verify does NOT run — it needs a docker daemon',
  'Check Markdown links': 'docs job, gaurav-nelson/github-action-markdown-link-check',
  'Whether a pull_request run already proved this exact tree':
    "nothing local — it reads the event and the commit's parent count, which exist only on CI",
  'Require every CI job to have passed or been skipped': 'the ci-passed gate itself',
};

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

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

/**
 * The ci.yml steps only a job `ci-passed` does not need runs — the ones CI measures after the
 * merge. A step a gating job also runs is gated, whichever other job shares it.
 */
function stepsAfterTheMerge() {
  if (!existsSync(CI_PATH)) return new Set();
  const text = readFileSync(CI_PATH, 'utf8');
  const needs = /ci-passed:[\s\S]*?needs:\s*\[([^\]]*)\]/.exec(text);
  if (!needs) return new Set();
  const gating = new Set(needs[1].split(',').map((s) => s.trim()));
  const lines = text.split('\n');
  const gated = new Set();
  const after = new Set();
  let job = null;
  for (const line of lines.slice(lines.findIndex((l) => /^jobs:\s*$/.test(l)) + 1)) {
    const head = line.match(/^ {2}([\w-]+):\s*$/);
    if (head) job = head[1];
    const step = line.match(/^\s+- (?:run|name):\s+(\S.*?)\s*$/);
    if (!job || job === 'ci-passed' || !step || step[1] === '|') continue;
    (gating.has(job) ? gated : after).add(step[1]);
  }
  return new Set([...after].filter((step) => !gated.has(step)));
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

/** `said` collects the success line, which the report reads the step count from. */
function ciParity(quiet, said = []) {
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
    said.push(`ci-parity: ${steps.length} CI step(s) declared, ${gate.count} gate job(s) asserted`);
    if (!quiet) console.log(said.at(-1));
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
  const after = stepsAfterTheMerge();
  const elsewhere = Object.entries(CI_COVERAGE)
    .filter(([, where]) => !where.startsWith('verify'))
    .filter(([step]) => RUN_ELSEWHERE_HINT.some((h) => step.includes(h)));
  const lines = notRunHereLines(
    elsewhere.filter(([step]) => !after.has(step)).map(([, where]) => where),
    elsewhere.filter(([step]) => after.has(step)).map(([, where]) => where),
    OFF_TREE_CHECKS,
  );
  for (const line of lines) console.log(line);
}

/**
 * Checks that gate a merge and have no step in `ci.yml` for `--ci-parity` to find.
 *
 * CodeQL runs from GitHub's default setup, so nothing in this tree declares it and nothing here can
 * run it. It went unnamed until an alert on a test helper held a PR whose own `ci-passed` was green
 * (ISS-1153). Named here rather than measured, because naming it is the whole of what this checkout
 * can do about it.
 */
const OFF_TREE_CHECKS = [
  'CodeQL — no workflow file here and not runnable locally; read its alerts on the PR',
];

const RUN_ELSEWHERE_HINT = [
  'test:integration',
  'web-v2',
  '@forge/core test',
  '@forge/core build',
  'build-images',
];

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
