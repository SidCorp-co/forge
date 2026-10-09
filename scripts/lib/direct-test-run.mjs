// Running what `direct-tests.mjs` selected: the typecheck and the direct tests of a change, each
// timed and reported as one check, so the pre-push run and the merge check say the same things the
// same way (REQ-36 BC-7, BC-14). Each check is a check run as the tracker records it
// (`packages/contracts/src/check-runs.ts`): an id of its own, so a resend is the same check, its
// kind, when it started and how long it took (ISS-474).

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  fileModulesOf,
  indexTests,
  knownFiles,
  listedTestNames,
  ownedTests,
  runnerSelection,
  selectDirect,
} from './direct-tests.mjs';
import { gitOut } from './gate.mjs';

/**
 * One check a run made: what it was and of which kind, where, the command, the files it ran, how it
 * ended, when it started (epoch ms) and how long it took.
 */
export function check({ name, kind, scope, command, files, result, startedAt, durationMs, note }) {
  return {
    id: randomUUID(),
    kind,
    name,
    scope,
    command,
    files,
    result,
    durationMs,
    startedAt: new Date(startedAt).toISOString(),
    ...(note ? { note } : {}),
  };
}

/** Run one command and time it: when it started (epoch ms) and how long it took. */
export function run(argv, cwd, { capture = false, env } = {}) {
  const started = Date.now();
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 256 * 1024 * 1024,
    ...(env ? { env } : {}),
  });
  return {
    ok: r.status === 0,
    status: r.status,
    error: r.error?.message ?? null,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    startedAt: started,
    durationMs: Date.now() - started,
  };
}

const show = (argv) => argv.join(' ');

/**
 * The paths a change touched and what became of each, from git's name-status. A rename reads as its
 * old path removed and its new one added (`--no-renames`), the shape the merge mark takes.
 */
export function touchedBetween(root, from, to = null) {
  const args = ['diff', '--name-status', '--no-renames', from, ...(to ? [to] : [])];
  const out = gitOut(args, root);
  if (out === null) throw new Error(`git ${args.join(' ')} failed`);
  const changes = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split('\t');
      const change = status.startsWith('A')
        ? 'added'
        : status.startsWith('D')
          ? 'removed'
          : 'changed';
      return { path, change };
    });
  if (to === null) {
    const untracked = gitOut(['ls-files', '--others', '--exclude-standard'], root) ?? '';
    for (const path of untracked.split('\n').filter(Boolean))
      changes.push({ path, change: 'added' });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** Typecheck: tc-changed's selection against `baseRef`, and the runner when it is touched. */
export function runTypecheck(root, { baseRef, touched }) {
  const checks = [];
  const tc = ['node', 'scripts/tc-changed.mjs', '--base', baseRef];
  const r = run(tc, root);
  checks.push(
    check({
      name: 'typecheck',
      kind: 'typecheck',
      scope: 'typescript',
      command: show(tc),
      files: [],
      result: r.ok ? 'pass' : 'fail',
      startedAt: r.startedAt,
      durationMs: r.durationMs,
    }),
  );
  if (touched.some((p) => p.startsWith('packages/runner/'))) {
    const cargo = ['cargo', 'check', '--workspace', '--all-targets', '--locked'];
    const c = run(cargo, join(root, 'packages/runner'));
    checks.push(
      check({
        name: 'typecheck',
        kind: 'typecheck',
        scope: 'runner',
        command: show(cargo),
        files: [],
        result: c.ok ? 'pass' : 'fail',
        startedAt: c.startedAt,
        durationMs: c.durationMs,
      }),
    );
  }
  return checks;
}

/** The vitest runs of a selection, one per collection, under the collection's own config. */
function runVitest(root, collections, name) {
  return collections.map(({ collection, files }) => {
    const paths = files.map((f) => join(root, f.test));
    const argv = ['pnpm', 'exec', 'vitest', 'run', '--config', collection.config, ...paths];
    console.log(
      `\n${name}: ${collection.name}, ${files.length} file(s):\n${files
        .map((f) => `  ${f.test}  ← ${f.because.join(', ')}`)
        .join('\n')}`,
    );
    const r = run(argv, join(root, collection.cwd));
    return check({
      name,
      kind: 'tests',
      scope: collection.name,
      command: `(cd ${collection.cwd} && pnpm exec vitest run --config ${collection.config} <${files.length} files>)`,
      files: files.map((f) => f.test),
      result: r.ok ? 'pass' : 'fail',
      startedAt: r.startedAt,
      durationMs: r.durationMs,
    });
  });
}

/** The runner's direct tests of one crate: the touched modules' own tests and touched test targets. */
function runCrate(root, known, entry) {
  const cwd = join(root, 'packages/runner');
  const checks = [];
  const crateCheck = (fields) =>
    check({ name: 'direct-tests', kind: 'tests', scope: `runner/${entry.crate}`, ...fields });
  if (entry.modules.length) {
    const list = ['cargo', 'test', '-p', entry.crate, '--locked', '--', '--list'];
    const listed = run(list, cwd, { capture: true });
    if (!listed.ok) {
      process.stderr.write(listed.stderr);
      checks.push(
        crateCheck({
          command: show(list),
          files: [],
          result: 'fail',
          startedAt: listed.startedAt,
          durationMs: listed.durationMs,
        }),
      );
      return checks;
    }
    const names = listedTestNames(listed.stdout);
    const fileModules = fileModulesOf(known, entry.crate);
    const owned = [
      ...new Set(entry.modules.flatMap((m) => ownedTests(names, m.module, fileModules))),
    ];
    const files = entry.modules.map((m) => m.path);
    if (owned.length === 0) {
      checks.push(
        crateCheck({
          command: show(list),
          files,
          result: 'none',
          startedAt: listed.startedAt,
          durationMs: listed.durationMs,
          note: 'the touched modules hold no test of their own',
        }),
      );
    } else {
      console.log(
        `\ndirect-tests: runner/${entry.crate}, ${owned.length} test(s) of ${files.join(', ')}`,
      );
      const argv = ['cargo', 'test', '-p', entry.crate, '--locked', '--', '--exact', ...owned];
      const r = run(argv, cwd);
      checks.push(
        crateCheck({
          command: `cargo test -p ${entry.crate} --locked -- --exact <${owned.length} tests>`,
          files,
          result: r.ok ? 'pass' : 'fail',
          startedAt: listed.startedAt,
          durationMs: r.durationMs + listed.durationMs,
        }),
      );
    }
  }
  for (const t of entry.testTargets) {
    const argv = ['cargo', 'test', '-p', entry.crate, '--locked', '--test', t.target];
    const r = run(argv, cwd);
    checks.push(
      crateCheck({
        command: show(argv),
        files: [t.path],
        result: r.ok ? 'pass' : 'fail',
        startedAt: r.startedAt,
        durationMs: r.durationMs,
      }),
    );
  }
  return checks;
}

/** A check whose selection held nothing to run: it says so, at no time. */
const nothingToRun = (name, scope, note) =>
  check({
    name,
    kind: 'tests',
    scope,
    command: '',
    files: [],
    result: 'none',
    startedAt: Date.now(),
    durationMs: 0,
    note,
  });

/**
 * Select and run the direct tests of `touched` (every package) and, when `integration` is set, the
 * core integration tests the same rule selects. Answers the checks made and the touched code no test
 * reaches; a collection nothing selected makes no run, and says so.
 */
export function runDirectTests(root, { touched, integration }) {
  const live = touched.filter((t) => t.change !== 'removed').map((t) => t.path);
  const known = knownFiles(root);
  const tests = indexTests(root, known);
  const { collections, untested } = selectDirect(live, tests);
  const unit = collections.filter((c) => !c.collection.integration);
  const integ = collections.filter((c) => c.collection.integration);
  const checks = runVitest(root, unit, 'direct-tests');
  const crates = runnerSelection(live);
  for (const entry of crates) checks.push(...runCrate(root, known, entry));
  if (!checks.length) {
    checks.push(
      nothingToRun('direct-tests', 'workspace', 'no test file is direct for any touched file'),
    );
  }
  if (integration) {
    const ran = runVitest(root, integ, 'integration-tests');
    checks.push(
      ...(ran.length
        ? ran
        : [
            nothingToRun(
              'integration-tests',
              '@forge/core integration',
              'no integration test is direct for any touched file',
            ),
          ]),
    );
  }
  return {
    checks,
    untested: [...untested, ...crates.flatMap((c) => c.untested)],
    integrationSelected: integ.flatMap((c) => c.files.map((f) => f.test)),
  };
}

/** The lines a run prints about what it ran and how long each took. */
export function describeChecks(checks) {
  return checks.map(
    (c) =>
      `  ${c.result.padEnd(4)}  ${c.name.padEnd(17)} ${c.scope.padEnd(26)} ${(c.durationMs / 1000).toFixed(1).padStart(6)}s  ${c.files.length ? `${c.files.length} file(s)` : ''}${c.note ? ` — ${c.note}` : ''}`,
  );
}
