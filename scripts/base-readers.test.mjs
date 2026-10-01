import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

/**
 * Every script that reads `baseRevision`, run on a planted checkout for each refusal it can return.
 * A reader that keeps the revision and drops the refusal tells a full clone it is shallow and never
 * names the remedy; that is what each case here goes red on. Each planted repository carries a copy
 * of the readers and of the libraries they import, so a library a reader gains and this list lacks
 * fails every case with a module-not-found, which is loud.
 */
const CARRIED = [
  'test-changed.mjs',
  'conformance-status.mjs',
  'lib/baseline-ratchet.mjs',
  'lib/base-branch.mjs',
  'lib/changed-selection.mjs',
  'lib/prerequisite.mjs',
];

const READERS = ['test-changed.mjs', 'conformance-status.mjs'];

const SEALED_ENV = { PATH: process.env.PATH ?? '', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' };

/** One level-2 axis declaring a direction: what makes `conformance-status` need a base at all. */
const MANIFEST = {
  axes: { form: { level: 2, baseline: { path: '.forge/size-baseline.json', improves: 'down' } } },
};

const made = [];
afterEach(() => {
  while (made.length > 0) rmSync(made.pop(), { recursive: true, force: true });
});

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: SEALED_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A work tree holding the readers, with `commits` commits on `main`. */
function workTree(box, commits) {
  const root = join(box, 'work');
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(root, '.forge'), { recursive: true });
  for (const file of CARRIED) copyFileSync(join(SCRIPTS, file), join(root, 'scripts', file));
  writeFileSync(join(root, '.forge', 'conformance.json'), JSON.stringify(MANIFEST));
  writeFileSync(join(root, '.forge', 'size-baseline.json'), JSON.stringify({ files: {} }));
  git(box, 'init', '-q', '-b', 'main', root);
  git(root, 'config', 'user.email', 'check@example.invalid');
  git(root, 'config', 'user.name', 'check');
  for (let i = 0; i < commits; i += 1) {
    writeFileSync(join(root, 'f.txt'), `commit ${i}`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', `commit ${i}`);
  }
  return root;
}

/**
 * A full clone of a remote whose default was `main` when the clone recorded it and is `dev` now,
 * standing on a feature branch with work of its own.
 */
function staleClone() {
  const box = mkdtempSync(join(tmpdir(), 'base-readers-'));
  made.push(box);
  const root = workTree(box, 3);
  const remote = join(box, 'remote.git');
  git(box, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'main:main', 'main:dev');
  git(root, 'fetch', '-q', 'origin');
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/dev');
  git(root, 'checkout', '-q', '-b', 'ISS-1-feature');
  writeFileSync(join(root, 'g.txt'), 'feature work');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'feature work');
  return { box, root };
}

/** A checkout standing where CI stands on a push to `dev`: `origin/dev` at the pushed head. */
function pushedToDev() {
  const box = mkdtempSync(join(tmpdir(), 'base-readers-'));
  made.push(box);
  const root = workTree(box, 3);
  git(root, 'update-ref', 'refs/remotes/origin/dev', 'HEAD');
  const head = git(root, 'rev-parse', 'HEAD');
  const stranger = git(root, 'commit-tree', `${head}^{tree}`, '-m', 'another history');
  const event = (payload) => {
    const path = join(box, 'event.json');
    if (payload !== undefined) writeFileSync(path, JSON.stringify(payload));
    return { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/dev', GITHUB_EVENT_PATH: path };
  };
  return { box, root, stranger, event };
}

function run(root, reader, env = {}) {
  const r = spawnSync('node', [join(root, 'scripts', reader)], {
    cwd: root,
    encoding: 'utf8',
    env: { ...SEALED_ENV, ...env },
  });
  return { status: r.status, stderr: r.stderr };
}

/** What a reader says when it has only the revision and has lost the reason. */
const SHALLOW = /shallow|single-commit/;

describe.each(READERS)('%s prints the refusal baseRevision returns', (reader) => {
  it('names both branches and set-head for a recorded default the remote contradicts', () => {
    const w = staleClone();
    const r = run(w.root, reader);
    expect(r.stderr).toContain('records `main` as the remote');
    expect(r.stderr).toContain('now names `dev`');
    expect(r.stderr).toContain('git remote set-head origin -a');
    expect(r.stderr).not.toMatch(SHALLOW);
    expect(r.status).toBe(2);
  });

  it('names every source read where no merge target can be derived', () => {
    const w = staleClone();
    git(w.root, 'symbolic-ref', '-d', 'refs/remotes/origin/HEAD');
    const r = run(w.root, reader);
    expect(r.stderr).toContain('no merge target could be derived');
    expect(r.stderr).toContain('$GITHUB_BASE_REF');
    expect(r.stderr).not.toMatch(SHALLOW);
    expect(r.status).toBe(2);
  });

  it('names the fetch for a merge target that resolves to no ref here', () => {
    const w = staleClone();
    const r = run(w.root, reader, { GITHUB_BASE_REF: 'release/9' });
    expect(r.stderr).toContain('`release/9` (from GITHUB_BASE_REF) resolves to no ref here');
    expect(r.stderr).toContain('git fetch origin release/9');
    expect(r.stderr).not.toMatch(SHALLOW);
    expect(r.status).toBe(2);
  });

  it("names the payload's path when a push payload cannot be read", () => {
    const w = pushedToDev();
    const r = run(w.root, reader, w.event(undefined));
    expect(r.stderr).toContain(`${join(w.box, 'event.json')} could not be read`);
    expect(r.stderr).not.toMatch(SHALLOW);
    expect(r.status).toBe(2);
  });

  it('names the field when a push payload names no before', () => {
    const w = pushedToDev();
    const r = run(w.root, reader, w.event({}));
    expect(r.stderr).toContain('names no commit as `before`');
    expect(r.stderr).not.toMatch(SHALLOW);
    expect(r.status).toBe(2);
  });

  it('names the tip when a push moved its branch from one that is not an ancestor', () => {
    const w = pushedToDev();
    const r = run(w.root, reader, w.event({ before: w.stranger }));
    expect(r.stderr).toContain(`moved its branch from ${w.stranger}, which is not an ancestor`);
    expect(r.stderr).toContain('the next ordinary push to this branch carries a `before`');
    expect(r.stderr).not.toContain('single-commit');
    expect(r.status).toBe(2);
  });

  it('calls a checkout single-commit only where HEAD has no parent', () => {
    const box = mkdtempSync(join(tmpdir(), 'base-readers-'));
    made.push(box);
    const root = workTree(box, 1);
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const r = run(root, reader, { GITHUB_BASE_REF: 'main' });
    expect(r.stderr).toContain('HEAD has no parent here');
    expect(r.stderr).not.toContain('no base revision can be taken');
    expect(r.status).toBe(2);
  });
});

describe('conformance-status names the merge target above the refusal', () => {
  it('names the branch a push was made to', () => {
    const w = pushedToDev();
    const r = run(w.root, 'conformance-status.mjs', w.event({}));
    expect(r.stderr).toContain('no revision to compare against for the merge target `dev`');
  });

  it('says the target could not be established where it was refused', () => {
    const w = staleClone();
    const r = run(w.root, 'conformance-status.mjs');
    expect(r.stderr).toContain('for a merge target that could not be established');
  });
});
