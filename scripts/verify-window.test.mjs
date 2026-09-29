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
  gate: { prepare: [['node', 'prepare.mjs']], run: ['node', 'gate.mjs'] },
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
    '.gitignore': '.prepared\n.unpreparable\n',
    'prepare.mjs': [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "if (existsSync('.unpreparable')) process.exit(3);",
      "writeFileSync('.prepared', 'yes');",
      '',
    ].join('\n'),
    'gate.mjs': [
      "import { existsSync } from 'node:fs';",
      "if (!existsSync('.prepared')) { console.error('gate-check: not prepared'); process.exit(2); }",
      "if (existsSync('src/fail.txt')) {",
      "  console.error('gate-check: src/fail.txt holds a sweep failure the entry layer cannot see');",
      '  process.exit(1);',
      '}',
      'console.log(`gate-check: 0 red against ${process.env.GITHUB_BASE_REF}`);',
      '',
    ].join('\n'),
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
    ['no-such-checker-anywhere', /undetermined\. it could not run on the base \(exit 127\)/],
    ['exit 2', /undetermined\. it could not run on the base \(exit 2\)/],
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

  it('replays the head the ledger validated, not one the manifest was later edited to', () => {
    const original = readFileSync(w.manifest, 'utf8');
    const edited = JSON.parse(original);
    edited.members.find((m) => m.issue === 'ISS-4').head = heads.line;
    writeFileSync(w.manifest, JSON.stringify(edited));
    try {
      const cmd = 'test ! -f src/env.mjs';
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
    } finally {
      writeFileSync(w.manifest, original);
    }
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
    git(c, 'push', '-q', 'origin', `${ledger.chain.head}:refs/heads/chore/verify-window-w1`);
    const r = run(c, 'land', '--window', w.manifest, '--checks', w.checksFile, '--tree', w.tree);
    git(c, 'push', '-q', 'origin', '--delete', 'chore/verify-window-w1');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`1. ISS-1  landing ${row('ISS-1').landing}  reviewed ${heads.m1}`);
    expect(r.stdout).toContain(
      `gh pr merge chore/verify-window-w1 --merge --match-head-commit ${ledger.chain.head}`,
    );
    expect(r.stdout).not.toMatch(/--squash|--rebase/);
  });

  it('refuses to land a window in which no member has a landing, naming that there is nothing to land', () => {
    const original = readFileSync(w.ledger, 'utf8');
    const checks = readFileSync(w.checksFile, 'utf8');
    const empty = JSON.parse(original);
    for (const m of empty.members) m.landing = null;
    writeFileSync(w.ledger, JSON.stringify(empty));
    writeFileSync(w.checksFile, JSON.stringify(green(ledger.chain.head)));
    git(c, 'push', '-q', 'origin', `${ledger.chain.head}:refs/heads/chore/verify-window-w1`);
    try {
      const r = run(c, 'land', '--window', w.manifest, '--checks', w.checksFile, '--tree', w.tree);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('no member of this window has a landing');
      expect(r.stdout).not.toContain('gh pr merge');
    } finally {
      git(c, 'push', '-q', 'origin', '--delete', 'chore/verify-window-w1');
      writeFileSync(w.ledger, original);
      writeFileSync(w.checksFile, checks);
    }
  });

  it('refuses to land while the window branch is absent, so the plan never names an unpushed chain', () => {
    const r = run(c, 'land', '--window', w.manifest, '--checks', w.checksFile, '--tree', w.tree);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      `origin/chore/verify-window-w1 is at nothing and this ledger's chain head is ${ledger.chain.head}`,
    );
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

  it('refuses to land a rebuilt chain whose window branch still carries the one validated before', () => {
    const rebuilt = JSON.parse(readFileSync(w.ledger, 'utf8')).chain.head;
    expect(rebuilt).not.toBe(ledger.chain.head);
    writeFileSync(w.checksFile, JSON.stringify(green(heads.m1, heads.m4, rebuilt)));
    git(c, 'push', '-q', 'origin', `${ledger.chain.head}:refs/heads/chore/verify-window-w1`);
    const r = run(c, 'land', '--window', w.manifest, '--checks', w.checksFile, '--tree', w.tree);
    git(c, 'push', '-q', 'origin', '--delete', 'chore/verify-window-w1');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      `origin/chore/verify-window-w1 is at ${ledger.chain.head} and this ledger's chain head is ${rebuilt}`,
    );
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

describe('a replay of one member alone', () => {
  it('numbers its migrations against the base and the open set, not against the window it left', () => {
    const dataOnly = (idx, when, tag) => ({
      [JOURNAL]: journal(entry(1, W, '0001_init'), entry(idx, when, tag)),
      [`${DIR}/${tag}.sql`]: `-- ${tag}\n`,
    });
    heads.late = branch('ISS-12-late', dataOnly(2, W + 5 * DAY, '0002_late'));
    heads.early = branch('ISS-13-early', dataOnly(2, W + DAY, '0002_early'));
    const c = clone('replay-window');
    const w = windowFiles(
      'w-replay',
      [
        ['ISS-12', 'ISS-12-late', heads.late],
        ['ISS-13', 'ISS-13-early', heads.early],
      ],
      green(heads.late, heads.early),
    );
    expect(
      run(c, 'assemble', '--window', w.manifest, '--checks', w.checksFile, '--tree', w.tree).status,
    ).toBe(0);
    const ledger = JSON.parse(readFileSync(w.ledger, 'utf8'));
    git(c, 'push', '-q', 'origin', `${ledger.chain.head}:refs/heads/chore/verify-window-w-replay`);
    const inflated = [6, 4]
      .map((d) => `! grep -q '"when": ${W + d * DAY}' ${JOURNAL}`)
      .join(' && ');
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
      inflated,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/did not fail on the replay at all/);
    git(
      seed,
      'push',
      '-q',
      'origin',
      '--delete',
      'ISS-12-late',
      'ISS-13-early',
      'chore/verify-window-w-replay',
    );
  });
});

describe('a member another member already carries', () => {
  it('is isolated by name, and the members after it still enter', () => {
    const a = branch('ISS-14-a', { 'src/a14.txt': 'a\n' });
    const b = branch('ISS-15-b', { 'src/b15.txt': 'b\n' }, 'ISS-14-a');
    const c = clone('carried-window');
    const w = windowFiles(
      'w-carried',
      [
        ['ISS-15', 'ISS-15-b', b],
        ['ISS-14', 'ISS-14-a', a],
        ['ISS-4', 'ISS-4-after', heads.m4],
      ],
      green(a, b, heads.m4),
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
    const ledger = JSON.parse(readFileSync(w.ledger, 'utf8'));
    expect(ledger.members[1].isolated.because).toBe(
      `ISS-14's head ${a} is already in the combination, carried by ISS-15; it lands with that change, not as a landing of its own`,
    );
    expect(ledger.members[2].landing).toMatch(/^[0-9a-f]{40}$/);
    git(seed, 'push', '-q', 'origin', '--delete', 'ISS-14-a', 'ISS-15-b');
  });
});

describe('a member carrying one the window isolated', () => {
  it('is isolated with it, so the isolated change does not come back in', () => {
    const a = branch('ISS-16-a', { 'src/a16.txt': 'a\n' });
    const b = branch('ISS-17-b', { 'src/b17.txt': 'b\n' }, 'ISS-16-a');
    const c = clone('dependent-window');
    const w = windowFiles(
      'w-dependent',
      [
        ['ISS-16', 'ISS-16-a', a],
        ['ISS-17', 'ISS-17-b', b],
        ['ISS-4', 'ISS-4-after', heads.m4],
      ],
      green(a, b, heads.m4),
    );
    expect(
      run(c, 'assemble', '--window', w.manifest, '--checks', w.checksFile, '--tree', w.tree).status,
    ).toBe(0);
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
      'ISS-16',
      '--because',
      'red at the gate',
    );
    expect(r.status, r.stderr).toBe(1);
    const ledger = JSON.parse(readFileSync(w.ledger, 'utf8'));
    expect(ledger.members[1].isolated.because).toBe(
      `ISS-17 carries ISS-16's head ${a}, which is not in this window; merging it would bring that change back in`,
    );
    expect(ledger.members[2].landing).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(w.tree, 'src/a16.txt'))).toBe(false);
    git(seed, 'push', '-q', 'origin', '--delete', 'ISS-16-a', 'ISS-17-b');
  });
});

describe('a member stacked on an earlier member the window renumbered', () => {
  it('enters its own migration once, and rebases its snapshot onto what that member became', () => {
    // ISS-8 and ISS-9 stay open with a 0002 each, so the window numbers from 0003.
    const tables = (...names) =>
      Object.fromEntries([
        ['public.a', BASE_TABLES['public.a']],
        ...names.map((n) => [`public.${n}`, table(n, ['id'])]),
      ]);
    const b = branch(
      'ISS-19-d',
      {
        [JOURNAL]: journal(
          entry(1, W, '0001_init'),
          entry(2, W + DAY, '0002_add_b'),
          entry(3, W + 2 * DAY, '0003_add_d'),
        ),
        [`${DIR}/0003_add_d.sql`]: '-- 0003_add_d\n',
        [`${DIR}/meta/0003_snapshot.json`]: snapshot('s-dd', 's-b', tables('b', 'd')),
      },
      'ISS-1-b',
    );
    const c = clone('stacked-window');
    const w = windowFiles(
      'w-stacked',
      [
        ['ISS-2', 'ISS-2-c', heads.m2],
        ['ISS-1', 'ISS-1-b', heads.m1],
        ['ISS-19', 'ISS-19-d', b],
      ],
      green(heads.m2, heads.m1, b),
    );
    const tree = ['--window', w.manifest, '--checks', w.checksFile, '--tree', w.tree];
    const r = run(c, 'assemble', ...tree);
    git(seed, 'push', '-q', 'origin', '--delete', 'ISS-19-d');
    expect(r.status, r.stderr).toBe(0);
    const head = JSON.parse(readFileSync(w.ledger, 'utf8')).chain.head;
    const at = (path) =>
      spawnSync('git', ['show', `${head}:${path}`], { cwd: w.tree, encoding: 'utf8' });
    expect(JSON.parse(at(JOURNAL).stdout).entries.map((e) => [e.idx, e.tag])).toEqual([
      [1, '0001_init'],
      [3, '0003_add_c'],
      [4, '0004_add_b'],
      [5, '0005_add_d'],
    ]);
    expect(at(`${DIR}/0002_add_b.sql`).status).not.toBe(0);
    expect(at(`${DIR}/0005_add_d.sql`).stdout).toBe('-- 0005_add_d\n');
    const last = JSON.parse(at(`${DIR}/meta/0005_snapshot.json`).stdout);
    expect(last.prevId).toBe('s-b');
    expect(Object.keys(last.tables).sort()).toEqual([
      'public.a',
      'public.b',
      'public.c',
      'public.d',
    ]);
  });
});

describe('a member stacked on a renumbered member, with no migration of its own', () => {
  it("has its reference to that member's old tag rewritten to the tag it landed at", () => {
    const uses = branch('ISS-25-uses', { 'src/uses-b.txt': 'reads 0002_add_b.sql\n' }, 'ISS-1-b');
    const c = clone('stacked-reference');
    const w = windowFiles(
      'w-stacked-ref',
      [
        ['ISS-2', 'ISS-2-c', heads.m2],
        ['ISS-1', 'ISS-1-b', heads.m1],
        ['ISS-25', 'ISS-25-uses', uses],
      ],
      green(heads.m2, heads.m1, uses),
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
    git(seed, 'push', '-q', 'origin', '--delete', 'ISS-25-uses');
    expect(r.status, r.stderr).toBe(0);
    const ledger = JSON.parse(readFileSync(w.ledger, 'utf8'));
    const moved = ledger.members.find((m) => m.issue === 'ISS-1').renumbered;
    const to = moved.find((m) => m.from.tag === '0002_add_b').to.tag;
    expect(to).not.toBe('0002_add_b');
    const text = git(w.tree, 'show', `${ledger.chain.head}:src/uses-b.txt`);
    expect(text).toBe(`reads ${to}.sql`);
    expect(ledger.members.find((m) => m.issue === 'ISS-25').rewrites).toEqual(['src/uses-b.txt']);
  });
});

describe('a renumbered tag named in a union path both members add to', () => {
  it('is rewritten in the unioned file, which keeps both entries and no conflict marker', () => {
    const e = branch('ISS-26-e', {
      [JOURNAL]: journal(entry(1, W, '0001_init'), entry(2, W + DAY, '0002_add_e')),
      [`${DIR}/0002_add_e.sql`]: '-- 0002_add_e\n',
      [`${DIR}/meta/0002_snapshot.json`]: snapshot('s-e', 's1', {
        ...BASE_TABLES,
        'public.e': table('e', ['id']),
      }),
      'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n- adds 0002_add_e\n- base entry\n',
    });
    const c = clone('union-retag');
    const w = windowFiles(
      'w-union-retag',
      [
        ['ISS-1', 'ISS-1-b', heads.m1],
        ['ISS-26', 'ISS-26-e', e],
      ],
      green(heads.m1, e),
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
    git(seed, 'push', '-q', 'origin', '--delete', 'ISS-26-e');
    expect(r.status, r.stderr).toBe(0);
    const ledger = JSON.parse(readFileSync(w.ledger, 'utf8'));
    const to = ledger.members.find((m) => m.issue === 'ISS-26').renumbered[0].to.tag;
    const log = git(w.tree, 'show', `${ledger.chain.head}:CHANGELOG.md`);
    expect(log).not.toMatch(/^[<=>]{7}/m);
    expect(log).toContain('- one entry');
    expect(log).toContain(`- adds ${to}`);
  });
});

describe('a member whose own tag is one the combination already holds', () => {
  it('is isolated before any reference is rewritten, so no tag is moved twice', () => {
    const tagged = (tag, idx, id) =>
      branch(`ISS-${id}-t`, {
        [JOURNAL]: journal(entry(1, W, '0001_init'), entry(idx, W + idx * DAY, tag)),
        [`${DIR}/${tag}.sql`]: `-- ${tag}\n`,
        [`${DIR}/meta/${String(idx).padStart(4, '0')}_snapshot.json`]: snapshot(`s-${id}`, 's1', {
          ...BASE_TABLES,
          [`public.t${id}`]: table(`t${id}`, ['id']),
        }),
      });
    const a = tagged('0002_update', 2, 27);
    const b = tagged('0003_update', 3, 28);
    const c = clone('ambiguous-tag');
    const w = windowFiles(
      'w-ambiguous-tag',
      [
        ['ISS-27', 'ISS-27-t', a],
        ['ISS-28', 'ISS-28-t', b],
      ],
      green(a, b),
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
    git(seed, 'push', '-q', 'origin', '--delete', 'ISS-27-t', 'ISS-28-t');
    const ledger = JSON.parse(readFileSync(w.ledger, 'utf8'));
    const [first, second] = ledger.members;
    expect(first.renumbered[0].to.tag, r.stderr).toBe('0003_update');
    expect(second.landing).toBeNull();
    expect(second.isolated.because).toBe(
      'ISS-28 adds the journal entry 0003_update, which ISS-27 already added in this window; one of them regenerates it under another name',
    );
  });
});

describe('two members adding the same journal entry', () => {
  it("isolates the later one, leaving the earlier one's references alone", () => {
    const adds = (id, name) =>
      branch(`ISS-${id}-same`, {
        [JOURNAL]: journal(entry(1, W, '0001_init'), entry(2, W + DAY, '0002_update')),
        [`${DIR}/0002_update.sql`]: `-- ${name}\n`,
        [`${DIR}/meta/0002_snapshot.json`]: snapshot(`s-${id}`, 's1', {
          ...BASE_TABLES,
          [`public.${name}`]: table(name, ['id']),
        }),
        'CHANGELOG.md': `# Changelog\n\n## [Unreleased]\n\n- ${name} in 0002_update\n- base entry\n`,
      });
    const a = adds(29, 'first');
    const b = adds(30, 'second');
    const c = clone('same-entry');
    const holding = {
      'ISS-1-b': heads.m1,
      'ISS-2-c': heads.m2,
      'ISS-8-index': heads.idx,
      'ISS-9-drop': heads.drop,
    };
    git(c, 'push', '-q', 'origin', '--delete', ...Object.keys(holding));
    const w = windowFiles(
      'w-same-entry',
      [
        ['ISS-29', 'ISS-29-same', a],
        ['ISS-30', 'ISS-30-same', b],
      ],
      green(a, b),
    );
    try {
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
      const ledger = JSON.parse(readFileSync(w.ledger, 'utf8'));
      const [first, second] = ledger.members;
      expect(first.landing, r.stderr).toMatch(/^[0-9a-f]{40}$/);
      expect(first.renumbered, JSON.stringify(ledger.openBranches)).toEqual([]);
      expect(second.landing).toBeNull();
      expect(second.isolated.because).toBe(
        'ISS-30 adds the journal entry 0002_update, which ISS-29 already added in this window; one of them regenerates it under another name',
      );
      expect(git(w.tree, 'show', `${ledger.chain.head}:CHANGELOG.md`)).toContain(
        '- first in 0002_update',
      );
    } finally {
      for (const [name, head] of Object.entries(holding)) {
        git(seed, 'push', '-q', 'origin', `${head}:refs/heads/${name}`);
      }
      git(seed, 'push', '-q', 'origin', '--delete', 'ISS-29-same', 'ISS-30-same');
    }
  });
});

describe('a base carrying no journal where its declarations name the migrations', () => {
  it('is refused by name, never read as a base with no migrations', () => {
    git(seed, 'checkout', '-q', '-B', 'no-journal', 'origin/main');
    git(seed, 'rm', '-q', JOURNAL);
    git(seed, 'commit', '-q', '-m', 'no journal');
    git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/no-journal');
    const c = clone('no-journal-window');
    const w = windowFiles('w-no-journal', [['ISS-4', 'ISS-4-after', heads.m4]], green(heads.m4));
    const manifest = JSON.parse(readFileSync(w.manifest, 'utf8'));
    writeFileSync(w.manifest, JSON.stringify({ ...manifest, base: 'no-journal' }));
    try {
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
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`the base carries no ${JOURNAL}, which its declarations name`);
    } finally {
      git(seed, 'push', '-q', 'origin', '--delete', 'no-journal');
    }
  });
});

describe('the tree isolate rebuilds in', () => {
  it('refuses any tree but the recorded one, and deletes nothing it did not build', () => {
    const c = clone('tree-window');
    const w = windowFiles('w-tree', [['ISS-4', 'ISS-4-after', heads.m4]], green(heads.m4));
    const flags = ['--window', w.manifest, '--checks', w.checksFile];
    expect(run(c, 'assemble', ...flags, '--tree', w.tree).status).toBe(0);
    const unrelated = join(box, 'unrelated');
    put(unrelated, { 'keep.txt': 'still here\n' });
    const other = join(box, 'tree-window-other');
    git(c, 'worktree', 'add', '-q', '--detach', other, 'HEAD');
    const isolate = (tree) =>
      run(c, 'isolate', ...flags, '--tree', tree, '--member', 'ISS-4', '--because', 'red');
    for (const tree of [unrelated, other]) {
      const r = isolate(tree);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`--tree ${tree} is not the tree window w-tree was built in`);
    }
    expect(readFileSync(join(unrelated, 'keep.txt'), 'utf8')).toBe('still here\n');
    expect(existsSync(join(other, '.git'))).toBe(true);
    git(c, 'worktree', 'remove', '--force', w.tree);
    put(w.tree, { 'keep.txt': 'not a worktree any more\n' });
    const r = isolate(w.tree);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`${w.tree} is not a worktree of`);
    expect(readFileSync(join(w.tree, 'keep.txt'), 'utf8')).toBe('not a worktree any more\n');
    expect(JSON.parse(readFileSync(w.manifest, 'utf8')).isolated ?? []).toEqual([]);
  });

  it('refuses a window with no ledger, since nothing then says which tree it built', () => {
    const c = clone('unbuilt-window');
    const w = windowFiles('w-unbuilt', [['ISS-4', 'ISS-4-after', heads.m4]], green(heads.m4));
    const other = join(box, 'unbuilt-window-other');
    git(c, 'worktree', 'add', '-q', '--detach', other, 'HEAD');
    put(other, { 'work.txt': 'uncommitted\n' });
    const manifest = readFileSync(w.manifest, 'utf8');
    const flags = ['--window', w.manifest, '--checks', w.checksFile, '--tree', other];
    const r = run(c, 'isolate', ...flags, '--member', 'ISS-4', '--because', 'red');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`${w.ledger} does not exist: assemble the window first`);
    expect(readFileSync(join(other, 'work.txt'), 'utf8')).toBe('uncommitted\n');
    expect(readFileSync(w.manifest, 'utf8')).toBe(manifest);
  });
});

describe('an isolate whose rebuild fails', () => {
  it('writes neither manifest nor ledger, and the next isolate rebuilds where the ledger recorded', () => {
    const c = clone('failed-rebuild');
    const w = windowFiles('w-failed', [['ISS-4', 'ISS-4-after', heads.m4]], green(heads.m4));
    const flags = ['--window', w.manifest, '--checks', w.checksFile, '--tree', w.tree];
    expect(run(c, 'assemble', ...flags).status).toBe(0);
    const [manifest, ledger] = [w.manifest, w.ledger].map((p) => readFileSync(p, 'utf8'));
    const url = git(c, 'remote', 'get-url', 'origin');
    git(c, 'remote', 'set-url', 'origin', join(box, 'no-such-origin.git'));
    const failed = run(c, 'isolate', ...flags, '--member', 'ISS-4', '--because', 'red');
    expect(failed.status).toBe(2);
    expect(failed.stderr).toContain('git fetch origin did not answer');
    expect(readFileSync(w.manifest, 'utf8')).toBe(manifest);
    expect(readFileSync(w.ledger, 'utf8')).toBe(ledger);
    const gone = run(c, 'attribute', ...flags, '--path', 'src/m4.txt');
    expect(gone.stderr).toContain(`the window's tree ${w.tree} is gone`);
    git(c, 'remote', 'set-url', 'origin', url);
    const again = run(c, 'isolate', ...flags, '--member', 'ISS-4', '--because', 'red');
    expect(again.status, again.stderr).toBe(1);
    expect(JSON.parse(readFileSync(w.ledger, 'utf8')).members[0].isolated.because).toBe('red');
    expect(existsSync(join(w.tree, '.git'))).toBe(true);
  });
});

describe('a journal that is not one', () => {
  it('refuses the window when an open branch outside it carries one, naming the branch', () => {
    branch('open-broken', { [JOURNAL]: '{ not json' });
    const c = clone('broken-open');
    const w = windowFiles('w-broken-open', [['ISS-4', 'ISS-4-after', heads.m4]], green(heads.m4));
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
    git(seed, 'push', '-q', 'origin', '--delete', 'open-broken');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(
      `the journal at origin/open-broken:${JOURNAL} is not readable JSON: `,
    );
    expect(r.stderr).toContain(
      'so the open set is unknown and no migration number can be allocated',
    );
  });

  it('isolates a member carrying one, naming it, and lets the next member in', () => {
    const bad = branch('ISS-21-journal', { [JOURNAL]: { version: '7', entries: 5 } });
    const c = clone('broken-member');
    const w = windowFiles(
      'w-broken-member',
      [
        ['ISS-21', 'ISS-21-journal', bad],
        ['ISS-4', 'ISS-4-after', heads.m4],
      ],
      green(bad, heads.m4),
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
    git(seed, 'push', '-q', 'origin', '--delete', 'ISS-21-journal');
    expect(r.status, r.stderr).toBe(1);
    const ledger = JSON.parse(readFileSync(w.ledger, 'utf8'));
    expect(ledger.members[0].isolated.because).toBe(
      `ISS-21's migrations cannot be entered: the journal at ${bad}:${JOURNAL} carries no \`entries\` array`,
    );
    expect(ledger.members[1].landing).toMatch(/^[0-9a-f]{40}$/);
  });

  it('isolates a member whose journal holds a malformed entry, or whose snapshot is not JSON', () => {
    const nullEntry = branch('ISS-22-null', {
      [JOURNAL]: { version: '7', entries: [entry(1, W, '0001_init'), null] },
    });
    const badSnap = branch('ISS-23-snap', {
      [JOURNAL]: journal(entry(1, W, '0001_init'), entry(2, W + DAY, '0002_snap')),
      [`${DIR}/0002_snap.sql`]: '-- 0002_snap\n',
      [`${DIR}/meta/0002_snapshot.json`]: '{ not json',
    });
    const c = clone('malformed-member');
    const w = windowFiles(
      'w-malformed',
      [
        ['ISS-22', 'ISS-22-null', nullEntry],
        ['ISS-23', 'ISS-23-snap', badSnap],
        ['ISS-4', 'ISS-4-after', heads.m4],
      ],
      green(nullEntry, badSnap, heads.m4),
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
    git(seed, 'push', '-q', 'origin', '--delete', 'ISS-22-null', 'ISS-23-snap');
    expect(r.status, r.stderr).toBe(1);
    const [a, b, d] = JSON.parse(readFileSync(w.ledger, 'utf8')).members;
    expect(a.isolated.because).toBe(
      `ISS-22's migrations cannot be entered: the journal at ${nullEntry}:${JOURNAL} holds an entry without idx, when and tag: null`,
    );
    expect(b.isolated.because).toMatch(
      new RegExp(
        `^ISS-23's migrations cannot be entered: the snapshot at ${badSnap}:${DIR}/meta/0002_snapshot\\.json is not readable JSON: `,
      ),
    );
    expect(d.landing).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('validate', () => {
  it('runs the declared gate once, records its cost, and after isolating the member it names goes green', () => {
    const bad = branch('ISS-24-fail', { 'src/fail.txt': 'red at the sweep\n' });
    const c = clone('validate-window');
    const w = windowFiles(
      'w-validate',
      [
        ['ISS-4', 'ISS-4-after', heads.m4],
        ['ISS-24', 'ISS-24-fail', bad],
      ],
      green(heads.m4, bad),
    );
    const flags = ['--window', w.manifest, '--checks', w.checksFile, '--tree', w.tree];
    expect(run(c, 'assemble', ...flags).status).toBe(0);
    const red = run(c, 'validate', ...flags);
    expect(red.status).toBe(1);
    expect(red.stdout).toContain(
      'gate-check: src/fail.txt holds a sweep failure the entry layer cannot see',
    );
    const owner = run(c, 'attribute', ...flags, '--path', 'src/fail.txt');
    expect(owner.stdout).toContain('ISS-24');
    const replayed = run(c, 'attribute', ...flags, '--unit', 'node gate.mjs');
    expect(replayed.status, replayed.stderr).toBe(0);
    expect(replayed.stdout).toMatch(/^node gate\.mjs: .*ISS-24/m);
    expect(replayed.stdout).not.toMatch(/did not fail on the replay|fails on the base/);
    const words = 'gate-check: src/fail.txt holds a sweep failure the entry layer cannot see';
    expect(run(c, 'isolate', ...flags, '--member', 'ISS-24', '--because', words).status).toBe(1);
    const again = run(c, 'validate', ...flags);
    git(seed, 'push', '-q', 'origin', '--delete', 'ISS-24-fail');
    expect(again.status, again.stdout + again.stderr).toBe(0);
    const ledger = JSON.parse(readFileSync(w.ledger, 'utf8'));
    expect(ledger.passes.map((p) => [p.n, p.status, p.members])).toEqual([
      [1, 1, 2],
      [2, 0, 1],
    ]);
    expect(ledger.passes[1].head).toBe(ledger.chain.head);
    expect(ledger.passes[0].words).toContain('src/fail.txt holds a sweep failure');
    expect(ledger.members[1].isolated.because).toBe(words);
    const md = readFileSync(w.ledger.replace(/\.json$/, '.md'), 'utf8');
    expect(md).toContain(
      '  ```\n  gate-check: src/fail.txt holds a sweep failure the entry layer cannot see\n  ```',
    );
    expect(md).toMatch(
      /Pass 2: `node gate\.mjs` at `[0-9a-f]{40}` took [\d.]+s \(prepare [\d.]+s\), shared by 1 member\(s\), [\d.]+s each: green/,
    );
  });

  it('refuses to replay on a combination tree holding a stray file, and attributes nothing', () => {
    const c = clone('attribute-dirty');
    const w = windowFiles('w-attr-dirty', [['ISS-4', 'ISS-4-after', heads.m4]], green(heads.m4));
    const flags = ['--window', w.manifest, '--checks', w.checksFile, '--tree', w.tree];
    expect(run(c, 'assemble', ...flags).status).toBe(0);
    writeFileSync(join(w.tree, 'src/unrelated.txt'), 'stray\n');
    const r = run(c, 'attribute', ...flags, '--unit', 'test ! -e src/unrelated.txt');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/holds changes the chain head does not/);
    expect(JSON.parse(readFileSync(w.ledger, 'utf8')).attributions ?? []).toEqual([]);
  });

  it("runs the gate against the window's base branch, whatever the operator's environment names", () => {
    const c = clone('validate-base');
    const w = windowFiles('w-validate-base', [['ISS-4', 'ISS-4-after', heads.m4]], green(heads.m4));
    const flags = ['--window', w.manifest, '--checks', w.checksFile, '--tree', w.tree];
    expect(run(c, 'assemble', ...flags).status).toBe(0);
    const r = spawnSync('node', [CLI, 'validate', ...flags], {
      cwd: c,
      encoding: 'utf8',
      env: { ...SEALED_ENV, GITHUB_BASE_REF: 'elsewhere' },
    });
    expect(r.status, r.stderr).toBe(0);
    const [pass] = JSON.parse(readFileSync(w.ledger, 'utf8')).passes;
    expect(readFileSync(pass.log, 'utf8')).toContain('gate-check: 0 red against main');
  });

  it('refuses to validate when a prepare step fails, and runs no gate', () => {
    const c = clone('validate-unprepared');
    const w = windowFiles('w-unprepared', [['ISS-4', 'ISS-4-after', heads.m4]], green(heads.m4));
    const flags = ['--window', w.manifest, '--checks', w.checksFile, '--tree', w.tree];
    expect(run(c, 'assemble', ...flags).status).toBe(0);
    writeFileSync(join(w.tree, '.unpreparable'), 'yes');
    const r = run(c, 'validate', ...flags);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('`node prepare.mjs` did not prepare');
    expect(JSON.parse(readFileSync(w.ledger, 'utf8')).passes).toBeUndefined();
  });

  it.each([
    ['a tracked file edited', (tree) => rmSync(join(tree, 'src/shared.txt')), /holds changes/],
    [
      'an untracked file added',
      (tree) => writeFileSync(join(tree, 'src/stray.txt'), 'x\n'),
      /holds changes/,
    ],
    [
      'HEAD moved off the chain head',
      (tree) => git(tree, 'checkout', '-q', '--detach', 'HEAD~1'),
      /is at [0-9a-f]{40}, not the chain head/,
    ],
  ])('refuses to validate a tree with %s, and records no pass', (label, spoil, why) => {
    const name = label.split(' ').slice(0, 3).join('-').toLowerCase();
    const c = clone(`validate-${name}`);
    const w = windowFiles(`w-${name}`, [['ISS-4', 'ISS-4-after', heads.m4]], green(heads.m4));
    const flags = ['--window', w.manifest, '--checks', w.checksFile, '--tree', w.tree];
    const built = run(c, 'assemble', ...flags);
    expect(built.status, built.stderr).toBe(0);
    spoil(w.tree);
    const r = run(c, 'validate', ...flags);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(why);
    expect(r.stderr).toContain('so the gate was not run');
    expect(JSON.parse(readFileSync(w.ledger, 'utf8')).passes).toBeUndefined();
  });
});

describe('a window id already pushed', () => {
  it('is refused on a fresh assemble, so its branch cannot hide from the open set', () => {
    const c = clone('reused-window');
    git(seed, 'push', '-q', 'origin', `${heads.m4}:refs/heads/chore/verify-window-w-reused`);
    const w = windowFiles('w-reused', [['ISS-4', 'ISS-4-after', heads.m4]], green(heads.m4));
    try {
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
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(
        'origin/chore/verify-window-w-reused already exists, and a fresh window cannot tell it from a stale one',
      );
    } finally {
      git(seed, 'push', '-q', 'origin', '--delete', 'chore/verify-window-w-reused');
    }
  });
});

describe('the push a rebuilt window prints', () => {
  it('replaces the pushed chain under a lease that refuses once anyone moved the branch', () => {
    const d = branch('ISS-18-d', { 'src/d18.txt': 'd\n' });
    const c = clone('push-window');
    const other = clone('push-window-other');
    const w = windowFiles(
      'w-push',
      [
        ['ISS-18', 'ISS-18-d', d],
        ['ISS-4', 'ISS-4-after', heads.m4],
      ],
      green(d, heads.m4),
    );
    const printed = (out) =>
      out
        .match(/^ {2}(git push .*)$/m)[1]
        .split(' ')
        .slice(1);
    const pushIn = (dir, args) =>
      spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: SEALED_ENV });
    const tree = ['--window', w.manifest, '--checks', w.checksFile, '--tree', w.tree];
    const built = run(c, 'assemble', ...tree);
    expect(built.status, built.stderr).toBe(0);
    expect(pushIn(c, printed(built.stdout)).status).toBe(0);
    const first = JSON.parse(readFileSync(w.ledger, 'utf8')).chain.head;
    const again = run(c, 'isolate', ...tree, '--member', 'ISS-18', '--because', 'red');
    const rebuilt = JSON.parse(readFileSync(w.ledger, 'utf8')).chain.head;
    const replace = printed(again.stdout);
    expect(replace).toContain(`--force-with-lease=refs/heads/chore/verify-window-w-push:${first}`);
    git(other, 'fetch', '-q', 'origin');
    git(other, 'checkout', '-q', '-b', 'mover', 'origin/chore/verify-window-w-push');
    put(other, { 'src/mover.txt': 'moved\n' });
    git(other, 'add', 'src/mover.txt');
    git(other, 'commit', '-q', '-m', 'someone else moved the window branch');
    git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/chore/verify-window-w-push');
    expect(pushIn(c, replace).status).not.toBe(0);
    git(other, 'push', '-q', '-f', 'origin', `${first}:refs/heads/chore/verify-window-w-push`);
    expect(pushIn(c, replace).status).toBe(0);
    const remote = git(seed, 'ls-remote', 'origin', 'refs/heads/chore/verify-window-w-push');
    expect(remote.split(/\s/)[0]).toBe(rebuilt);
    git(seed, 'push', '-q', 'origin', '--delete', 'ISS-18-d', 'chore/verify-window-w-push');
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
