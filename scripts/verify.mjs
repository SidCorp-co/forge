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

// cm:guard every entry needs a `scanned` pattern that matches the checker's OWN success line. Without it a checker that walked an empty scope reports clean and this script forwards that as a pass.
const CHECKS = [
  {
    axis: 'language',
    label: 'source-language',
    cmd: ['node', 'scripts/check-source-language.mjs', '--all'],
    // cm:edge naming -> scripts/check-source-language.mjs — parses that script's success line; reword it there and the fail-closed count silently stops matching
    scanned: /across (\d+) files/,
  },
  // cm:guard the `scanned` count here is the number of entries the record still holds, not a file count, and that is deliberate: an emptied CHANGELOG scans zero and the fail-closed contract turns it into exit 2. The record losing every entry and the checker being unable to see the record are both things this script refuses to forward as a pass.
  {
    axis: 'record',
    label: 'release-record',
    // cm:edge naming -> scripts/check-release-record.mjs — parses that script's success line
    cmd: ['node', 'scripts/check-release-record.mjs'],
    scanned: /^release-record: (\d+) entr/m,
    unit: 'release entries',
  },
  {
    axis: 'behaviour',
    label: 'test-signal',
    cmd: ['node', 'scripts/check-test-signal.mjs', '--all'],
    // cm:edge naming -> scripts/check-test-signal.mjs — same coupling as above
    scanned: /^test-signal: (\d+) test file/m,
  },
  // cm:guard this runs BEFORE test-signal reads anything, in the order that matters conceptually: test-signal asks whether a test asserts behaviour, and a file no runner collects cannot assert anything. `packages/tests` held 64 such files for six weeks and test-signal's 493 never included one of them, because a checker scoped to what the runner sees cannot see what it does not.
  {
    axis: 'behaviour',
    label: 'test-reachability',
    // cm:edge naming -> scripts/check-test-reachability.mjs — parses that script's success line
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
    // cm:guard the skip is only legitimate because CI runs this WITH --require-sources after producing the reports, and ci-parity proves that step exists. Drop it there and this becomes a check that never runs anywhere.
    skipIf: /skipped — (no|stale) coverage report/,
  },
  // cm:guard this gate is what makes the PAT permission menu a proof rather than a habit: `PAT_PERMISSION_RESOURCES` declares reachability per-PREFIX while the property it claims is per-ROUTE, so one unfenced route under an admitted prefix is a project-scoped token reading another project with every handler around it looking correct. Measured on its first run: a text search inside the route span reported 80 of 285 routes unfenced and the three sampled were all its own false positives (a file-local `assertMember`, a service layer, two routers sharing a file) — the invariant is call-graph reachability, not a string, and a checker at 95% noise is worse than none because it teaches the reader to skip it.
  {
    // cm:guard the map is GENERATED and this gate is what keeps it that way — hand-kept, `docs/system.graph.json` sat 5 months and was missing 2 of its 9 modules (2026-09-11)
    axis: 'knowledge',
    label: 'flow-map',
    cmd: ['node', 'scripts/build-flow-map.mjs', '--check'],
    scanned: /: (\d+) flow\(s\) across/,
    unit: 'flows',
  },
  {
    axis: 'knowledge',
    label: 'pat-surface',
    // cm:edge naming -> scripts/check-pat-surface.mjs — parses that script's success line
    cmd: ['node', 'scripts/check-pat-surface.mjs'],
    scanned:
      /^pat-surface: \d+ resource\(s\) · \d+ permission group\(s\) · \d+ covered prefix\(es\) · \d+ router file\(s\) · (\d+) route/m,
    unit: 'PAT-reachable routes',
  },
  {
    axis: 'knowledge',
    label: 'injected-doc-modes',
    // cm:edge naming -> scripts/check-injected-doc-modes.mjs — parses that script's success line
    cmd: ['node', 'scripts/check-injected-doc-modes.mjs'],
    scanned: /^injected-doc-modes: (\d+) mode-specific claim/m,
    unit: 'mode-specific claims',
  },
  // cm:guard scoped to docs/VISION.md + every .md under docs/proposals/, subdirectories included, and it must stay that narrow at the TOP: the rule is that a document ASKING to be adopted prices what adoption costs, and widened to every .md in the repo it would demand a price from a module doc that proposes nothing, which earns the checker an ignore list — where the next real violation hides.
  // cm:guard this checker exists for what `tsc` cannot see: raw SQL naming `b.environment`, an
  // untyped `productionBranch` read off a `Record<string, unknown>`, an inline `"staging" | "prod"`
  // union that imports nothing, and the retired function names in prose. web-v2 held seven of those
  // unions importing nothing from contracts, so the contracts change alone broke none of them and a
  // green typecheck said the cutover was done when 49 readers were still live.
  {
    axis: 'knowledge',
    label: 'retired-model',
    // cm:edge naming -> scripts/check-retired-model.mjs — parses that script's success line
    cmd: ['node', 'scripts/check-retired-model.mjs'],
    scanned: /^check-retired-model: (\d+) files scanned/m,
    unit: 'files',
  },
  {
    axis: 'knowledge',
    label: 'honest-costs',
    // cm:edge naming -> scripts/check-honest-costs.mjs — parses that script's success line
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
    // cm:guard `observability-build` belongs here for the same reason `core typecheck` declares it: archmap resolves TypeScript module edges, so an unbuilt `@forge/observability` makes every edge through it unresolvable. Measured 2026-09-14 in a fresh worktree — 205 unresolvable against a 200 ceiling where a built tree reports 171, and conformance-audit R7 then declared the REPO does not meet `hardened`. That is a false claim about the code, which is the exact bug `lib/prerequisite.mjs` exists to stop.
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
    // cm:edge naming -> scripts/check-lint-budget.mjs — parses that script's success line
    scanned: /^lint-budget: (\d+) file/m,
    needs: ['deps'],
  },
  {
    axis: 'form',
    label: 'size-budget',
    cmd: ['node', 'scripts/check-size-budget.mjs', '--all'],
    // cm:edge naming -> scripts/check-size-budget.mjs — parses that script's success line
    scanned: /^size-budget: (\d+) file/m,
    needs: ['deps'],
  },
  // cm:guard the checkers in `scripts/` hold every other axis and were themselves held by nothing — no lint, no typecheck, because `turbo run lint` only fans out to workspace packages and this directory is in none. Measured 2026-08-25 the day it got a config: 21 diagnostics, one of them a real `useIterableCallbackReturn`. Fixed rather than frozen, so this check has no baseline and none is wanted.
  {
    axis: 'form',
    label: 'scripts lint',
    // cm:edge lockstep -> scripts/biome.json — that file is the config biome resolves for this directory; `root: false` is what stops it leaking into the package configs
    cmd: ['pnpm', 'exec', 'biome', 'check', 'scripts'],
    scanned: /^Checked (\d+) files/m,
    needs: ['deps'],
  },
  {
    axis: 'form',
    label: 'core typecheck',
    // cm:why `tsc --noEmit` alone prints NOTHING on success, so a tsconfig whose include matched no file is indistinguishable from a clean compile — --extendedDiagnostics is here only for its `Files:` count, and CI's plain `typecheck` script stays a subset of this
    cmd: ['pnpm', '--filter', '@forge/core', 'exec', 'tsc', '--noEmit', '--extendedDiagnostics'],
    scanned: /^Files:\s+(\d+)/m,
    needs: ['deps', 'observability-build'],
  },
  // cm:guard this check exists because `pnpm verify` was 13/13 green while the `runner` job in ci.yml was red: 0.7.6 shipped with an unformatted file, which failed that job AND runner-release, so no GitHub Release was cut and the install channel had nothing to serve (2026-08-18). CI_COVERAGE had declared the hole honestly the whole time — a declared hole is still a hole.
  // cm:guard this runs ONE platform and the gate runs three, so a green here is no claim about windows or macos — the `runner` job in ci.yml is the only thing that makes that claim (2026-09-09).
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
  // cm:why a Dependabot pull request rewrote `forge-plugin`'s resolution to `git@github.com:` and
  // took all six installing jobs down inside `pnpm install` with exit 128, unnamed for two days (ISS-1045)
  // cm:guard this one also runs where NO other check can — `.github/actions/setup-workspace` calls
  // it before `pnpm install`, because the entry it refuses is the one that kills that install
  // cm:guard it declares no conformance axis and adds no job to `ci-passed`, so nothing in `.forge/conformance.json` or `conformance-status.mjs` moves with it
  {
    axis: 'meta',
    label: 'lockfile-transport',
    cmd: ['node', 'scripts/check-lockfile-transport.mjs'],
    // cm:edge naming -> scripts/check-lockfile-transport.mjs — parses that script's success line
    scanned: /^lockfile-transport: (\d+) resolution\(s\), none over SSH/m,
    unit: 'resolutions',
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

// cm:guard one copy of the verdict rules — a second inside the spawn callback gets a fail-closed rule fixed on one path only, and the report cannot tell the two apart
// cm:guard `condition` and `code` are two INDEPENDENT fields and must stay so. `code` is how bad it is; `condition` is what kind of statement it is. Collapsing them is the whole defect: exit 2 already meant "could not run" while the row printed FAIL and the text asserted a rule the repo breaks, so the process status and the words a human reads disagreed about which axis they were on (ISS-938).
function verdict(check, status, out) {
  // cm:guard a child's exit 2 is that child SAYING it could not run — every checker in this repo documents 2 that way. Read it as the child's own claim about its condition, never re-judged here against its output: the checker knows why it could not run and this script does not.
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

// cm:guard preflight BEFORE the spawn, and never after. A checker run without its tool produces a message about its own subject — `biome output in packages/core was not JSON`, `archmap: scope matched no files` — which reads as a defect in the thing being measured. Once that sentence exists nothing downstream can unsay it, so the only place to catch an absent prerequisite is before the process that would misattribute it starts.
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

// cm:guard results stay in CHECKS order however the processes finish — the report reads as an ordered list of axes and `ci-parity` reads off the same array, so landing order would shuffle both
// cm:why the width is bounded rather than firing all 20: measured 2026-09-06 on 12 cores, serial 41.9s, width 4 32.6s, width 6 28.4s, width 12 28.4s — flat past 6, because tsc is itself multi-core and conformance-levels re-spawns eleven checkers
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

// cm:guard the composite is `ci.yml`'s blind spot: `ciSteps` reads the workflow and never the action
// it calls, so a step deleted from there or moved below the install costs nothing and says nothing
// cm:why the pre-install guarantee is what criterion 16 of ISS-1045 rests on, and a guarantee only one reader's memory holds is the shape `ciGateParity` already exists to refuse
// cm:edge contract -> .github/actions/setup-workspace/action.yml — the order of its `check-lockfile-transport` and `pnpm install` steps is asserted here
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
  // cm:guard `>=` and not `>`: one `run:` holding both commands gives them ONE index, so `>` reads
  // `pnpm install --frozen-lockfile && node scripts/check-lockfile-transport.mjs` as ordered
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

// cm:guard a blocked gate is NOT green. It exits 2 exactly as a fail-closed FAIL does, because an unrun gate is no evidence and this script refuses to forward no-evidence as a pass. What changes is only the sentence a reader gets — the verdict is unmoved, so nothing here is an amnesty.
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
