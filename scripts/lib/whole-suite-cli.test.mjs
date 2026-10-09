// @direct-test-of .github/workflows/ci.yml
// @gate-input whole-tree — it runs scripts/cut-release.sh under bash, which the guard cannot see
// into.
// The whole suite's shells, run as written: ci.yml's aggregate step, and its two doors against a
// throwaway repository and a stubbed `gh`:
// `scripts/cut-release.sh` refusing a cut whose commit has no green whole-suite run
// (RELEASE_SUITE_NOT_GREEN), and `scripts/whole-suite.mjs bisect` naming a planted breaking merge.
// The stub answers the GitHub reads from a planted record and logs every call, so a dispatch the
// cut should not have made shows in the log.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CI = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const AGGREGATE_NEEDS = /\n {2}whole-suite:\n[\s\S]*?needs:\s*\[([^\]]*)\]/;
const COPIED = [
  'scripts/cut-release.sh',
  'scripts/whole-suite.mjs',
  'scripts/lib/whole-suite.mjs',
  'scripts/lib/base-branch.mjs',
  'scripts/lib/gate.mjs',
  'scripts/lib/assemble-release.mjs',
  'scripts/lib/changelog-fragments.mjs',
];
const VERSION_FILES = [
  'package.json',
  'packages/core/package.json',
  'packages/contracts/package.json',
  'packages/observability/package.json',
  'packages/web-v2/package.json',
];

// The stub answers from the plan (or from `plan.before`, when given) until the cut sends a POST;
// after a dispatch it answers from `plan.dispatched`, after a rerun from `plan.rerun`. Each is a
// list of answers taken one per check-runs read, the last standing. `plan.moveOrigin` lands a commit on the bare origin as the
// dispatch is sent, as dev does while a whole suite runs.
const STUB = `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_STUB_LOG, JSON.stringify(args) + '\\n');
const plan = JSON.parse(fs.readFileSync(process.env.GH_STUB, 'utf8'));
const statePath = process.env.GH_STUB + '.state';
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
  : { phase: 'before', reads: 0 };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
if (args[0] !== 'api') process.exit(64);
const path = args.find((a) => a.startsWith('repos/'));
if (plan.unreadable) { process.stderr.write('HTTP 401: Bad credentials'); process.exit(1); }
if (args.includes('POST')) {
  if (plan.dispatchFails) process.exit(1);
  state.phase = /rerun-failed-jobs/.test(path) ? 'rerun' : 'dispatched';
  state.reads = 0;
  save();
  const move = plan.moveOrigin;
  if (move && state.phase === 'dispatched') {
    const git = (...a) => spawnSync('git', a, { cwd: move.cwd, encoding: 'utf8' });
    git('pull', '-q', 'origin', 'dev');
    fs.writeFileSync(move.cwd + '/' + move.file, move.content);
    git('add', '-A');
    git('commit', '-q', '-m', move.subject);
    git('push', '-q', 'origin', 'dev');
  }
  process.exit(0);
}
if (/check-runs/.test(path)) { state.reads += 1; save(); }
const steps = [].concat(plan[state.phase] ?? (state.phase === 'before' ? plan : {}));
const now = steps[Math.min(Math.max(state.reads - 1, 0), steps.length - 1)];
let m;
if ((m = /commits\\/([0-9a-f]+)\\/check-runs/.exec(path))) {
  console.log(JSON.stringify({ check_runs: now.checkRuns?.[m[1]] ?? [] }));
} else if ((m = /workflows\\/ci\\.yml\\/runs\\?head_sha=([0-9a-f]+)/.exec(path))) {
  console.log(JSON.stringify({ workflow_runs: now.runs?.[m[1]] ?? [] }));
} else if ((m = /actions\\/runs\\/(\\d+)\\/jobs/.exec(path))) {
  console.log(JSON.stringify({ jobs: now.jobs?.[m[1]] ?? [] }));
} else { process.stderr.write('stub: no answer for ' + path); process.exit(1); }
`;

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sh(cwd, cmd, args, env = {}) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

function git(cwd, ...args) {
  const r = sh(cwd, 'git', args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A clone on `dev` of a bare origin, holding the scripts as this tree has them. */
function repository() {
  const top = mkdtempSync(join(tmpdir(), 'whole-suite-cli-'));
  made.push(top);
  git(top, 'init', '-q', '--bare', '-b', 'dev', 'origin.git');
  git(top, 'clone', '-q', 'origin.git', 'work');
  const work = join(top, 'work');
  git(work, 'config', 'user.email', 't@example.invalid');
  git(work, 'config', 'user.name', 't');
  git(work, 'checkout', '-q', '-b', 'dev');
  for (const rel of COPIED) {
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(work, rel));
  }
  for (const rel of VERSION_FILES) {
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    writeFileSync(join(work, rel), `${JSON.stringify({ name: rel, version: '0.4.0-dev.1' })}\n`);
  }
  writeFileSync(join(work, 'CHANGELOG.md'), '# Changelog\n');
  mkdirSync(join(work, 'changelog.d'));
  writeFileSync(join(work, 'changelog.d/a.fixed.md'), '**A thing works.** It did not.\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', 'origin', 'dev');
  const bin = join(top, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), STUB);
  chmodSync(join(bin, 'gh'), 0o755);
  return { top, work, bin };
}

function withStub(repo, plan) {
  const stub = join(repo.top, 'gh-plan.json');
  const log = join(repo.top, 'gh-log.jsonl');
  writeFileSync(stub, JSON.stringify(plan));
  rmSync(`${stub}.state`, { force: true });
  writeFileSync(log, '');
  const env = {
    PATH: `${repo.bin}:${dirname(process.execPath)}:${process.env.PATH}`,
    GH_STUB: stub,
    GH_STUB_LOG: log,
    GITHUB_REPOSITORY: 'acme/forge',
    CUT_SUITE_WAIT_MINUTES: '1',
    CUT_SUITE_POLL_SECONDS: '0',
  };
  const calls = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { env, calls };
}

const check = (name, status, conclusion, id = 1, runId = 900) => ({
  id,
  name,
  status,
  conclusion,
  app: { slug: 'github-actions' },
  html_url: `https://github.com/acme/forge/actions/runs/${runId}/job/${id}`,
});

function cut(repo, env, ...extra) {
  return sh(
    repo.work,
    'bash',
    ['scripts/cut-release.sh', '0.4.0-dev.2', '--headline', 'H', ...extra],
    env,
  );
}

const posts = (calls) => calls.filter((a) => a.includes('POST'));
const dispatches = (calls) => posts(calls).filter((a) => a.some((x) => x.endsWith('/dispatches')));
const reruns = (calls) =>
  posts(calls).filter((a) => a.some((x) => x.endsWith('/rerun-failed-jobs')));
const versionOf = (repo) =>
  JSON.parse(readFileSync(join(repo.work, 'package.json'), 'utf8')).version;
const originHead = (repo) => git(repo.top, '--git-dir=origin.git', 'rev-parse', 'dev');
const inFlight = (id) => ({
  id,
  event: 'workflow_dispatch',
  status: 'in_progress',
  html_url: `https://github.com/acme/forge/actions/runs/${id}`,
});
/** What GitHub answers on `sha` while the whole suite runs there, then once it came back green. */
const runsThenGreen = (sha, runId = 902) => [
  { runs: { [sha]: [inFlight(runId)] } },
  { checkRuns: { [sha]: [check('whole-suite', 'completed', 'success', 8, runId)] } },
];
const redOnCore = (sha, runId = 901) => ({
  checkRuns: { [sha]: [check('whole-suite', 'completed', 'failure', 7, runId)] },
  jobs: {
    [runId]: [
      { name: 'core', conclusion: 'success' },
      { name: 'web', conclusion: 'failure' },
      { name: 'runner-platforms (windows-latest)', conclusion: 'skipped' },
      { name: 'whole-suite', conclusion: 'failure' },
    ],
  },
});
const redCancelled = (sha, runId = 903) => ({
  checkRuns: { [sha]: [check('whole-suite', 'completed', 'failure', 7, runId)] },
  jobs: {
    [runId]: [
      { name: 'core', conclusion: 'success' },
      { name: 'runner-platforms (macos-latest)', conclusion: 'cancelled' },
    ],
  },
});

/** A second clone of the same origin, from which a landing reaches dev while the cut waits. */
function lander(repo, file = 'landed.txt') {
  git(repo.top, 'clone', '-q', 'origin.git', 'other');
  const cwd = join(repo.top, 'other');
  git(cwd, 'config', 'user.email', 't@example.invalid');
  git(cwd, 'config', 'user.name', 't');
  return { cwd, file, content: 'landed while the suite ran\n', subject: 'ISS-77: a landing' };
}

describe('cut-release.sh cuts only on a commit whose whole suite is green (RELEASE_SUITE_NOT_GREEN)', () => {
  it('no run on the commit: one whole-suite run is started, waited on, and the cut lands once it is green', () => {
    const repo = repository();
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const { env, calls } = withStub(repo, { dispatched: runsThenGreen(head) });
    const r = cut(repo, env);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Started the whole suite on dev (its head is ${head.slice(0, 9)})`);
    expect(r.stdout).toContain(`whole suite green on ${head.slice(0, 9)}`);
    const sent = dispatches(calls());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(
      expect.arrayContaining(['ref=dev', 'inputs[base]=dev', 'inputs[suite]=whole']),
    );
    expect(versionOf(repo)).toBe('0.4.0-dev.2');
    expect(originHead(repo)).toBe(git(repo.work, 'rev-parse', 'HEAD'));
    expect(git(repo.work, 'rev-parse', 'HEAD^')).toBe(head);
  });

  it('only a skipped whole-suite check on the commit (a run that was not a whole-suite run): read as none, so one is started', () => {
    const repo = repository();
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const { env, calls } = withStub(repo, {
      checkRuns: { [head]: [check('whole-suite', 'completed', 'skipped', 3, 870)] },
      dispatched: runsThenGreen(head),
    });
    const r = cut(repo, env);
    expect(r.stderr).not.toContain('is red');
    expect(r.stdout).not.toContain('Reran');
    expect(r.status).toBe(0);
    expect(posts(calls())).toHaveLength(1);
    expect(dispatches(calls())).toHaveLength(1);
    expect(versionOf(repo)).toBe('0.4.0-dev.2');
  });

  it('a green whole-suite run on the parent does not count for the commit: one is started on the commit', () => {
    const repo = repository();
    const parent = git(repo.work, 'rev-parse', 'HEAD');
    writeFileSync(join(repo.work, 'f.txt'), 'x\n');
    git(repo.work, 'add', '-A');
    git(repo.work, 'commit', '-q', '-m', 'ISS-5: after the green run');
    git(repo.work, 'push', '-q', 'origin', 'dev');
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const green = { [parent]: [check('whole-suite', 'completed', 'success', 4, 880)] };
    const { env, calls } = withStub(repo, { checkRuns: green, dispatched: runsThenGreen(head) });
    const r = cut(repo, env);
    expect(r.status).toBe(0);
    expect(dispatches(calls())).toHaveLength(1);
    expect(r.stdout).toContain(`whole suite green on ${head.slice(0, 9)}`);
  });

  it('a run already in flight on the commit: waited on until green, and no second run is started', () => {
    const repo = repository();
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const { env, calls } = withStub(repo, { before: runsThenGreen(head, 5) });
    const r = cut(repo, env);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(posts(calls())).toHaveLength(0);
    expect(versionOf(repo)).toBe('0.4.0-dev.2');
  });

  it('a run that does not finish within the wait: refused, naming --at so a later cut goes on waiting on it', () => {
    const repo = repository();
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const { env, calls } = withStub(repo, runsThenGreen(head, 5)[0]);
    const r = cut(repo, { ...env, CUT_SUITE_WAIT_MINUTES: '0.002' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('RELEASE_SUITE_NOT_GREEN: a CI run is still running');
    expect(r.stderr).toContain('actions/runs/5');
    expect(r.stderr).toContain(`Cut again with --at ${head}`);
    expect(posts(calls())).toHaveLength(0);
    expect(versionOf(repo)).toBe('0.4.0-dev.1');
  });

  it('the run it started comes back red on a test: refused naming the failing jobs, nothing cut', () => {
    const repo = repository();
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const { env, calls } = withStub(repo, {
      dispatched: [{ runs: { [head]: [inFlight(901)] } }, redOnCore(head)],
    });
    const r = cut(repo, env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('RELEASE_SUITE_NOT_GREEN: the whole suite is red');
    expect(r.stderr).toContain('web (failure), runner-platforms (windows-latest) (skipped)');
    expect(r.stderr).toContain('Land the fix');
    expect(r.stderr).not.toContain('whole-suite (failure)');
    expect(dispatches(calls())).toHaveLength(1);
    expect(reruns(calls())).toHaveLength(0);
    expect(versionOf(repo)).toBe('0.4.0-dev.1');
    expect(originHead(repo)).toBe(head);
  });

  it('a red run on the commit where a test failed: refused at once, nothing started or rerun', () => {
    const repo = repository();
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const { env, calls } = withStub(repo, redOnCore(head));
    const r = cut(repo, env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Land the fix, then cut on the commit that carries it.');
    expect(posts(calls())).toHaveLength(0);
  });

  it('a red run where no job failed on its own steps (a cancelled leg): rerun once, not "land the fix", and the cut lands once green', () => {
    const repo = repository();
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const { env, calls } = withStub(repo, {
      ...redCancelled(head),
      rerun: [{ runs: { [head]: [inFlight(903)] } }, ...runsThenGreen(head, 903).slice(1)],
    });
    const r = cut(repo, env);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Reran the jobs of run 903 that did not succeed.');
    expect(reruns(calls())).toHaveLength(1);
    expect(reruns(calls())[0]).toContain('repos/acme/forge/actions/runs/903/rerun-failed-jobs');
    expect(dispatches(calls())).toHaveLength(0);
    expect(versionOf(repo)).toBe('0.4.0-dev.2');
  });

  it('a rerun that is red the same way again: refused, saying a rerun settles it, and not rerun twice', () => {
    const repo = repository();
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const again = redCancelled(head);
    again.checkRuns[head][0].id = 70;
    const { env, calls } = withStub(repo, { ...redCancelled(head), rerun: [again] });
    const r = cut(repo, env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'no job failed on its own steps: runner-platforms (macos-latest) (cancelled)',
    );
    expect(r.stderr).not.toContain('Land the fix');
    expect(r.stderr).toContain('gh run rerun 903 --failed');
    expect(r.stderr).toContain('red the same way again');
    expect(reruns(calls())).toHaveLength(1);
  });

  it('GitHub cannot be read: refused, never read as no run and never as green', () => {
    const repo = repository();
    const { env, calls } = withStub(repo, { unreadable: true });
    const r = cut(repo, env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Bad credentials');
    expect(posts(calls())).toHaveLength(0);
    expect(versionOf(repo)).toBe('0.4.0-dev.1');
  });

  it('a green whole-suite run on the commit: the cut proceeds at once', () => {
    const repo = repository();
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const { env, calls } = withStub(repo, {
      checkRuns: { [head]: [check('whole-suite', 'completed', 'success', 8, 902)] },
    });
    const r = cut(repo, env);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`whole suite green on ${head.slice(0, 9)}`);
    expect(git(repo.work, 'log', '-1', '--format=%s')).toBe('Release dev-v0.4.0-dev.2');
    expect(posts(calls())).toHaveLength(0);
  });
});

describe('a rehearsal (--no-push) starts nothing', () => {
  it('no run on the commit: refused, naming what a cut would start, and no run is started', () => {
    const repo = repository();
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const { env, calls } = withStub(repo, { dispatched: runsThenGreen(head) });
    const r = cut(repo, env, '--no-push');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      `RELEASE_SUITE_NOT_GREEN: ${head.slice(0, 9)} has no whole-suite run`,
    );
    expect(r.stderr).toContain(
      'A rehearsal starts nothing. Start it with: gh workflow run ci.yml --ref dev',
    );
    expect(posts(calls())).toHaveLength(0);
    expect(versionOf(repo)).toBe('0.4.0-dev.1');
  });

  it('a red run no job of which failed on its own steps: says rerun, and reruns nothing', () => {
    const repo = repository();
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const { env, calls } = withStub(repo, redCancelled(head));
    const r = cut(repo, env, '--no-push');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('A rerun settles it, not a fix: gh run rerun 903 --failed');
    expect(posts(calls())).toHaveLength(0);
  });

  it('a green commit: the rehearsal cuts locally and pushes nothing', () => {
    const repo = repository();
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const { env } = withStub(repo, {
      checkRuns: { [head]: [check('whole-suite', 'completed', 'success', 8, 902)] },
    });
    const r = cut(repo, env, '--no-push');
    expect(r.status).toBe(0);
    expect(versionOf(repo)).toBe('0.4.0-dev.2');
    expect(originHead(repo)).toBe(head);
  });
});

describe('a cut finishes on a branch that moves while its whole suite runs', () => {
  it('the release commit stays on the commit the suite passed and is merged onto the moved head, head first', () => {
    const repo = repository();
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const { env } = withStub(repo, { dispatched: runsThenGreen(head), moveOrigin: lander(repo) });
    const r = cut(repo, env);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const tip = originHead(repo);
    const [first, second] = git(repo.work, 'rev-list', '--parents', '-n', '1', tip)
      .split(' ')
      .slice(1);
    expect(git(repo.work, 'log', '-1', '--format=%s', first)).toBe('ISS-77: a landing');
    expect(git(repo.work, 'log', '-1', '--format=%s', second)).toBe('Release dev-v0.4.0-dev.2');
    expect(git(repo.work, 'rev-parse', `${second}^`)).toBe(head);
    expect(git(repo.work, 'log', '-1', '--format=%s', tip)).toBe(
      'Merge release dev-v0.4.0-dev.2 into dev',
    );
    expect(r.stdout).toContain('dev landed 1 commit(s) past');
    expect(r.stdout).toContain(`serves ${tip}`);
    expect(r.stdout).toContain(`git tag dev-v0.4.0-dev.2 ${second}`);
  });

  it('--at goes on waiting on the run an earlier attempt started, after the head moved, and starts none', () => {
    const repo = repository();
    const first = git(repo.work, 'rev-parse', 'HEAD');
    const other = lander(repo);
    git(other.cwd, 'pull', '-q', 'origin', 'dev');
    writeFileSync(join(other.cwd, other.file), other.content);
    git(other.cwd, 'add', '-A');
    git(other.cwd, 'commit', '-q', '-m', other.subject);
    git(other.cwd, 'push', '-q', 'origin', 'dev');
    git(repo.work, 'pull', '-q', 'origin', 'dev');
    const { env, calls } = withStub(repo, { before: runsThenGreen(first, 6) });
    const r = cut(repo, env, '--at', first);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(posts(calls())).toHaveLength(0);
    const tip = originHead(repo);
    const second = git(repo.work, 'rev-parse', `${tip}^2`);
    expect(git(repo.work, 'rev-parse', `${second}^`)).toBe(first);
  });

  it('--at on a commit with no run that is no longer the head: refused, since a dispatch would test the head', () => {
    const repo = repository();
    const first = git(repo.work, 'rev-parse', 'HEAD');
    writeFileSync(join(repo.work, 'g.txt'), 'g\n');
    git(repo.work, 'add', '-A');
    git(repo.work, 'commit', '-q', '-m', 'ISS-6: later');
    git(repo.work, 'push', '-q', 'origin', 'dev');
    const { env, calls } = withStub(repo, {});
    const r = cut(repo, env, '--at', first);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${first.slice(0, 9)} is no longer the head of dev`);
    expect(posts(calls())).toHaveLength(0);
  });

  it('a landing that touched a fragment the release folds: refused by name, nothing pushed', () => {
    const repo = repository();
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const move = {
      ...lander(repo, 'changelog.d/a.fixed.md'),
      content: '**A thing works.** Now.\n',
    };
    const { env } = withStub(repo, { dispatched: runsThenGreen(head), moveOrigin: move });
    const r = cut(repo, env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('does not merge onto origin/dev');
    expect(r.stderr).toContain('changelog.d/a.fixed.md');
    expect(r.stderr).toContain('Nothing was pushed.');
    expect(git(repo.work, 'log', '-1', '--format=%s', originHead(repo))).toBe('ISS-77: a landing');
  });
});

describe('a red whole-suite run names the merge that broke it', () => {
  /** base ← merge of iss-1 ← merge of iss-2 ← merge of iss-3, each `--no-ff`, newest last. */
  function landings(repo, numbers = [1, 2, 3]) {
    const shas = [git(repo.work, 'rev-parse', 'HEAD')];
    for (const n of numbers) {
      git(repo.work, 'checkout', '-q', '-b', `iss-${n}`);
      writeFileSync(join(repo.work, `f${n}.txt`), `${n}\n`);
      git(repo.work, 'add', '-A');
      git(repo.work, 'commit', '-q', '-m', `change ${n}`);
      git(repo.work, 'checkout', '-q', 'dev');
      git(
        repo.work,
        'merge',
        '-q',
        '--no-ff',
        `iss-${n}`,
        '-m',
        `Merge branch 'iss-${n}' into dev`,
      );
      shas.push(git(repo.work, 'rev-parse', 'HEAD'));
    }
    return shas;
  }

  const failedRun = {
    903: [
      { name: 'core', conclusion: 'failure' },
      { name: 'web', conclusion: 'success' },
    ],
  };

  it('the planted breaking merge is named with its issue, past a merge recorded green', () => {
    const repo = repository();
    const [base, m1, m2, m3] = landings(repo);
    const { env } = withStub(repo, {
      checkRuns: {
        [base]: [check('whole-suite', 'completed', 'success', 1)],
        [m1]: [check('core', 'completed', 'success', 2)],
        [m2]: [check('core', 'completed', 'failure', 3)],
      },
      jobs: failedRun,
    });
    const r = sh(
      repo.work,
      process.execPath,
      ['scripts/whole-suite.mjs', 'bisect', '--commit', m3, '--run', '903'],
      env,
    );
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`The whole suite went red on ${m3.slice(0, 9)}: core (failure).`);
    expect(r.stdout).toContain(`Last green whole-suite run: ${base.slice(0, 9)}.`);
    expect(r.stdout).toContain(
      `The merge that broke it: ${m2.slice(0, 9)} Merge branch 'iss-2' into dev (ISS-2).`,
    );
  });

  it('no record between the last green run and the red one: the range is named, every merge in it', () => {
    const repo = repository();
    const [base, m1, m2, m3] = landings(repo);
    const { env } = withStub(repo, {
      checkRuns: { [base]: [check('whole-suite', 'completed', 'success', 1)] },
      jobs: failedRun,
    });
    const r = sh(
      repo.work,
      process.execPath,
      ['scripts/whole-suite.mjs', 'bisect', '--commit', m3, '--run', '903'],
      env,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No single merge is named');
    for (const [sha, n] of [
      [m1, 1],
      [m2, 2],
      [m3, 3],
    ]) {
      expect(r.stdout).toContain(
        `- ${sha.slice(0, 9)} Merge branch 'iss-${n}' into dev (ISS-${n})`,
      );
    }
    expect(r.stdout).not.toContain(`- ${base.slice(0, 9)}`);
  });

  // The independent judge's plant (comment 9da9b859): four landings, ISS-901 green, ISS-902 core
  // recorded success, ISS-903 no record, ISS-904 red. The answer is the range ISS-903..ISS-904,
  // and the skipped whole-suite check that any run which is not a whole-suite run leaves on
  // ISS-902 records nothing about a test, so it must not move the answer.
  for (const withSkipped of [false, true]) {
    it(`a range stays the range${withSkipped ? ', a skipped whole-suite check on a passed merge notwithstanding' : ''}`, () => {
      const repo = repository();
      const [, m901, m902, m903, m904] = landings(repo, [901, 902, 903, 904]);
      const onM902 = [check('core', 'completed', 'success', 21, 8002)];
      if (withSkipped) onM902.push(check('whole-suite', 'completed', 'skipped', 22, 8002));
      const { env } = withStub(repo, {
        checkRuns: {
          [m901]: [check('whole-suite', 'completed', 'success', 11, 8001)],
          [m902]: onM902,
        },
        jobs: { 8004: [{ name: 'core', conclusion: 'failure' }] },
      });
      const r = sh(
        repo.work,
        process.execPath,
        ['scripts/whole-suite.mjs', 'bisect', '--commit', m904, '--run', '8004'],
        env,
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`Last green whole-suite run: ${m901.slice(0, 9)}.`);
      expect(r.stdout).toContain('No single merge is named');
      expect(r.stdout).toContain(`- ${m903.slice(0, 9)} Merge branch 'iss-903' into dev (ISS-903)`);
      expect(r.stdout).toContain(`- ${m904.slice(0, 9)} Merge branch 'iss-904' into dev (ISS-904)`);
      expect(r.stdout).not.toContain('ISS-902');
    });
  }
});

describe('a scheduled run starts the whole suite on every other gated branch', () => {
  function withWorkflow(repo) {
    mkdirSync(join(repo.work, '.github/workflows'), { recursive: true });
    copyFileSync(
      join(ROOT, '.github/workflows/ci.yml'),
      join(repo.work, '.github/workflows/ci.yml'),
    );
  }

  it('run on main, it dispatches suite: whole onto dev and nothing onto main', () => {
    const repo = repository();
    withWorkflow(repo);
    const { env, calls } = withStub(repo, {});
    const r = sh(
      repo.work,
      process.execPath,
      ['scripts/whole-suite.mjs', 'fanout', '--ran-on', 'main'],
      env,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('started the whole suite on dev');
    const sent = dispatches(calls());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(
      expect.arrayContaining(['ref=dev', 'inputs[base]=dev', 'inputs[suite]=whole']),
    );
  });

  it('a dispatch GitHub refuses fails the job, naming the branch', () => {
    const repo = repository();
    withWorkflow(repo);
    const { env } = withStub(repo, { dispatchFails: true });
    const r = sh(
      repo.work,
      process.execPath,
      ['scripts/whole-suite.mjs', 'fanout', '--ran-on', 'main'],
      env,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not start the whole suite on dev');
  });
});

describe("the aggregate step's shell, as ci.yml writes it", () => {
  const step = 'Require every job of the whole suite to have succeeded';
  const shell = (() => {
    const at = CI.indexOf(`- name: ${step}`);
    const body = CI.slice(at).split('\n');
    const run = body.findIndex((l) => /^\s+run: \|\s*$/.test(l));
    const indent = /^(\s*)/.exec(body[run + 1])[1].length;
    const lines = [];
    for (const l of body.slice(run + 1)) {
      if (l.trim() !== '' && /^(\s*)/.exec(l)[1].length < indent) break;
      lines.push(l.slice(indent));
    }
    return lines.join('\n');
  })();

  const runWith = (results) => {
    const text = shell.replace(
      /\$\{\{ needs\.([\w-]+)\.result \}\}/g,
      (_, j) => results[j] ?? 'success',
    );
    return spawnSync('bash', ['-c', text], { encoding: 'utf8' });
  };

  it('every job succeeded: green', () => {
    const r = runWith({});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('whole suite green');
  });

  it('a skipped job is red here, naming it, where ci-passed would have passed it', () => {
    const r = runWith({ web: 'skipped' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("whole suite: job 'web' did not succeed (result=skipped)");
  });

  it('a failed and a cancelled job are both named', () => {
    const r = runWith({ core: 'failure', 'runner-platforms': 'cancelled' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('whole suite red: core runner-platforms');
  });

  it('the loop asserts every job the aggregate needs', () => {
    const asserted = [...shell.matchAll(/"([\w-]+):\$\{\{ needs\.([\w-]+)\.result \}\}"/g)];
    expect(asserted.every(([, label, need]) => label === need)).toBe(true);
    const needs = AGGREGATE_NEEDS.exec(CI)[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(asserted.map((m) => m[1]).sort()).toEqual(needs.sort());
  });
});
