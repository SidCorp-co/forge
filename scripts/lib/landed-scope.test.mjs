// @gate-input whole-tree — it runs `git status` in a fixture repository, which the guard counts as the root
// @direct-test-of scripts/check-migration-order.mjs
// @direct-test-of scripts/check-runner-gates.mjs
// @direct-test-of scripts/lib/migration-order.mjs
//
// A landed merge check measures what landed (REQ-36 BC-9; ISS-472 round 3). On a push to dev the
// branch's tip IS the landing, so a delta-scoped gate taking its merge-base with `origin/dev` measured
// HEAD..HEAD: dev push run 37967422844 landed ten runner files and reported 0 crate files, and run
// 37955058837 landed migration 0480 and reported 0 migrations landing. `merge-check --since` now hands
// verify the landing's base (`FORGE_LANDED_SINCE`), and this file runs that shape over a fixture: a
// clone standing on dev's tip whose last push added a migration and changed a crate file.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseRef, LANDED_SINCE } from './base-branch.mjs';
import { verifyCommand, verifyEnv } from './merge-check.mjs';
import { crateScope } from './runner-gates-scope.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_ORDER = join(HERE, '..', 'check-migration-order.mjs');
const JOURNAL = 'packages/core/drizzle/migrations/meta/_journal.json';
const CRATE_FILE = 'packages/runner/crates/runner-core/src/lib.rs';

const AUTHOR = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...AUTHOR } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

const DAY = 86_400_000;
const entry = (idx) => ({
  idx,
  version: '7',
  when: 1_800_000_000_000 + idx * DAY,
  tag: `000${idx}_m${idx}`,
  breakpoints: true,
});
const journalDoc = (n) => ({
  version: '7',
  dialect: 'postgresql',
  entries: Array.from({ length: n }, (_, i) => entry(i)),
});
const journal = (n) => `${JSON.stringify(journalDoc(n), null, 2)}\n`;

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

let dir = '';
let seed = '';
let clone = '';
/** The tip dev stood on before the landing push: the push payload's `before`. */
let before = '';
/** A commit on another branch, which no landing on dev was made on. */
let stray = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'landed-scope-'));
  seed = join(dir, 'seed');
  const remote = join(dir, 'remote.git');
  git(dir, 'init', '-q', '-b', 'dev', seed);
  write(seed, JOURNAL, journal(1));
  write(seed, CRATE_FILE, 'pub fn a() {}\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'base');
  before = git(seed, 'rev-parse', 'HEAD');
  git(dir, 'init', '-q', '--bare', '-b', 'dev', remote);
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'dev');

  git(seed, 'checkout', '-q', '-b', 'stray');
  write(seed, 'stray.txt', 'x\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'stray');
  stray = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'checkout', '-q', 'dev');

  // The landing: one migration and one crate file, pushed to dev as a fast-forward.
  write(seed, JOURNAL, journal(2));
  write(seed, 'packages/core/drizzle/migrations/0001_m1.sql', 'select 1;\n');
  write(seed, CRATE_FILE, 'pub fn a() {}\npub fn b() {}\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'landing');
  git(seed, 'push', '-q', 'origin', 'dev');

  // CI's checkout of the push: the landed commit, detached, with origin/dev on it.
  clone = join(dir, 'clone');
  git(dir, 'clone', '-q', remote, clone);
  git(clone, 'checkout', '-q', '--detach', 'origin/dev');
  git(clone, 'fetch', '-q', join(dir, 'seed'), 'stray');

  // Dev moves on before the push run reads the remote: a later landing adds the next migration.
  write(seed, JOURNAL, journal(3));
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'a later landing');
  git(seed, 'push', '-q', 'origin', 'dev');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The environment a check runs under: the caller's, without any CI event leaking in. */
function envOf(extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GITHUB_')) delete env[k];
  delete env[LANDED_SINCE];
  return { ...env, ...extra };
}

function migrationOrder(env) {
  const r = spawnSync(process.execPath, [MIGRATION_ORDER], { cwd: clone, encoding: 'utf8', env });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('a landed merge check scopes verify over the landing (ISS-472 round 3)', () => {
  it('reproduces the empty scope a push run had, where verify is given the branch alone', () => {
    const env = envOf({ GITHUB_BASE_REF: 'dev' });
    expect(crateScope(clone, env)).toEqual({ files: new Set() });
    const r = migrationOrder(env);
    expect([r.status, r.out]).toEqual([
      0,
      expect.stringMatching(/^migration-order: 0 migration\(s\) landing/m),
    ]);
  });

  it('hands verify the landing base, so the cargo gates see the crate file the push landed', () => {
    const env = envOf(verifyEnv({ branch: 'dev', since: before, env: {} }));
    expect(env[LANDED_SINCE]).toBe(before);
    expect(crateScope(clone, env)).toEqual({ files: new Set([CRATE_FILE]) });
  });

  it('and migration-order sees the migration it landed, not dev moving on as a sibling', () => {
    const r = migrationOrder(envOf(verifyEnv({ branch: 'dev', since: before, env: {} })));
    // dev itself, moved on past the landing, is the landing's own branch and not an open one.
    expect(r.out).toMatch(/^migration-order: 1 migration\(s\) landing, 0 open branch\(es\) read/m);
    expect(r.out).not.toContain('origin/dev:');
    expect(r.out).not.toMatch(/refusal/);
    expect(r.status).toBe(0);
  });

  it('the base is the landing base, named as one, on the branch it landed on', () => {
    expect(baseRef(clone, envOf({ GITHUB_BASE_REF: 'dev', [LANDED_SINCE]: before }))).toEqual({
      branch: 'dev',
      source: 'GITHUB_BASE_REF',
      ref: before,
      landedSince: before,
    });
  });

  it('refuses a landing base that is no commit, or not under HEAD, by name', () => {
    const none = baseRef(clone, envOf({ GITHUB_BASE_REF: 'dev', [LANDED_SINCE]: 'f'.repeat(40) }));
    expect(none.summary).toBe(`${LANDED_SINCE}=${'f'.repeat(40)} names no commit in this checkout`);
    const off = baseRef(clone, envOf({ GITHUB_BASE_REF: 'dev', [LANDED_SINCE]: stray }));
    expect(off.summary).toContain('is not an ancestor of HEAD');
    expect(
      crateScope(clone, envOf({ GITHUB_BASE_REF: 'dev', [LANDED_SINCE]: stray })).refusal,
    ).toContain(LANDED_SINCE);
  });

  it('a pre-merge run carries no landing base, even one its caller inherited', () => {
    const env = verifyEnv({
      branch: 'dev',
      since: null,
      env: { [LANDED_SINCE]: before, PATH: 'p' },
    });
    expect(env).toEqual({ GITHUB_BASE_REF: 'dev', PATH: 'p' });
    expect(verifyCommand({ branch: 'dev', since: null })).toBe('GITHUB_BASE_REF=dev pnpm verify');
    expect(verifyCommand({ branch: 'dev', since: before })).toBe(
      `${LANDED_SINCE}=${before} GITHUB_BASE_REF=dev pnpm verify`,
    );
  });

  it('the merge check runs verify under that environment, with the landing base on --since', () => {
    const cli = readFileSync(join(HERE, '..', 'merge-check.mjs'), 'utf8');
    expect(cli).toContain('const landedSince = since ? baseSha : null;');
    expect(cli).toContain('env: verifyEnv({ branch, since: landedSince, env: process.env })');
    expect(cli).toContain('command: verifyCommand({ branch, since: landedSince })');
  });
});
