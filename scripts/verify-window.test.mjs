import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), 'verify-window.mjs');
const DAY = 86_400_000;
const W = 1_800_000_000_000;
const DIR = 'db/migrations';
const JOURNAL = `${DIR}/meta/_journal.json`;
const SEALED_ENV = { PATH: process.env.PATH ?? '', LC_ALL: 'C', HOME: tmpdir() };

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: SEALED_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

function put(repo, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(
      join(repo, path),
      typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`,
    );
  }
}

const entry = (idx, when, tag) => ({ idx, version: '7', when, tag, breakpoints: true });
const journal = (...entries) => ({ version: '7', dialect: 'postgresql', entries });
const table = (name, columns, extra = {}) => ({
  name,
  schema: '',
  columns: Object.fromEntries(
    columns.map((c) => [c, { name: c, type: 'text', primaryKey: false, notNull: false }]),
  ),
  indexes: {},
  foreignKeys: {},
  ...extra,
});
const snapshot = (id, prevId, tables) => ({
  id,
  prevId,
  version: '7',
  dialect: 'postgresql',
  tables,
  enums: {},
  schemas: {},
  sequences: {},
  roles: {},
  policies: {},
  views: {},
  _meta: { columns: {}, schemas: {}, tables: {} },
});
const BASE_TABLES = { 'public.a': table('a', ['id', 'name']) };

const CONFIG = {
  check: 'ci-passed',
  migrations: { dir: DIR },
  union: [{ path: 'CHANGELOG.md', reason: 'both entries are meant to stand' }],
  ineligible: {
    paths: [{ glob: 'runner/**', reason: 'runs on three platforms' }],
    linesIn: ['**/*.mjs'],
    lines: [{ pattern: 'process\\.env\\.PATH\\b', reason: 'PATH is read by every child process' }],
  },
};

let box;
let seed;

/** A branch cut from `main` carrying `files`, pushed; its head. */
function branch(name, files, from = 'main') {
  git(seed, 'checkout', '-q', '-B', name, `origin/${from}`);
  put(seed, files);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', name);
  git(seed, 'push', '-q', 'origin', `HEAD:refs/heads/${name}`);
  return git(seed, 'rev-parse', 'HEAD');
}

function run(clone, ...args) {
  return spawnSync('node', [CLI, ...args], { cwd: clone, encoding: 'utf8', env: SEALED_ENV });
}

function clone(name) {
  const dir = join(box, name);
  git(box, 'clone', '-q', join(box, 'origin.git'), dir);
  git(dir, 'config', 'user.email', 'w@example.invalid');
  git(dir, 'config', 'user.name', 'window');
  return dir;
}

function windowFiles(name, members, checks) {
  const manifest = join(box, `${name}.json`);
  writeFileSync(
    manifest,
    JSON.stringify({
      window: name,
      base: 'main',
      thresholds: { size: 10, minutes: 360, source: 'fixture' },
      members: members.map(([issue, br, head]) => ({
        issue,
        branch: br,
        head,
        arrivedAt: '2026-09-29T00:00:00Z',
      })),
    }),
  );
  const checksFile = join(box, `${name}.checks.json`);
  writeFileSync(checksFile, JSON.stringify(checks));
  return {
    manifest,
    checksFile,
    ledger: join(box, `${name}.ledger.json`),
    tree: join(box, `${name}-tree`),
  };
}

const heads = {};

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'verify-window-'));
  git(box, 'init', '-q', '--bare', '--initial-branch=main', join(box, 'origin.git'));
  seed = clone('seed');
  put(seed, {
    '.forge/verify-queue.json': CONFIG,
    [JOURNAL]: journal(entry(1, W, '0001_init')),
    [`${DIR}/0001_init.sql`]: 'CREATE TABLE a (id text, name text);\n',
    [`${DIR}/meta/0001_snapshot.json`]: snapshot('s1', '00000000', BASE_TABLES),
    'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n- base entry\n',
    'src/shared.txt': 'one\ntwo\n',
  });
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'base');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(seed, 'fetch', '-q', 'origin');

  const withTable = (name) => ({ ...BASE_TABLES, [`public.${name}`]: table(name, ['id']) });
  const migration = (tag, id, tables) => ({
    [JOURNAL]: journal(entry(1, W, '0001_init'), entry(2, W + DAY, tag)),
    [`${DIR}/${tag}.sql`]: `-- ${tag}\n`,
    [`${DIR}/meta/0002_snapshot.json`]: snapshot(id, 's1', tables),
  });
  const changelog = (line) => ({
    'CHANGELOG.md': `# Changelog\n\n## [Unreleased]\n\n- ${line}\n- base entry\n`,
  });
  heads.m1 = branch('ISS-1-b', {
    ...migration('0002_add_b', 's-b', withTable('b')),
    ...changelog('one entry'),
    'src/shared.txt': 'one\nTWO by m1\n',
  });
  heads.m2 = branch('ISS-2-c', {
    ...migration('0002_add_c', 's-c', withTable('c')),
    ...changelog('two entry'),
    'src/m2.txt': 'reads 0002_add_c\n',
  });
  heads.m3 = branch('ISS-3-shared', { 'src/shared.txt': 'one\nTWO by m3\n' });
  heads.m4 = branch('ISS-4-after', { 'src/m4.txt': 'after the isolated one\n' });
  heads.path = branch('ISS-5-runner', { 'runner/main.rs': 'fn main() {}\n' });
  heads.line = branch('ISS-6-env', { 'src/env.mjs': "process.env.PATH = '/x';\n" });
  heads.red = branch('ISS-7-red', { 'src/red.txt': 'red\n' });
  heads.other = branch('other-open', {
    [JOURNAL]: journal(entry(1, W, '0001_init'), entry(3, W + 2 * DAY, '0003_other')),
    [`${DIR}/0003_other.sql`]: '-- other\n',
  });
  const indexed = {
    'public.a': table('a', ['id', 'name'], {
      indexes: { a_name: { name: 'a_name', columns: [{ expression: 'name' }] } },
    }),
  };
  heads.idx = branch('ISS-8-index', migration('0002_index_name', 's-i', indexed));
  heads.drop = branch(
    'ISS-9-drop',
    migration('0002_drop_name', 's-d', { 'public.a': table('a', ['id']) }),
  );
  heads.edit = branch('ISS-11-edit', {
    [JOURNAL]: journal({ ...entry(1, W, '0001_init'), breakpoints: false }),
  });
  git(seed, 'push', '-q', 'origin', '--delete', 'other-open');
});

afterAll(() => rmSync(box, { recursive: true, force: true }));

const green = (...shas) => Object.fromEntries(shas.map((s) => [s, { 'ci-passed': 'success' }]));

describe('admit', () => {
  it('refuses a path, a line, a moved head and a red check, and admits the rest', () => {
    const c = clone('admit');
    const w = windowFiles(
      'admit-w',
      [
        ['ISS-4', 'ISS-4-after', heads.m4],
        ['ISS-5', 'ISS-5-runner', heads.path],
        ['ISS-6', 'ISS-6-env', heads.line],
        ['ISS-7', 'ISS-7-red', heads.red],
        ['ISS-3', 'ISS-3-shared', heads.m4],
      ],
      { ...green(heads.m4, heads.path, heads.line), [heads.red]: { 'ci-passed': 'failure' } },
    );
    const r = run(c, 'admit', '--window', w.manifest, '--checks', w.checksFile);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^admitted {2}ISS-4$/m);
    expect(r.stdout).toContain(
      'ISS-5 touches runner/main.rs, which `runner/**` declares ineligible: runs on three platforms',
    );
    expect(r.stdout).toMatch(
      /ISS-6 adds src\/env\.mjs:1 `process\.env\.PATH = '\/x';`.*PATH is read by every child process/,
    );
    expect(r.stdout).toContain(`ISS-7's ci-passed at ${heads.red} is failure`);
    expect(r.stdout).toContain(
      `ISS-3's branch ISS-3-shared is at ${heads.m3} and the window recorded ${heads.m4}`,
    );
  });

  it('judges by the declarations at the base, not by a member that loosens them', () => {
    const loosened = branch('ISS-10-loosen', {
      '.forge/verify-queue.json': { ...CONFIG, ineligible: { paths: [], lines: [] } },
      'runner/x.rs': 'fn x() {}\n',
    });
    const c = clone('admit-loosen');
    const w = windowFiles('loosen-w', [['ISS-10', 'ISS-10-loosen', loosened]], green(loosened));
    const r = run(c, 'admit', '--window', w.manifest, '--checks', w.checksFile);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('ISS-10 touches runner/x.rs');
  });
});

describe('assemble, attribute, isolate and land', () => {
  let c;
  let w;
  let ledger;
  beforeAll(() => {
    git(seed, 'push', '-q', 'origin', `${heads.other}:refs/heads/other-open`);
    c = clone('main-window');
    w = windowFiles(
      'w1',
      [
        ['ISS-1', 'ISS-1-b', heads.m1],
        ['ISS-2', 'ISS-2-c', heads.m2],
        ['ISS-3', 'ISS-3-shared', heads.m3],
        ['ISS-4', 'ISS-4-after', heads.m4],
      ],
      green(heads.m1, heads.m2, heads.m3, heads.m4),
    );
    const r = run(
      c,
      'assemble',
      '--window',
      w.manifest,
      '--checks',
      w.checksFile,
      '--tree',
      w.tree,
    );
    expect(r.status, r.stderr).toBe(1);
    ledger = JSON.parse(readFileSync(w.ledger, 'utf8'));
  });
  afterAll(() => git(seed, 'push', '-q', 'origin', '--delete', 'other-open'));

  const row = (issue) => ledger.members.find((m) => m.issue === issue);
  const at = (rev, path) =>
    spawnSync('git', ['show', `${rev}:${path}`], { cwd: w.tree, encoding: 'utf8' }).stdout;

  it('builds one merge commit per entering member whose second parent is its reviewed head', () => {
    for (const issue of ['ISS-1', 'ISS-2', 'ISS-4']) {
      const m = row(issue);
      expect(git(w.tree, 'rev-parse', `${m.landing}^2`)).toBe(m.head);
    }
    expect(git(w.tree, 'rev-parse', `${row('ISS-4').landing}^1`)).toBe(row('ISS-2').landing);
    expect(ledger.chain.head).toBe(row('ISS-4').landing);
  });

  it('isolates a same-path conflict naming the earlier member, and lets the next one in', () => {
    expect(row('ISS-3').landing).toBeNull();
    expect(row('ISS-3').isolated.because).toBe(
      'ISS-3 conflicts on src/shared.txt (changed earlier in this window by ISS-1); the later admission owns a same-path refusal',
    );
    expect(row('ISS-4').landing).toMatch(/^[0-9a-f]{40}$/);
  });

  it('renumbers the first member above a non-member branch, and the next above it', () => {
    const entries = JSON.parse(at(ledger.chain.head, JOURNAL)).entries;
    expect(entries.map((e) => [e.idx, e.when, e.tag])).toEqual([
      [1, W, '0001_init'],
      [4, W + 3 * DAY, '0004_add_b'],
      [5, W + 4 * DAY, '0005_add_c'],
    ]);
    expect(ledger.openBranches).toContain('origin/other-open');
  });

  it('renames the files and rewrites every reference to the old tag', () => {
    expect(at(ledger.chain.head, `${DIR}/0005_add_c.sql`)).toBe(
      '-- 0002_add_c\n'.replace('0002', '0005'),
    );
    expect(at(ledger.chain.head, 'src/m2.txt')).toBe('reads 0005_add_c\n');
    expect(row('ISS-2').rewrites).toEqual([`${DIR}/0005_add_c.sql`, 'src/m2.txt']);
    expect(at(ledger.chain.head, `${DIR}/0002_add_c.sql`)).toBe('');
  });

  it("chains the rebased snapshot off the combination's head and keeps every member's tables", () => {
    const s4 = JSON.parse(at(ledger.chain.head, `${DIR}/meta/0004_snapshot.json`));
    const s5 = JSON.parse(at(ledger.chain.head, `${DIR}/meta/0005_snapshot.json`));
    expect(s4.id).toBe('s-b');
    expect([s5.id, s5.prevId]).toEqual(['s-c', 's-b']);
    expect(Object.keys(s5.tables).sort()).toEqual(['public.a', 'public.b', 'public.c']);
  });

  it('keeps both members’ CHANGELOG entries', () => {
    const log = at(ledger.chain.head, 'CHANGELOG.md');
    expect(log).toContain('- one entry');
    expect(log).toContain('- two entry');
    expect(log).not.toMatch(/^[<=>]{7}/m);
  });

  it('writes the order, the base and the thresholds to the ledger', () => {
    expect(ledger.members.map((m) => m.issue)).toEqual(['ISS-1', 'ISS-2', 'ISS-3', 'ISS-4']);
    expect(ledger.base.sha).toBe(git(c, 'rev-parse', 'origin/main'));
    expect(ledger.thresholds.source).toBe('fixture');
    expect(row('ISS-2').renumbered[0].to.tag).toBe('0005_add_c');
    expect(readFileSync(w.ledger.replace(/\.json$/, '.md'), 'utf8')).toContain(
      '- ISS-3 isolated (assembly)',
    );
  });

  it('attributes a path refusal to the last landing that changed it', () => {
    const r = run(
      c,
      'attribute',
      '--window',
      w.manifest,
      '--checks',
      w.checksFile,
      '--tree',
      w.tree,
      '--path',
      'src/m4.txt',
    );
    expect(r.stdout).toMatch(/^src\/m4\.txt: member — ISS-4\./m);
  });

  it.each([
    ['false', /pre-existing/],
    ['test ! -f src/m2.txt', /member — ISS-2\./],
    ['! ( test -f src/m2.txt && test -f src/m4.txt )', /interaction/],
  ])('classifies a replay of `%s`', (cmd, want) => {
    const r = run(
      c,
      'attribute',
      '--window',
      w.manifest,
      '--checks',
      w.checksFile,
      '--tree',
      w.tree,
      '--unit',
      cmd,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(want);
  });

  it('refuses to land while the chain head is not green, naming its state', () => {
    const r = run(c, 'land', '--window', w.manifest, '--checks', w.checksFile, '--tree', w.tree);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`ci-passed at the chain head ${ledger.chain.head} is absent`);
  });

  it('prints each landing beside its reviewed head and the one merge-commit merge once green', () => {
    writeFileSync(
      w.checksFile,
      JSON.stringify(green(heads.m1, heads.m2, heads.m4, ledger.chain.head)),
    );
    const r = run(c, 'land', '--window', w.manifest, '--checks', w.checksFile, '--tree', w.tree);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`1. ISS-1  landing ${row('ISS-1').landing}  reviewed ${heads.m1}`);
    expect(r.stdout).toContain('gh pr merge chore/verify-window-w1 --merge');
    expect(r.stdout).not.toMatch(/--squash|--rebase/);
  });

  it('leaves a two-parent push when the chain is merged with a merge commit', () => {
    const lander = clone('lander');
    git(lander, 'fetch', '-q', c, ledger.chain.head);
    git(lander, 'merge', '-q', '--no-ff', '-m', 'Merge verify window w1', 'FETCH_HEAD');
    expect(git(lander, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
  });

  it('isolates a named member on request and rebuilds without it', () => {
    const r = run(
      c,
      'isolate',
      '--window',
      w.manifest,
      '--checks',
      w.checksFile,
      '--tree',
      w.tree,
      '--member',
      'ISS-2',
      '--because',
      'core-integration: expected 2 rows, got 3',
    );
    expect(r.status).toBe(1);
    const again = JSON.parse(readFileSync(w.ledger, 'utf8'));
    const m2 = again.members.find((m) => m.issue === 'ISS-2');
    expect(m2).toMatchObject({
      landing: null,
      isolated: { because: 'core-integration: expected 2 rows, got 3', kind: 'refusal' },
    });
    expect(again.members.find((m) => m.issue === 'ISS-4').landing).toMatch(/^[0-9a-f]{40}$/);
    expect(again.attributions.length).toBeGreaterThan(0);
  });

  it('refuses to land once the base has moved, naming both commits', () => {
    const before = git(c, 'rev-parse', 'origin/main');
    const after = branch('main', { 'src/late.txt': 'late\n' });
    const r = run(c, 'land', '--window', w.manifest, '--checks', w.checksFile, '--tree', w.tree);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`origin/main is at ${after} and the window was built on ${before}`);
  });

  it('replays each member on the base the window was built on, not the one the remote moved to', () => {
    branch('main', { 'src/later.txt': 'moved after the window was built\n' });
    const cmd = 'test ! -f src/later.txt';
    const r = run(
      c,
      'attribute',
      '--window',
      w.manifest,
      '--checks',
      w.checksFile,
      '--tree',
      w.tree,
      '--unit',
      cmd,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/did not fail on the replay at all/);
  });
});

describe('a journal entry a member edits rather than adds', () => {
  it('isolates the member instead of dropping its edit', () => {
    const c = clone('edit-window');
    const w = windowFiles('w-edit', [['ISS-11', 'ISS-11-edit', heads.edit]], green(heads.edit));
    const r = run(
      c,
      'assemble',
      '--window',
      w.manifest,
      '--checks',
      w.checksFile,
      '--tree',
      w.tree,
    );
    expect(r.status).toBe(1);
    const ledger = JSON.parse(readFileSync(w.ledger, 'utf8'));
    expect(ledger.members[0].isolated.because).toBe(
      'ISS-11 changes the journal entry 0001_init, which a window keeps as the combination holds it',
    );
  });
});

describe('a snapshot the combination cannot express', () => {
  it('isolates a member dropping a column an earlier member indexed', () => {
    const c = clone('snap-window');
    const w = windowFiles(
      'w-snap',
      [
        ['ISS-8', 'ISS-8-index', heads.idx],
        ['ISS-9', 'ISS-9-drop', heads.drop],
      ],
      green(heads.idx, heads.drop),
    );
    const r = run(
      c,
      'assemble',
      '--window',
      w.manifest,
      '--checks',
      w.checksFile,
      '--tree',
      w.tree,
    );
    expect(r.status).toBe(1);
    const ledger = JSON.parse(readFileSync(w.ledger, 'utf8'));
    expect(ledger.members[0].landing).toMatch(/^[0-9a-f]{40}$/);
    expect(ledger.members[1].isolated.because).toMatch(
      /tables:public\.a is touched by this member and by an earlier member, and this member changes what was in it$/,
    );
    expect(existsSync(join(w.tree, DIR, '0002_drop_name.sql'))).toBe(false);
  });
});
