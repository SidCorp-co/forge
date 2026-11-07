// The merge check's reruns of a red integration test (ISS-1120). A red the base holds without the
// change is not the change's to fix, and a test that flips is not either: each red file of a red
// `integration-tests` check is rerun once at the head, and where it stays red, once at the merge base
// in a clean detached worktree under the repository's `.claude/worktrees/`, removed after. Only the
// files that went red are rerun, never the selection. `base-red` and `flaky` are named apart in the
// report (`reruns`), which core records as passing; `branch-red` is refused as every red was before.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { VITEST_COLLECTIONS } from './direct-tests.mjs';
import { buildsOwed, rebuildPackages } from './package-builds.mjs';

/** The verdict a rerun's outcomes bear, as `packages/contracts/src/merge-check.ts:rerunVerdictOf` reads it. */
export function rerunVerdictOf(head, base) {
  if (head === 'pass') return 'flaky';
  return head === 'fail' && base === 'fail' ? 'base-red' : 'branch-red';
}

const isVitestRun = (argv) => argv.includes('vitest') && argv.includes('run');

/**
 * An `exec` for `runDirectTests` that has each vitest run also write vitest's JSON report, so the
 * files that went red are known by name: `calls` holds, per run, where it ran, the test files it was
 * handed (relative to `root`) and where its JSON went. Every other command runs as `exec` runs it.
 * `dispose` removes the reports once the reruns have read them.
 */
export function recordingExec(exec, root) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-merge-check-runs-'));
  const calls = [];
  const wrapped = (argv, cwd, opts) => {
    if (!isVitestRun(argv)) return exec(argv, cwd, opts);
    const json = join(dir, `run-${calls.length}.json`);
    const files = argv
      .filter((a) => isAbsolute(a) && a.endsWith('.ts'))
      .map((a) => relative(root, a));
    calls.push({ cwd, files, json });
    return exec(
      [...argv, '--reporter=default', '--reporter=json', `--outputFile.json=${json}`],
      cwd,
      opts,
    );
  };
  return { exec: wrapped, calls, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The test files a vitest JSON report says went red, relative to `root`, or the refusal naming why it
 * cannot say: a run that wrote no report, or one that is not vitest's, leaves its red unclassed.
 */
export function redFilesOf(text, root) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { files: [], refusal: 'its JSON report is not JSON' };
  }
  if (!Array.isArray(parsed?.testResults))
    return { files: [], refusal: 'its JSON report holds no testResults' };
  const files = parsed.testResults
    .filter((t) => t.status !== 'passed')
    .map((t) => (isAbsolute(t.name) ? relative(root, t.name) : t.name));
  if (!files.length) return { files: [], refusal: 'its JSON report names no red file' };
  return { files };
}

const sameFiles = (a, b) => a.length === b.length && a.every((f) => b.includes(f));

/** The vitest command that reruns one file of `collection` in `root`. */
function rerunArgv(root, collection, file) {
  return ['pnpm', 'exec', 'vitest', 'run', '--config', collection.config, join(root, file)];
}

const commandOf = (collection, file) =>
  `(cd ${collection.cwd} && pnpm exec vitest run --config ${collection.config} ${relative(collection.cwd, file)})`;

/** Where the merge base's worktree goes: the repository's own `.claude/worktrees/`, a name of its own. */
export function baseWorktreePath(commonGitDir, base, pid = process.pid) {
  return join(
    dirname(commonGitDir),
    '.claude',
    'worktrees',
    `merge-check-base-${base.slice(0, 12)}-${pid}`,
  );
}

/**
 * The merge base, checked out detached and installed, with the packages `collections` load built;
 * `ready` is false with `note` naming the step that failed. `remove` takes the worktree away.
 */
function baseCheckout({ root, commonGitDir, base, collections, exec, rebuild }) {
  const path = baseWorktreePath(commonGitDir, base);
  const remove = () => {
    if (!existsSync(path)) return;
    const r = exec(['git', 'worktree', 'remove', '--force', path], root, { capture: true });
    if (!r.ok)
      console.error(
        `merge-check: could not remove the merge base's worktree ${path}: ${r.stderr.trim()}`,
      );
  };
  const steps = [
    { argv: ['git', 'worktree', 'add', '--detach', path, base], cwd: root },
    { argv: ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'], cwd: path },
  ];
  for (const s of steps) {
    const r = exec(s.argv, s.cwd, { capture: true });
    if (!r.ok) return { path, ready: false, note: `\`${s.argv.join(' ')}\` failed`, remove };
  }
  const built = rebuild(path, buildsOwed(collections), { exec });
  if (built.refusal)
    return { path, ready: false, note: built.refusal.split('\n')[0].slice(0, 300), remove };
  return { path, ready: true, remove };
}

const runOf = (at, sha, result, command, r, note) => ({
  at,
  sha,
  result,
  command,
  startedAt: new Date(r.startedAt).toISOString(),
  durationMs: r.durationMs,
  ...(note ? { note } : {}),
});

/**
 * Rerun each red file of each red `integration-tests` check: once at `head` in `root`, and each that
 * stays red once at `base`, in one worktree made for them all and removed after. Answers the reruns,
 * as the report's `reruns` takes them, and the lines saying which reds could not be classed (a run
 * whose report names no red file stays the change's red, as before). `exec` runs one command as
 * `direct-test-run.mjs:run` does, and `rebuild` builds the base's packages, unless a test stands in.
 * `commonGitDir` is the repository's own git directory (`git rev-parse --git-common-dir`), whose
 * checkout holds the `.claude/worktrees/` the base worktree goes in.
 */
export function rerunReds({
  root,
  commonGitDir,
  head,
  base,
  checks,
  calls,
  exec,
  rebuild = rebuildPackages,
}) {
  const reruns = [];
  const unclassed = [];
  const owed = [];
  for (const check of checks) {
    if (check.name !== 'integration-tests' || check.result !== 'fail' || !check.command) continue;
    const collection = VITEST_COLLECTIONS.find((c) => c.name === check.scope);
    const call = calls.find((c) => sameFiles(c.files, check.files));
    if (!collection || !call) {
      unclassed.push(
        `${check.scope}: the run's own record was not found, so its red stays the change's`,
      );
      continue;
    }
    const red = existsSync(call.json)
      ? redFilesOf(readFileSync(call.json, 'utf8'), root)
      : { files: [], refusal: 'it wrote no JSON report' };
    if (red.refusal) {
      unclassed.push(`${check.scope}: ${red.refusal}, so its red stays the change's`);
      continue;
    }
    for (const file of red.files.filter((f) => check.files.includes(f))) {
      console.log(`\nmerge-check: ${file} went red; rerunning it once at the head`);
      const r = exec(rerunArgv(root, collection, file), join(root, collection.cwd));
      const at = runOf('head', head, r.ok ? 'pass' : 'fail', commandOf(collection, file), r);
      const rerun = { check: check.id, file, runs: [at] };
      reruns.push(rerun);
      if (!r.ok) owed.push({ rerun, collection });
    }
  }
  if (owed.length) {
    const collections = [...new Set(owed.map((o) => o.collection))];
    console.log(
      `\nmerge-check: ${owed.length} file(s) stayed red; rerunning them at the merge base ${base.slice(0, 12)}`,
    );
    const checkout = baseCheckout({ root, commonGitDir, base, collections, exec, rebuild });
    try {
      for (const { rerun, collection } of owed) {
        const command = `${commandOf(collection, rerun.file)} at ${base.slice(0, 12)}`;
        if (!checkout.ready) {
          const r = { startedAt: Date.now(), durationMs: 0 };
          rerun.runs.push(runOf('base', base, 'error', command, r, checkout.note));
          continue;
        }
        if (!existsSync(join(checkout.path, rerun.file))) {
          const r = { startedAt: Date.now(), durationMs: 0 };
          rerun.runs.push(
            runOf('base', base, 'absent', command, r, 'the merge base holds no such file'),
          );
          continue;
        }
        const r = exec(
          rerunArgv(checkout.path, collection, rerun.file),
          join(checkout.path, collection.cwd),
        );
        rerun.runs.push(runOf('base', base, r.ok ? 'pass' : 'fail', command, r));
      }
    } finally {
      checkout.remove();
    }
  }
  for (const rerun of reruns) {
    const at = (w) => rerun.runs.find((x) => x.at === w)?.result ?? null;
    rerun.verdict = rerunVerdictOf(at('head'), at('base'));
  }
  return {
    reruns: reruns.map(({ check, file, verdict, runs }) => ({ check, file, verdict, runs })),
    unclassed,
  };
}

/** The lines a run prints for the reds it reran, each with how it ended at the head and the base. */
export function rerunLines(reruns) {
  const how = (x) =>
    x.runs
      .map((r) => `${r.at} ${r.sha.slice(0, 12)} ${r.result}${r.note ? ` (${r.note})` : ''}`)
      .join(', ');
  const of = (v) => reruns.filter((x) => x.verdict === v);
  return [
    ...of('base-red').map(
      (x) => `  base-red  ${x.file} — ${how(x)}: red without this change, not refused`,
    ),
    ...of('flaky').map(
      (x) =>
        `  flaky     ${x.file} — ${how(x)}: green on its rerun, not refused; owed a fix of its own`,
    ),
    ...of('branch-red').map((x) => `  red       ${x.file} — ${how(x)}: this change's red`),
  ];
}
