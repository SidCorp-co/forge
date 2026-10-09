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

const STUB = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_STUB_LOG, JSON.stringify(args) + '\\n');
const plan = JSON.parse(fs.readFileSync(process.env.GH_STUB, 'utf8'));
if (args[0] !== 'api') process.exit(64);
const post = args.includes('POST');
const path = args.find((a) => a.startsWith('repos/'));
if (plan.unreadable) { process.stderr.write('HTTP 401: Bad credentials'); process.exit(1); }
if (post) process.exit(plan.dispatchFails ? 1 : 0);
let m;
if ((m = /commits\\/([0-9a-f]+)\\/check-runs/.exec(path))) {
  console.log(JSON.stringify({ check_runs: plan.checkRuns?.[m[1]] ?? [] }));
} else if ((m = /workflows\\/ci\\.yml\\/runs\\?head_sha=([0-9a-f]+)/.exec(path))) {
  console.log(JSON.stringify({ workflow_runs: plan.runs?.[m[1]] ?? [] }));
} else if ((m = /actions\\/runs\\/(\\d+)\\/jobs/.exec(path))) {
  console.log(JSON.stringify({ jobs: plan.jobs?.[m[1]] ?? [] }));
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
  writeFileSync(log, '');
  const env = {
    PATH: `${repo.bin}:${dirname(process.execPath)}:${process.env.PATH}`,
    GH_STUB: stub,
    GH_STUB_LOG: log,
    GITHUB_REPOSITORY: 'acme/forge',
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

function cut(repo, env) {
  return sh(
    repo.work,
    'bash',
    ['scripts/cut-release.sh', '0.4.0-dev.2', '--headline', 'H', '--no-push'],
    env,
  );
}

const dispatches = (calls) => calls.filter((a) => a.includes('POST'));
const versionOf = (repo) =>
  JSON.parse(readFileSync(join(repo.work, 'package.json'), 'utf8')).version;

describe('cut-release.sh refuses a cut whose commit has no green whole-suite run', () => {
  it('no run on the commit: refused by name, one whole-suite run started on the branch, nothing cut', () => {
    const repo = repository();
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const { env, calls } = withStub(repo, {});
    const r = cut(repo, env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      `RELEASE_SUITE_NOT_GREEN: ${head.slice(0, 9)} has no whole-suite run`,
    );
    expect(r.stderr).toContain('Started the whole suite on dev');
    const sent = dispatches(calls());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(
      expect.arrayContaining([
        'repos/acme/forge/actions/workflows/ci.yml/dispatches',
        'ref=dev',
        'inputs[base]=dev',
        'inputs[suite]=whole',
      ]),
    );
    expect(versionOf(repo)).toBe('0.4.0-dev.1');
    expect(git(repo.work, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('a run still in flight on the commit: refused, and no second run is started', () => {
    const repo = repository();
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const { env, calls } = withStub(repo, {
      runs: {
        [head]: [
          {
            id: 5,
            event: 'workflow_dispatch',
            status: 'in_progress',
            html_url: 'https://github.com/acme/forge/actions/runs/5',
          },
        ],
      },
    });
    const r = cut(repo, env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('RELEASE_SUITE_NOT_GREEN: a CI run is still running');
    expect(r.stderr).toContain('actions/runs/5');
    expect(dispatches(calls())).toHaveLength(0);
    expect(versionOf(repo)).toBe('0.4.0-dev.1');
  });

  it('a red whole-suite run on the commit: refused naming the failing jobs, nothing started', () => {
    const repo = repository();
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const { env, calls } = withStub(repo, {
      checkRuns: { [head]: [check('whole-suite', 'completed', 'failure', 7, 901)] },
      jobs: {
        901: [
          { name: 'core', conclusion: 'success' },
          { name: 'web', conclusion: 'failure' },
          { name: 'runner-platforms (windows-latest)', conclusion: 'skipped' },
          { name: 'whole-suite', conclusion: 'failure' },
        ],
      },
    });
    const r = cut(repo, env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('RELEASE_SUITE_NOT_GREEN: the whole suite is red');
    expect(r.stderr).toContain('web (failure), runner-platforms (windows-latest) (skipped)');
    expect(r.stderr).not.toContain('whole-suite (failure)');
    expect(dispatches(calls())).toHaveLength(0);
    expect(versionOf(repo)).toBe('0.4.0-dev.1');
  });

  it('GitHub cannot be read: refused, never read as no run and never as green', () => {
    const repo = repository();
    const { env, calls } = withStub(repo, { unreadable: true });
    const r = cut(repo, env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Bad credentials');
    expect(dispatches(calls())).toHaveLength(0);
    expect(versionOf(repo)).toBe('0.4.0-dev.1');
  });

  it('a green whole-suite run on the commit: the cut proceeds and writes the release commit', () => {
    const repo = repository();
    const head = git(repo.work, 'rev-parse', 'HEAD');
    const { env, calls } = withStub(repo, {
      checkRuns: { [head]: [check('whole-suite', 'completed', 'success', 8, 902)] },
    });
    const r = cut(repo, env);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`whole suite green on ${head.slice(0, 9)}`);
    expect(versionOf(repo)).toBe('0.4.0-dev.2');
    expect(git(repo.work, 'log', '-1', '--format=%s')).toBe('Release dev-v0.4.0-dev.2');
    expect(dispatches(calls())).toHaveLength(0);
  });
});

describe('a red whole-suite run names the merge that broke it', () => {
  /** base ← merge of iss-1 ← merge of iss-2 ← merge of iss-3, each `--no-ff`, newest last. */
  function landings(repo) {
    const shas = [git(repo.work, 'rev-parse', 'HEAD')];
    for (const n of [1, 2, 3]) {
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
