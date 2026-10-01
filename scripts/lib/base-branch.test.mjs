import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  baseRef,
  branchSetFaults,
  ciBranches,
  mergeTarget,
  PROVED_STEP,
  unansweredBecause,
} from './base-branch.mjs';

const made = [];
afterEach(() => {
  while (made.length > 0) rmSync(made.pop(), { recursive: true, force: true });
});

const SEALED_ENV = { PATH: process.env.PATH ?? '', LC_ALL: 'C' };

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: SEALED_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A bare origin carrying `branches`, and a clone of the first one. */
function world(...branches) {
  const box = mkdtempSync(join(tmpdir(), 'base-branch-'));
  made.push(box);
  const origin = join(box, 'origin.git');
  git(box, 'init', '--bare', `--initial-branch=${branches[0]}`, origin);

  const seed = join(box, 'seed');
  git(box, 'clone', origin, seed);
  git(seed, 'config', 'user.email', 'check@example.invalid');
  git(seed, 'config', 'user.name', 'check');
  writeFileSync(join(seed, 'f.txt'), 'seed');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'seed');
  for (const b of branches) {
    git(seed, 'push', 'origin', `HEAD:refs/heads/${b}`);
  }
  const work = join(box, 'work');
  git(box, 'clone', '-b', branches[0], origin, work);
  git(work, 'checkout', '-b', 'ISS-1-a-branch');
  return { box, origin, work };
}

/** The environment of a workflow_dispatch run of the work branch, its payload written to disk. */
function dispatch(w, payload) {
  const path = join(w.box, 'event.json');
  writeFileSync(path, JSON.stringify(payload));
  return {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/ISS-1-a-branch',
    GITHUB_EVENT_PATH: path,
  };
}

function forgetDefault(repo) {
  spawnSync('git', ['symbolic-ref', '-d', 'refs/remotes/origin/HEAD'], {
    cwd: repo,
    env: SEALED_ENV,
  });
}

describe('mergeTarget', () => {
  it('takes the pull request base ref over everything the checkout says', () => {
    const w = world('main');
    expect(mergeTarget(w.work, { GITHUB_BASE_REF: 'dev' })).toEqual({
      branch: 'dev',
      source: 'GITHUB_BASE_REF',
    });
  });

  it('reads a base ref written in full', () => {
    const w = world('main');
    expect(mergeTarget(w.work, { GITHUB_BASE_REF: 'refs/heads/release/9' }).branch).toBe(
      'release/9',
    );
  });

  it('takes the pushed branch on a push event', () => {
    const w = world('main');
    const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/dev' };
    expect(mergeTarget(w.work, env)).toEqual({ branch: 'dev', source: 'GITHUB_REF' });
  });

  it('takes the branch a schedule run checked out, as a push does', () => {
    const w = world('main');
    forgetDefault(w.work);
    const env = { GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/dev' };
    expect(mergeTarget(w.work, env)).toEqual({ branch: 'dev', source: 'GITHUB_REF' });
  });

  it('ignores the ref of an event that is neither a push nor a schedule', () => {
    const w = world('main');
    const env = { GITHUB_EVENT_NAME: 'release', GITHUB_REF: 'refs/heads/dev' };
    expect(mergeTarget(w.work, env)).toEqual({ branch: 'main', source: 'origin/HEAD' });
  });

  it("takes a dispatched run's base input, never the branch being run", () => {
    const w = world('main');
    const env = dispatch(w, { inputs: { base: 'dev' } });
    expect(mergeTarget(w.work, env)).toEqual({ branch: 'dev', source: 'inputs.base' });
  });

  it('reads a dispatched base written in full', () => {
    const w = world('main');
    const env = dispatch(w, { inputs: { base: 'refs/heads/release/9' } });
    expect(mergeTarget(w.work, env).branch).toBe('release/9');
  });

  it('refuses a dispatch naming no base rather than answering from origin/HEAD', () => {
    const w = world('main');
    expect(git(w.work, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).toBe('origin/main');
    for (const payload of [{}, { inputs: {} }, { inputs: { base: '  ' } }]) {
      const got = mergeTarget(w.work, dispatch(w, payload));
      expect(got.branch).toBeUndefined();
      expect(got.refusal).toContain('names its merge target in inputs.base');
      expect(got.refusal).toContain('-f base=');
    }
  });

  it('refuses a dispatch whose payload cannot be read, naming the path', () => {
    const w = world('main');
    const missing = join(w.box, 'no-such-event.json');
    const env = { ...dispatch(w, {}), GITHUB_EVENT_PATH: missing };
    expect(mergeTarget(w.work, env).refusal).toContain(missing);
    const unset = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/ISS-1-a' };
    expect(mergeTarget(w.work, unset).refusal).toContain('$GITHUB_EVENT_PATH is unset');
  });

  it('lets a pull request base outrank a dispatch payload', () => {
    const w = world('main');
    const env = { ...dispatch(w, { inputs: { base: 'dev' } }), GITHUB_BASE_REF: 'main' };
    expect(mergeTarget(w.work, env).source).toBe('GITHUB_BASE_REF');
  });

  it('ignores a tag push, which carries a ref that names no branch', () => {
    const w = world('main');
    const env = {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/tags/runner-v0.17.1',
      GITHUB_REF_NAME: 'runner-v0.17.1',
      GITHUB_REF_TYPE: 'tag',
    };
    expect(mergeTarget(w.work, env)).toEqual({ branch: 'main', source: 'origin/HEAD' });
  });

  it('ignores a ref name left in the environment with no event behind it', () => {
    const w = world('main');
    expect(mergeTarget(w.work, { GITHUB_REF_NAME: 'dev' })).toEqual({
      branch: 'main',
      source: 'origin/HEAD',
    });
  });

  it("reads the remote's recorded default when the environment says nothing", () => {
    const w = world('main', 'dev');
    expect(mergeTarget(w.work, {})).toEqual({ branch: 'main', source: 'origin/HEAD' });
  });

  it('follows the recorded default to a branch that is not main', () => {
    const w = world('main', 'dev');
    git(w.origin, 'symbolic-ref', 'HEAD', 'refs/heads/dev');
    git(w.work, 'remote', 'set-head', 'origin', '-a');
    expect(mergeTarget(w.work, {}).branch).toBe('dev');
  });

  it('refuses a recorded default the remote has since moved off, naming both and the refresh', () => {
    // The checkout was cloned while the remote's default was `main`; the remote now names `dev`.
    const w = world('main', 'dev');
    git(w.origin, 'symbolic-ref', 'HEAD', 'refs/heads/dev');
    const got = mergeTarget(w.work, {});
    expect(got.branch).toBeUndefined();
    expect(got.refusal).toContain('records `main`');
    expect(got.refusal).toContain('now names `dev`');
    expect(got.refusal).toContain('git remote set-head origin -a');
    expect(baseRef(w.work, {}).refusal).toContain('now names `dev`');
  });

  it('answers from the record, and says so, where the remote cannot be asked', () => {
    const w = world('main', 'dev');
    git(w.work, 'remote', 'set-url', 'origin', join(w.box, 'gone.git'));
    const said = [];
    const write = process.stderr.write;
    process.stderr.write = (chunk) => said.push(String(chunk)) > 0;
    let got;
    try {
      got = mergeTarget(w.work, {});
    } finally {
      process.stderr.write = write;
    }
    expect(got).toEqual({ branch: 'main', source: 'origin/HEAD' });
    expect(said.join('')).toContain('unconfirmed');
    expect(said.join('')).toContain('git remote set-head origin -a');
  });

  it('says nothing extra where the remote confirms the record', () => {
    const w = world('main', 'dev');
    const said = [];
    const write = process.stderr.write;
    process.stderr.write = (chunk) => said.push(String(chunk)) > 0;
    try {
      expect(mergeTarget(w.work, {})).toEqual({ branch: 'main', source: 'origin/HEAD' });
    } finally {
      process.stderr.write = write;
    }
    expect(said).toEqual([]);
  });

  it('refuses a single-branch checkout rather than inferring from the one branch it holds', () => {
    // `--depth 1 --branch dev` fetches `dev` alone and records no default. That the branch is the
    // only one here does not make it the one this work lands on, and a floor from the wrong one is
    // the migration drizzle skips.
    const w = world('trunk');
    forgetDefault(w.work);
    expect(mergeTarget(w.work, {}).branch).toBeUndefined();
    expect(mergeTarget(w.work, {}).refusal).toContain('no merge target could be derived');
  });

  it('refuses rather than guessing between two branches with no default recorded', () => {
    const w = world('main', 'dev');
    forgetDefault(w.work);
    const got = mergeTarget(w.work, {});
    expect(got.branch).toBeUndefined();
    expect(got.refusal).toContain('GITHUB_BASE_REF');
    expect(got.refusal).toContain('$GITHUB_REF on a push or schedule event');
    expect(got.refusal).toContain('inputs.base');
    expect(got.refusal).toContain('refs/remotes/origin/HEAD');
    expect(got.refusal).toContain('git remote set-head origin -a');
  });

  it('never answers main from a checkout that cannot say so itself', () => {
    const w = world('main', 'dev');
    forgetDefault(w.work);
    expect(mergeTarget(w.work, {}).branch).not.toBe('main');
  });

  it('refuses outside a git checkout, where no rung can answer', () => {
    const box = mkdtempSync(join(tmpdir(), 'base-branch-nogit-'));
    made.push(box);
    expect(mergeTarget(box, {}).refusal).toContain('no merge target could be derived');
  });
});

describe('unansweredBecause: why the remote gave no default', () => {
  // The shape Node's spawnSync returns when its `timeout` kills the child.
  const timedOut = {
    error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    status: null,
    stderr: '',
  };

  it('says a wait that ran out in seconds, not as a spawn error', () => {
    expect(unansweredBecause(timedOut)).toBe('no answer within 10 s');
  });

  it("passes any other spawn error's message through", () => {
    const missing = { error: Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' }) };
    expect(unansweredBecause(missing)).toBe('spawnSync git ENOENT');
  });

  it("names a failed exit by git's first line of stderr", () => {
    const r = { status: 128, stderr: "fatal: 'origin' does not appear\nmore\n" };
    expect(unansweredBecause(r)).toBe("fatal: 'origin' does not appear");
  });

  it('is null for an exit of 0', () => {
    expect(unansweredBecause({ status: 0, stdout: 'ref: refs/heads/dev\tHEAD\n' })).toBeNull();
  });
});

describe('baseRef', () => {
  it('names the remote-tracking ref of the merge target', () => {
    const w = world('main', 'dev');
    expect(baseRef(w.work, { GITHUB_BASE_REF: 'dev' })).toEqual({
      branch: 'dev',
      source: 'GITHUB_BASE_REF',
      ref: 'origin/dev',
    });
  });

  it('refuses by name when the merge target resolves to no ref here', () => {
    const w = world('main');
    const got = baseRef(w.work, { GITHUB_BASE_REF: 'dev' });
    expect(got.ref).toBeUndefined();
    expect(got.summary).toBe(
      'the merge target `dev` (from GITHUB_BASE_REF) resolves to no ref here',
    );
    expect(got.refusal).toContain('`dev`');
    expect(got.refusal).toContain('origin/dev');
    expect(got.refusal).toContain('refs/remotes/origin/dev');
    expect(got.refusal).toContain('git fetch origin dev');
  });

  it('carries the merge target refusal through rather than inventing a ref', () => {
    const w = world('main', 'dev');
    forgetDefault(w.work);
    expect(baseRef(w.work, {}).refusal).toContain('no merge target could be derived');
    expect(baseRef(w.work, {}).summary).toBe(
      'no merge target could be derived, so there is no branch to measure this change against',
    );
  });
});

const WORKFLOW = (push, pull, proved) => `name: CI

on:
  push:
    branches: [${push}]
  pull_request:
    branches: [${pull}]

jobs:
  changes:
    steps:
      - uses: actions/checkout@v7
      - name: ${PROVED_STEP}
        id: proved
        run: |
          proved=false
          case "\${{ github.ref }}" in
            ${proved}) proved=true ;;
          esac
      - name: next
        uses: dorny/paths-filter@v4
`;

describe('ciBranches', () => {
  it('reads all three lists out of one workflow', () => {
    const text = WORKFLOW('main, dev', 'main, dev', 'refs/heads/main|refs/heads/dev');
    expect(ciBranches(text)).toEqual({
      push: ['main', 'dev'],
      pullRequest: ['main', 'dev'],
      proved: ['main', 'dev'],
    });
  });

  it('reads a trigger written as a block list', () => {
    const text = `name: CI

on:
  push:
    branches:
      - main
      - dev
  pull_request:
    branches: [main]

jobs: {}
`;
    expect(ciBranches(text).push).toEqual(['main', 'dev']);
  });

  it('stops at the next step rather than reading the whole file', () => {
    const text = `${WORKFLOW('main', 'main', 'refs/heads/main')}      - run: echo refs/heads/elsewhere\n`;
    expect(ciBranches(text).proved).toEqual(['main']);
  });
});

describe('branchSetFaults', () => {
  it('is empty when the three lists name the same set, in any order', () => {
    const text = WORKFLOW('main, dev', 'dev, main', 'refs/heads/dev|refs/heads/main');
    expect(branchSetFaults(text)).toEqual([]);
  });

  it('names all three lists when one of them is short', () => {
    const text = WORKFLOW('main, dev', 'main', 'refs/heads/main|refs/heads/dev');
    const faults = branchSetFaults(text);
    expect(faults).toContain('on.push.branches: dev,main');
    expect(faults).toContain('on.pull_request.branches: main');
    expect(faults).toContain(`the \`${PROVED_STEP}\` step: dev,main`);
  });

  it('refuses three agreeing lists that leave the merge target out', () => {
    const text = WORKFLOW('main', 'main', 'refs/heads/main');
    expect(branchSetFaults(text, 'main')).toEqual([]);
    expect(branchSetFaults(text, 'dev')).toEqual([
      'all three name main, and the merge target `dev` is not among them',
    ]);
  });

  it('names a list it could not find at all', () => {
    const text = WORKFLOW('main', 'main', 'refs/heads/main').replace(PROVED_STEP, 'renamed step');
    expect(branchSetFaults(text)).toEqual([`the \`${PROVED_STEP}\` step: not found`]);
  });
});
