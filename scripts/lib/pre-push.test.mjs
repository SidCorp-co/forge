// @direct-test-of .githooks/pre-push
// @gate-input whole-tree — it runs .githooks/pre-push under bash, which the guard cannot see
//
// What the pre-push hook says (ISS-472 round 2), run as git would run it in a fixture repository:
// a `test:changed` that could not run says nothing ran, never that a test is red; and the opt-in
// build measures a new branch from the branch it lands on, refusing by name where none resolves,
// never diffing against the working tree and building nothing.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ZERO = '0'.repeat(40);

const AUTHOR = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

/** The environment with no GitHub variable, so the merge target comes from the fixture alone. */
const cleanEnv = (extra) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GITHUB_'))),
  ...AUTHOR,
  ...extra,
});

let dir = '';

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A repository holding the hook, the resolver it calls, and a `test:changed` exiting $FX_EXIT. */
function seedRepo(path, branch) {
  git(dir, 'init', '-q', '-b', branch, path);
  const files = {
    'package.json': JSON.stringify({
      name: 'fx',
      private: true,
      scripts: { 'test:changed': 'node -e "process.exit(Number(process.env.FX_EXIT))"' },
    }),
    'packages/core/package.json': JSON.stringify({
      name: 'fx-core',
      private: true,
      scripts: { build: 'node -e "console.log(\'built fx-core\')"' },
    }),
    'packages/core/a.ts': 'export const a = 1;\n',
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(path, p)), { recursive: true });
    writeFileSync(join(path, p), text);
  }
  for (const p of ['.githooks/pre-push', 'scripts/lib/base-branch.mjs']) {
    mkdirSync(dirname(join(path, p)), { recursive: true });
    copyFileSync(join(ROOT, p), join(path, p));
  }
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'seed');
}

/** Run the hook for one pushed new branch at HEAD, as `git push` would hand it the ref list. */
function prePush(cwd, env) {
  const sha = git(cwd, 'rev-parse', 'HEAD');
  const r = spawnSync('bash', [join(cwd, '.githooks/pre-push')], {
    cwd,
    encoding: 'utf8',
    input: `refs/heads/feat ${sha} refs/heads/feat ${ZERO}\n`,
    env: cleanEnv(env),
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

let lone = '';
let clone = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pre-push-'));
  lone = join(dir, 'lone');
  seedRepo(lone, 'main');
  const seed = join(dir, 'seed');
  seedRepo(seed, 'dev');
  const remote = join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', '-b', 'dev', remote);
  git(seed, 'push', '-q', remote, 'dev');
  clone = join(dir, 'clone');
  git(dir, 'clone', '-q', remote, clone);
  writeFileSync(join(clone, 'packages/core/b.ts'), 'export const b = 2;\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'core change');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('PREPUSH_TEST says what happened', () => {
  it('a test:changed that could not run says nothing ran, not that a test is red', () => {
    const r = prePush(lone, { PREPUSH_TEST: '1', FX_EXIT: '2' });
    expect(r.status).toBe(1);
    expect(r.out).toContain(
      'test:changed could not run (exit 2, the reason is above), so nothing was typechecked or tested',
    );
    expect(r.out).not.toContain('a direct test is red');
  });

  it('a red check says a check is red', () => {
    const r = prePush(lone, { PREPUSH_TEST: '1', FX_EXIT: '1' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('the typecheck or a direct test is red');
  });

  it('a green run lets the push go on', () => {
    const r = prePush(lone, { PREPUSH_TEST: '1', FX_EXIT: '0' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('cheap guards passed');
  });
});

describe('PREPUSH_BUILD measures a new branch from where it lands', () => {
  it('builds what a new branch changed against its merge target, with no local main', () => {
    const r = prePush(clone, { PREPUSH_BUILD: '1' });
    expect([r.status, r.out]).toEqual([0, expect.stringContaining('validating packages: core')]);
    expect(r.out).toContain('built fx-core');
  });

  it('refuses by name where no merge target resolves, building nothing', () => {
    const r = prePush(lone, { PREPUSH_BUILD: '1' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('no merge target could be derived');
    expect(r.out).toContain('PREPUSH_BUILD has no branch to measure the new branch feat against');
    expect(r.out).not.toContain('no file changes');
  });
});
