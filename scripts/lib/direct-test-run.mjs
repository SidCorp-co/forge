// Running what `direct-tests.mjs` selected: the typecheck and the direct tests of a change, each
// timed and reported as one check, so the pre-push run and the merge check say the same things the
// same way (REQ-36 BC-7, BC-14). Each check is a check run as the tracker records it
// (`packages/contracts/src/check-runs.ts`): an id of its own, so a resend is the same check, its
// kind, when it started and how long it took (ISS-474).

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FRAGMENT_DIR } from './changelog-fragments.mjs';
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
import { buildsOwed, packageDirs, rebuildPackages } from './package-builds.mjs';
import { absentPrerequisites, remedyLines } from './prerequisite.mjs';
import { CHECKS } from './verify-checks.mjs';

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

/** verify's archmap check: the one invocation and the prerequisites both run (`verify-checks.mjs:CHECKS`). */
const ARCHMAP = CHECKS.find((c) => c.label === 'archmap');
/** A touched path that can move a verdict anywhere in the tree: the manifest, its baseline and resolution map, archmap itself. */
const ARCHMAP_WHOLE =
  /^(?:\.arch\.json|\.arch\.baseline\.json|\.arch-tsconfig\.json|\.forge\/archmap\/.*)$/;
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * What archmap checks for a change: the whole tree where its manifest or archmap itself is touched,
 * otherwise each touched code file still on disk, whose own imports are where a new edge is written.
 * `null` where the change touched neither.
 */
export function archmapScope(touched) {
  if (touched.some((t) => ARCHMAP_WHOLE.test(t.path))) return { whole: true, paths: [] };
  const paths = touched
    .filter((t) => t.change !== 'removed' && CODE.test(t.path))
    .map((t) => t.path);
  return paths.length ? { whole: false, paths } : null;
}

/**
 * The architecture contracts over what a change touched (`.arch.json`), with verify's own archmap
 * command, so a builder sees a contract it broke before the landing's `pnpm verify` does. A
 * checkout archmap cannot run in is refused by name, never passed.
 */
export function runArchmap(root, touched, { exec = run } = {}) {
  const scope = archmapScope(touched);
  if (!scope) return { checks: [], refusal: null };
  const missing = absentPrerequisites(root, ARCHMAP.needs);
  if (missing.length) {
    return {
      checks: [],
      refusal: `archmap cannot run in this checkout, so the architecture contracts were not checked:\n${remedyLines(missing).join('\n')}`,
    };
  }
  const argv = [...ARCHMAP.cmd, ...scope.paths];
  const r = exec(argv, root);
  return {
    checks: [
      check({
        name: 'archmap',
        kind: 'conformance',
        scope: scope.whole ? 'relations, whole tree' : 'relations',
        // the paths are in `files`; the command names their count, as a vitest run's does, so a
        // wide change stays within the checks route's command limit (check-runs.ts CHECK_RUN_LIMITS)
        command: `${show(ARCHMAP.cmd)} <${scope.paths.length} files>`,
        files: scope.paths,
        result: r.ok ? 'pass' : 'fail',
        startedAt: r.startedAt,
        durationMs: r.durationMs,
      }),
    ],
    refusal: null,
  };
}

/** A check verify runs, by its label; one renamed out from under this run fails it by name. */
function verifyCheck(label) {
  const found = CHECKS.find((c) => c.label === label);
  if (!found) {
    throw new Error(
      `verify-checks.mjs declares no \`${label}\` check, which test:changed runs over the touched files`,
    );
  }
  return found;
}

/** verify's form-axis lints, which a builder's run narrows to the files it touched (ISS-1370). */
const FORM_LINTS = ['core lint', 'observability lint', 'web lint', 'scripts lint'].map(verifyCheck);
/** verify's record-axis check, run whole where the change touched what it reads (ISS-1370). */
const RELEASE_RECORD = verifyCheck('release-record');
/** What check-release-record.mjs reads: the record, its fragments and the amnesty file. */
const RECORD_READS = new RegExp(
  `^(?:CHANGELOG\\.md|${FRAGMENT_DIR}/.+|\\.forge/changelog-amnesty\\.json)$`,
);

/**
 * Where a lint verify runs reads from and the program it runs: `pnpm exec <argv>` at the root, or
 * `pnpm --filter <package> <script>` as that package's own script, in its directory.
 */
export function lintCommand(root, cmd) {
  if (cmd[0] === 'pnpm' && cmd[1] === 'exec') return { cwd: '.', argv: cmd.slice(2) };
  if (cmd[0] === 'pnpm' && cmd[1] === '--filter' && cmd.length === 4) {
    const dir = packageDirs(root).get(cmd[2]);
    const script = dir
      ? JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')).scripts?.[cmd[3]]
      : undefined;
    if (script) return { cwd: dir, argv: script.trim().split(/\s+/) };
  }
  return { refusal: `\`${show(cmd)}\` names no package script this run can narrow to its files` };
}

/** The lint's argv with its directory arguments taken out, and those directories. */
function lintScope(root, { cwd, argv }) {
  const isDir = (a, i) =>
    i > 0 &&
    !a.startsWith('-') &&
    existsSync(join(root, cwd, a)) &&
    statSync(join(root, cwd, a)).isDirectory();
  return {
    flags: argv.filter((a, i) => !isDir(a, i)),
    dirs: argv.filter(isDir),
  };
}

/** The touched files still on disk under the lint's directories, relative to where it runs. */
function lintedFiles(touched, cwd, dirs) {
  const prefix = cwd === '.' ? '' : `${cwd}/`;
  return touched
    .filter((t) => t.change !== 'removed' && t.path.startsWith(prefix))
    .map((t) => t.path.slice(prefix.length))
    .filter((rel) => dirs.some((d) => rel.startsWith(`${d}/`)));
}

/**
 * Run a check's command capturing its output, and read its scanned count; the output is printed
 * unless the check read no file, whose own complaint about that is the `none` this run reports.
 */
function runCaptured(exec, argv, cwd, scanned) {
  const r = exec(argv, cwd, { capture: true });
  const out = `${r.stdout}${r.stderr}`;
  const m = scanned ? out.match(scanned) : null;
  const count = m ? Number(m[1]) : null;
  if (out.trim() && count !== 0) process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
  return { ...r, scanned: count };
}

/** A check this run owed nothing to: it says so, at no time. */
const noneTouched = (name, scope, command, note) =>
  check({
    name,
    kind: 'conformance',
    scope,
    command,
    files: [],
    result: 'none',
    startedAt: Date.now(),
    durationMs: 0,
    note,
  });

/**
 * verify's form-axis lints (Biome over core and the scripts, ESLint over web-v2) over the touched
 * files each one reads, with the lint's own command and config: its directory arguments replaced by
 * the touched files under them, so a builder sees a format or lint red before the landing's
 * `pnpm verify` does, and no lint reads the whole tree. A lint that reads none of the files handed
 * it says `none`.
 */
export function runFormLints(root, touched, { exec = run } = {}) {
  const checks = [];
  for (const lint of FORM_LINTS) {
    const at = lintCommand(root, lint.cmd);
    if (at.refusal) return { checks: [], refusal: `${lint.label}: ${at.refusal}` };
    const { flags, dirs } = lintScope(root, at);
    const files = lintedFiles(touched, at.cwd, dirs);
    const where = at.cwd === '.' ? '' : `cd ${at.cwd} && `;
    const command = `(${where}pnpm exec ${show(flags)} <${files.length} files>)`;
    if (files.length === 0) {
      checks.push(noneTouched(lint.label, lint.axis, command, 'no touched file this lint reads'));
      continue;
    }
    const missing = absentPrerequisites(root, lint.needs);
    if (missing.length) {
      return {
        checks: [],
        refusal: `${lint.label} cannot run in this checkout, so the touched files were not linted:\n${remedyLines(missing).join('\n')}`,
      };
    }
    const r = runCaptured(
      exec,
      ['pnpm', 'exec', ...flags, ...files],
      join(root, at.cwd),
      lint.scanned,
    );
    const read = r.scanned !== 0;
    checks.push(
      check({
        name: lint.label,
        kind: 'conformance',
        scope: lint.axis,
        command,
        files: files.map((f) => (at.cwd === '.' ? f : `${at.cwd}/${f}`)),
        result: !read ? 'none' : r.ok ? 'pass' : 'fail',
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        ...(read ? {} : { note: 'the lint read none of the touched files under its directories' }),
      }),
    );
  }
  return { checks, refusal: null };
}

/**
 * verify's record-axis check, `check-release-record.mjs`, where the change touched the record, a
 * `changelog.d/` fragment or the amnesty file: it judges against the merge-base as verify does, so a
 * fragment over its word budget is red here before the landing's gate. Otherwise `none`.
 */
export function runReleaseRecord(root, touched, { exec = run } = {}) {
  const files = touched.filter((t) => RECORD_READS.test(t.path)).map((t) => t.path);
  if (files.length === 0) {
    return noneTouched(
      RELEASE_RECORD.label,
      RELEASE_RECORD.axis,
      show(RELEASE_RECORD.cmd),
      'no touched changelog fragment or record',
    );
  }
  const r = runCaptured(exec, RELEASE_RECORD.cmd, root, null);
  return check({
    name: RELEASE_RECORD.label,
    kind: 'conformance',
    scope: RELEASE_RECORD.axis,
    command: show(RELEASE_RECORD.cmd),
    files,
    result: r.ok ? 'pass' : 'fail',
    startedAt: r.startedAt,
    durationMs: r.durationMs,
  });
}

/**
 * The vitest runs of a selection, one per collection, under the collection's own config. A run
 * naming no file is refused: vitest given no path runs the whole collection, which is the fallback
 * this selection exists to keep out (REQ-36 BC-17).
 */
function runVitest(root, collections, name, exec) {
  return collections.map(({ collection, files }) => {
    if (files.length === 0) {
      throw new Error(
        `${name}: ${collection.name} was handed to vitest with no file, and vitest run naming no file runs the whole collection`,
      );
    }
    const paths = files.map((f) => join(root, f.test));
    const argv = ['pnpm', 'exec', 'vitest', 'run', '--config', collection.config, ...paths];
    console.log(
      `\n${name}: ${collection.name}, ${files.length} file(s):\n${files
        .map((f) => `  ${f.test}  ← ${f.because.join(', ')}`)
        .join('\n')}`,
    );
    const r = exec(argv, join(root, collection.cwd));
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
function runCrate(root, known, entry, exec) {
  const cwd = join(root, 'packages/runner');
  const checks = [];
  const crateCheck = (fields) =>
    check({ name: 'direct-tests', kind: 'tests', scope: `runner/${entry.crate}`, ...fields });
  if (entry.modules.length) {
    const list = ['cargo', 'test', '-p', entry.crate, '--locked', '--', '--list'];
    const listed = exec(list, cwd, { capture: true });
    if (!listed.ok) {
      process.stderr.write(listed.stderr);
      checks.push(
        crateCheck({
          command: show(list),
          files: entry.modules.map((m) => m.path),
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
      const r = exec(argv, cwd);
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
    const r = exec(argv, cwd);
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
 * What a selection owes a run, by check and scope: each selected test file of a collection, and each
 * touched runner module and test target of a crate.
 */
export function owedBy({ unit, integ, crates, integration }) {
  const owed = [
    ...unit.map((c) => ({
      name: 'direct-tests',
      scope: c.collection.name,
      files: c.files.map((f) => f.test),
    })),
    ...crates
      .map((e) => ({
        name: 'direct-tests',
        scope: `runner/${e.crate}`,
        files: [...e.modules.map((m) => m.path), ...e.testTargets.map((t) => t.path)],
      }))
      .filter((o) => o.files.length > 0),
  ];
  if (integration) {
    owed.push(
      ...integ.map((c) => ({
        name: 'integration-tests',
        scope: c.collection.name,
        files: c.files.map((f) => f.test),
      })),
    );
  }
  return owed;
}

/**
 * The selected files no check ran, as one red check per scope: DIRECT_TESTS_NOT_RUN. A selection
 * that ran nothing must never read as a change with no direct test (REQ-36 BC-7).
 */
export function notRun(owed, checks) {
  const key = (scope, file) => `${scope}\n${file}`;
  const ran = new Set(checks.flatMap((c) => c.files.map((f) => key(c.scope, f))));
  return owed
    .map((o) => ({ ...o, files: o.files.filter((f) => !ran.has(key(o.scope, f))) }))
    .filter((o) => o.files.length > 0)
    .map((o) =>
      check({
        name: o.name,
        kind: 'tests',
        scope: o.scope,
        command: '',
        files: o.files,
        result: 'fail',
        startedAt: Date.now(),
        durationMs: 0,
        note: `DIRECT_TESTS_NOT_RUN: ${o.files.length} selected file(s) no run reached: ${o.files.join(', ')}`,
      }),
    );
}

/**
 * Run what a selection chose: each unit collection's files, each crate's tests and, when asked, the
 * integration collections' files. The one place a selection becomes commands.
 */
export function runSelection(root, { unit, integ, crates, integration, known, exec }) {
  const checks = runVitest(root, unit, 'direct-tests', exec);
  for (const entry of crates) checks.push(...runCrate(root, known, entry, exec));
  if (integration) checks.push(...runVitest(root, integ, 'integration-tests', exec));
  return checks;
}

/**
 * Select and run the direct tests of `touched` (every package) and, when `integration` is set, the
 * core integration tests the same rule selects. Answers the checks made and the touched code no test
 * reaches. "No test file is direct" is said only where nothing was selected; a selection the run did
 * not reach is red by name (`notRun`). Before any test runs, each workspace package a selected
 * collection loads from its dist is rebuilt and held to its source (`package-builds.mjs`); where one
 * cannot be, the answer is its `refusal` (PACKAGE_BUILD_STALE) and no test has run (ISS-587).
 * `narrow` (the developer's run) reads each touched file so a test's `@direct-test-when` lines can
 * leave it out where the file cannot change its answer; the merge check leaves it off, so every
 * declaration selects as written before a merge (ISS-769). `exec` runs one command and
 * `runSelected` runs a selection, `run` and `runSelection` unless a test stands in for them.
 */
export function runDirectTests(
  root,
  { touched, integration, narrow = false, exec = run, runSelected = runSelection },
) {
  const live = touched.filter((t) => t.change !== 'removed').map((t) => t.path);
  const known = knownFiles(root);
  const tests = indexTests(root, known);
  const textOf = (path) => {
    try {
      return readFileSync(join(root, path), 'utf8');
    } catch {
      return null;
    }
  };
  const { collections, untested, narrowed } = selectDirect(live, tests, narrow ? { textOf } : {});
  const unit = collections.filter((c) => !c.collection.integration);
  const integ = collections.filter((c) => c.collection.integration);
  const crates = runnerSelection(live);
  const owed = owedBy({ unit, integ, crates, integration });
  const running = [...unit, ...(integration ? integ : [])].map((c) => c.collection);
  const builds = rebuildPackages(root, buildsOwed(running), { exec });
  if (builds.refusal) {
    return {
      checks: [],
      untested: [],
      integrationSelected: [],
      narrowed: [],
      built: builds.built,
      refusal: builds.refusal,
    };
  }
  const checks = runSelected(root, { unit, integ, crates, integration, known, exec });
  if (!owed.some((o) => o.name === 'direct-tests')) {
    checks.push(
      nothingToRun('direct-tests', 'workspace', 'no test file is direct for any touched file'),
    );
  }
  if (integration && integ.length === 0) {
    checks.push(
      nothingToRun(
        'integration-tests',
        '@forge/core integration',
        'no integration test is direct for any touched file',
      ),
    );
  }
  checks.push(...notRun(owed, checks));
  return {
    checks,
    untested: [...untested, ...crates.flatMap((c) => c.untested)],
    integrationSelected: integ.flatMap((c) => c.files.map((f) => f.test)),
    narrowed,
    built: builds.built,
    refusal: null,
  };
}

/** The lines a run prints about what it ran and how long each took. */
export function describeChecks(checks) {
  return checks.map(
    (c) =>
      `  ${c.result.padEnd(4)}  ${c.name.padEnd(17)} ${c.scope.padEnd(26)} ${(c.durationMs / 1000).toFixed(1).padStart(6)}s  ${c.files.length ? `${c.files.length} file(s)` : ''}${c.note ? ` — ${c.note}` : ''}`,
  );
}
