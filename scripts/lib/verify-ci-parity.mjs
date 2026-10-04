// --ci-parity: every step in ci.yml is either run by `pnpm verify` or declared as run elsewhere,
// and the post-merge jobs are named in the report rather than silently skipped.

import { existsSync, readFileSync } from 'node:fs';
import { notRunHereLines } from './not-run-here.mjs';
import {
  CI_COVERAGE,
  CI_PATH,
  COMPOSITE_PATH,
  OFF_TREE_CHECKS,
  RUN_ELSEWHERE_HINT,
} from './verify-checks.mjs';

export function ciSteps() {
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
 * Every ci.yml job `ci-passed` does not need, with the steps it runs and the platforms its matrix
 * names, and the steps only such a job runs. A step a gating job also runs is gated, whichever
 * other job shares it — but the job running it after the merge is still listed, because it runs
 * that step somewhere the gating job does not.
 */
function jobsAfterTheMerge() {
  const none = { jobs: [], onlyAfter: new Set() };
  if (!existsSync(CI_PATH)) return none;
  const text = readFileSync(CI_PATH, 'utf8');
  const needs = /ci-passed:[\s\S]*?needs:\s*\[([^\]]*)\]/.exec(text);
  if (!needs) return none;
  const gating = new Set(needs[1].split(',').map((s) => s.trim()));
  const lines = text.split('\n');
  const byJob = new Map();
  let job = null;
  for (const line of lines.slice(lines.findIndex((l) => /^jobs:\s*$/.test(l)) + 1)) {
    const head = line.match(/^ {2}([\w-]+):\s*$/);
    if (head) {
      job = head[1];
      byJob.set(job, { job, steps: [], os: [] });
    }
    if (!job || job === 'ci-passed') continue;
    const os = line.match(/^\s+os:\s*\[([^\]]*)\]\s*$/);
    if (os) byJob.get(job).os = os[1].split(',').map((s) => s.trim());
    const step = line.match(/^\s+- (?:run|name):\s+(\S.*?)\s*$/);
    if (step && step[1] !== '|') byJob.get(job).steps.push(step[1]);
  }
  byJob.delete('ci-passed');
  const all = [...byJob.values()];
  const gated = new Set(all.filter((j) => gating.has(j.job)).flatMap((j) => j.steps));
  const jobs = all.filter((j) => !gating.has(j.job));
  const onlyAfter = new Set(jobs.flatMap((j) => j.steps).filter((step) => !gated.has(step)));
  return { jobs, onlyAfter };
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
export function ciParity(quiet, said = []) {
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
  console.error(
    '\nAdd each to CI_COVERAGE in scripts/lib/verify-checks.mjs — either "verify" (this script',
  );
  console.error('runs it) or the root script that does. An undeclared step is a gate that CI');
  console.error('enforces and `pnpm verify` silently skips.\n');
  return 1;
}

/** One post-merge job as a line: its name, its platforms, and what each step is locally or in CI. */
function afterMergeLine({ job, steps, os }) {
  const what = steps.map((step) => {
    const local = CI_COVERAGE[step];
    return local && !local.startsWith('verify') ? local : step;
  });
  return `${job}${os.length > 0 ? ` (${os.join(', ')})` : ''}: ${what.join('; ')}`;
}

export function reportNotRunHere() {
  const { jobs, onlyAfter } = jobsAfterTheMerge();
  const elsewhere = Object.entries(CI_COVERAGE)
    .filter(([, where]) => !where.startsWith('verify'))
    .filter(([step]) => RUN_ELSEWHERE_HINT.some((h) => step.includes(h)));
  const lines = notRunHereLines(
    elsewhere.filter(([step]) => !onlyAfter.has(step)).map(([, where]) => where),
    jobs.map(afterMergeLine),
    OFF_TREE_CHECKS,
  );
  for (const line of lines) console.log(line);
}
