// @gate-input whole-tree — its fixtures are git repositories, and the code it exercises lists a checkout whole.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INPUTS, undeclared } from './check-inputs.mjs';
import {
  audit,
  bypassReason,
  evict,
  keyFor,
  listEntries,
  lookup,
  readTrace,
  store,
  storeBudget,
  storeDir,
  Tree,
  traceEnv,
} from './verify-memo.mjs';
import { Memo, memoListing } from './verify-memo-run.mjs';
import { spawnFault } from './verify-memo-spawn.mjs';

const sh = (cwd, ...argv) => spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8' });
let root;
let dir;

const put = (rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const commit = (message = 'x') => {
  sh(root, 'git', 'add', '-A');
  sh(root, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verify-memo-test-'));
  dir = join(root, '..', `${root.split('/').pop()}-store`);
  sh(root, 'git', 'init', '-q', '-b', 'main');
  put('src/a.txt', 'alpha');
  put('src/b.txt', 'beta');
  put('docs/n.md', 'note');
  put('check.mjs', '');
  commit();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const key = (decl, extra = {}) => {
  const tree = new Tree(root);
  const check = { label: 'c', cmd: ['node', 'check.mjs'] };
  return keyFor({ check, decl, tree, git: extra.git, env: extra.env ?? {} });
};

describe('the key', () => {
  const decl = { roots: ['src'] };

  it('does not move when a file is only touched', () => {
    const before = key(decl).key;
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, 'src/a.txt'), later, later);
    expect(key(decl).key).toBe(before);
  });

  it('moves with the content of a file it reads and not of one it does not', () => {
    const before = key(decl).key;
    put('docs/n.md', 'a different note');
    expect(key(decl).key).toBe(before);
    put('src/a.txt', 'alpha, edited');
    expect(key(decl).key).not.toBe(before);
  });

  it('moves when a file appears among those it reads, tracked or not, and when it is staged', () => {
    const before = key(decl).key;
    put('src/new.txt', 'fresh');
    const untracked = key(decl).key;
    expect(untracked).not.toBe(before);
    sh(root, 'git', 'add', 'src/new.txt');
    expect(key(decl).key).not.toBe(untracked);
  });

  it('moves when a name appears beside a root, so a listing of the parent is held', () => {
    const before = key(decl).key;
    put('other.txt', 'beside');
    expect(key(decl).key).not.toBe(before);
  });

  it('holds only the names of a listed directory, never their content', () => {
    const listed = { roots: ['src'], listed: ['docs'] };
    const before = key(listed).key;
    put('docs/n.md', 'changed');
    expect(key(listed).key).toBe(before);
    put('docs/added.md', 'new name');
    expect(key(listed).key).not.toBe(before);
  });

  it('holds a build output git ignores, where the declaration names it', () => {
    put('.gitignore', 'dist\n');
    commit();
    put('dist/out.js', 'one');
    const built = { roots: ['src'], built: ['dist'] };
    const before = key(built).key;
    expect(key(decl).key).toBe(key(decl).key);
    put('dist/out.js', 'two');
    expect(key(built).key).not.toBe(before);
  });

  it('holds the variables a tool is known to read', () => {
    const before = key(decl).key;
    expect(key(decl, { env: { BIOME_CONFIG_PATH: '/elsewhere' } }).key).not.toBe(before);
    expect(key(decl, { env: { UNRELATED: 'x' } }).key).toBe(before);
  });

  it('holds the head only for a check that asks git', () => {
    const asks = { roots: ['src'], git: true };
    const git = { head: 'a', baseRef: 'origin/main', base: 'b' };
    const before = key(asks, { git }).key;
    expect(key(asks, { git: { ...git, head: 'c' } }).key).not.toBe(before);
    expect(key(decl, { git: { ...git, head: 'c' } }).key).toBe(key(decl, { git }).key);
  });
});

describe('the store', () => {
  const entry = (out = 'ok') => ({ label: 'c', cmd: ['x'], out, files: 3, storedAt: 1 });

  it('serves what was filed, and nothing under a key that was not', () => {
    const k = 'a'.repeat(64);
    expect(store(dir, k, entry('9 files'), 1 << 20)).toEqual({ stored: true });
    expect(lookup(dir, k).out).toBe('9 files');
    expect(lookup(dir, 'b'.repeat(64))).toBeNull();
  });

  it('refuses an entry that names another key, so a copied file never answers', () => {
    const k = 'a'.repeat(64);
    store(dir, k, entry(), 1 << 20);
    writeFileSync(join(dir, `${'c'.repeat(64)}.json`), readFileSync(join(dir, `${k}.json`)));
    expect(lookup(dir, 'c'.repeat(64))).toBeNull();
  });

  it('refuses an entry from another schema, and one that records anything but a pass', () => {
    const k = 'a'.repeat(64);
    store(dir, k, entry(), 1 << 20);
    const file = join(dir, `${k}.json`);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...doc, schema: doc.schema + 1 }));
    expect(lookup(dir, k)).toBeNull();
    writeFileSync(file, JSON.stringify({ ...doc, status: 1 }));
    expect(lookup(dir, k)).toBeNull();
  });

  it('forgets the least recently used entry first, and a lookup counts as a use', () => {
    const keys = ['1', '2', '3'].map((c) => c.repeat(64));
    for (const k of keys) store(dir, k, entry('x'.repeat(100)), 1 << 20);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, `${keys[0]}.json`), old, old);
    utimesSync(
      join(dir, `${keys[1]}.json`),
      new Date(old.getTime() + 1000),
      new Date(old.getTime() + 1000),
    );
    lookup(dir, keys[0]);
    const size = listEntries(dir)[0].bytes;
    evict(dir, size * 2);
    expect(
      listEntries(dir)
        .map((e) => e.key)
        .sort(),
    ).toEqual([keys[0], keys[2]].sort());
  });

  it('keeps itself under its bound while filing', () => {
    for (let i = 0; i < 8; i += 1) store(dir, String(i).repeat(64), entry('y'.repeat(400)), 1500);
    const held = listEntries(dir).reduce((n, e) => n + e.bytes, 0);
    expect(held).toBeLessThanOrEqual(1500);
  });

  it('refuses an output too large to file, naming why', () => {
    const filed = store(dir, 'd'.repeat(64), entry('z'.repeat((1 << 20) + 1)), 1 << 30);
    expect(filed.refused).toMatch(/over 1048576 bytes/);
    expect(existsSync(dir)).toBe(false);
  });

  it('sits outside the checkout and takes its place and bound from the environment', () => {
    expect(storeDir({ VERIFY_MEMO_DIR: '/x/y' })).toBe('/x/y');
    expect(storeDir({ XDG_CACHE_HOME: '/c' })).toBe('/c/forge-verify-memo');
    expect(storeBudget({ VERIFY_MEMO_MAX_MB: '2' })).toBe(2 * 1024 * 1024);
    expect(storeBudget({ VERIFY_MEMO_MAX_MB: 'junk' })).toBe(16 * 1024 * 1024);
  });

  it('is not consulted under --all or CI, and says why', () => {
    expect(bypassReason(['--all'], {})).toMatch(/afresh/);
    expect(bypassReason([], { CI: 'true' })).toMatch(/CI is the gate/);
    expect(bypassReason([], {})).toBeNull();
  });
});

describe('the audit of a trace against a declaration', () => {
  const decl = { roots: ['src'], blind: [] };
  const faults = (lines, d = decl) => audit({ root, decl: d, tree: new Tree(root), lines });
  const R = (rel) => `R ${join(root, rel)}`;

  it('accepts a read inside the roots, and ignores node_modules, .git and the rest of the machine', () => {
    expect(
      faults([R('src/a.txt'), R('node_modules/x/i.js'), R('.git/HEAD'), 'R /etc/hosts']),
    ).toEqual([]);
  });

  it('names a file read outside the roots', () => {
    expect(faults([R('docs/n.md')])).toEqual(['read docs/n.md']);
  });

  it('names a directory listed outside the roots and accepts the ones above them', () => {
    expect(faults([`L ${join(root, 'docs')}`, `L ${root}`])).toEqual(['listed docs/']);
  });

  it('accepts a probe for a file that is not there only where its appearance would move the key', () => {
    expect(faults([R('src/absent.txt'), R('absent-at-top.txt')])).toEqual([]);
    expect(faults([R('docs/absent.md')])).toEqual(['probed docs/absent.md']);
  });

  it('accepts a derived cache named in the declaration, and a glob a tool tried as a path', () => {
    put('.cache-file', 'x');
    expect(
      faults([R('.cache-file'), R('!**/skip/**')], { ...decl, derived: ['.cache-file'] }),
    ).toEqual([]);
  });

  it('names a read of an ignored file inside a root, which no key holds', () => {
    put('.gitignore', 'src/secret.txt\n');
    commit();
    put('src/secret.txt', 'hidden');
    expect(faults([R('src/secret.txt')])).toEqual(['read src/secret.txt']);
  });

  it('refuses a program that asked git what the key cannot hold, even for a check declaring git', () => {
    const asks = { ...decl, git: true };
    const line = (...argv) => `S ${JSON.stringify(['git', ...argv])}`;
    expect(faults([line('diff', '--cached', '--name-only')], asks)[0]).toMatch(/reads the index/);
    expect(faults([line('diff', '--name-only')], asks)[0]).toMatch(/no revision reads the index/);
    expect(faults([line('ls-files', '-s')], asks)[0]).toMatch(/reads the index/);
    expect(faults([line('status', '--short')], asks)[0]).toMatch(/cannot hold/);
    expect(faults([line('show', ':CHANGELOG.md')], asks)[0]).toMatch(/reads the index/);
  });

  it('accepts the file list always, and history and the base only where the check declares git', () => {
    const line = (...argv) => `S ${JSON.stringify(['git', ...argv])}`;
    expect(faults([line('ls-files'), line('rev-parse', '--show-toplevel')])).toEqual([]);
    expect(faults([line('merge-base', 'origin/main', 'HEAD')])[0]).toMatch(/no `git`/);
    expect(
      faults([line('merge-base', 'origin/main', 'HEAD'), line('diff', '--name-only', 'abc')], {
        ...decl,
        git: true,
      }),
    ).toEqual([]);
  });
});

describe('a program a traced run started', () => {
  const none = { roots: ['src'] };

  it('is inside the trace when it is a Node tool, or a transform fed by Node, alone or in a shell', () => {
    for (const argv of [
      ['/usr/bin/node', 'x.mjs'],
      ['pnpm', 'exec', 'tsc'],
      ['sh', '-c', 'node y.mjs && pnpm exec tsc'],
      ['/p/esbuild', '--ping'],
      ['ldd --version'],
    ]) {
      expect(spawnFault(argv, none)).toBeNull();
    }
  });

  it('is outside it when native, until the declaration names it, wherever a shell hides it', () => {
    const named = { roots: ['src'], blind: ['biome'] };
    for (const argv of [
      ['/p/@biomejs/cli/biome', 'check'],
      ['sh', '-c', "'biome' check src"],
      ['sh', '-c', 'node a.mjs; biome check'],
    ]) {
      expect(spawnFault(argv, none)).toMatch(/`biome`, native code/);
    }
    expect(spawnFault(['/p/biome', 'check'], named)).toBeNull();
    expect(spawnFault(['sh', '-c', 'node a.mjs | cat secret.txt'], named)).toMatch(/`cat`/);
  });

  it('is refused when a shell runs a script or a substitution, whose commands cannot be listed', () => {
    expect(spawnFault(['sh', 'tool.sh'], none)).toMatch(/`sh script`/);
    expect(spawnFault(['bash', '-c', 'node $(which cat) x'], none)).toMatch(/substitution/);
  });
});

describe('the preload', () => {
  it('records what a real child process read, listed and started', () => {
    const traced = traceEnv({ PATH: process.env.PATH });
    put(
      'probe.cjs',
      "const fs=require('node:fs');fs.readFileSync('src/a.txt');fs.readdirSync('docs');fs.existsSync('nope.txt');require('node:child_process').spawnSync('git',['ls-files']);",
    );
    const r = spawnSync('node', ['probe.cjs'], { cwd: root, env: traced.env, encoding: 'utf8' });
    const lines = readTrace(traced.dir);
    expect(r.status).toBe(0);
    expect(lines).toContain(`R ${join(root, 'src/a.txt')}`);
    expect(lines).toContain(`L ${join(root, 'docs')}`);
    expect(lines).toContain(`R ${join(root, 'nope.txt')}`);
    expect(lines).toContain('S ["git","ls-files"]');
    expect(existsSync(traced.dir)).toBe(false);
  });
});

/** A check as verify runs one: `node check.mjs` over the files under `src`, red when one holds BAD. */
const CHECK = `
import { readdirSync, readFileSync } from 'node:fs';
const files = readdirSync('src');
const bad = files.filter((f) => readFileSync('src/' + f, 'utf8').includes('BAD'));
if (process.env.PEEK) readFileSync(process.env.PEEK);
console.log('c: ' + files.length + ' file(s) scanned');
process.exit(bad.length ? 1 : 0);
`;

describe('a check taken through the memo', () => {
  const check = { label: 'c', cmd: ['node', 'check.mjs'] };
  const declarations = { c: { roots: ['check.mjs', 'src'] } };
  const env = () => ({ PATH: process.env.PATH, VERIFY_MEMO_DIR: dir });
  const memo = (args = [], more = {}) =>
    new Memo({ root, args, env: { ...env(), ...more }, baseRef: 'main', base: 'x', declarations });

  /** Plans the check, runs it as verify does, settles it, and returns what the row would be built on. */
  const run = (m, extra = {}) => {
    const plan = m.plan(check);
    if (plan.kind === 'hit') return { plan, status: 0, out: plan.entry.out, verdict: { code: 0 } };
    const r = spawnSync('node', ['check.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...(plan.env ?? process.env), ...extra },
    });
    const out = `${r.stdout}${r.stderr}`;
    const verdict = m.settle(plan, r.status, out, { code: r.status });
    return { plan, status: r.status, out, verdict };
  };

  beforeEach(() => {
    put('check.mjs', CHECK);
    commit('check');
  });

  it('serves the second run of an unchanged tree from the store, with the output the first run gave', () => {
    const first = run(memo());
    const second = run(memo());
    expect(first.plan.kind).toBe('miss');
    expect(second.plan.kind).toBe('hit');
    expect(second.out).toBe(first.out);
    expect(memoListing({ VERIFY_MEMO_DIR: dir }).join('\n')).toMatch(/c · \d+ files · traced/);
  });

  it('goes red through a store that already holds the green, and serves the green again once the plant is gone', () => {
    run(memo());
    put('src/a.txt', 'BAD');
    const planted = run(memo());
    expect(planted.plan.kind).toBe('miss');
    expect(planted.status).toBe(1);
    expect(listEntries(dir)).toHaveLength(1);
    put('src/a.txt', 'alpha');
    const restored = run(memo());
    expect(restored.plan.kind).toBe('hit');
    expect(restored.status).toBe(0);
  });

  it('never files a red, and never serves one', () => {
    put('src/a.txt', 'BAD');
    const red = run(memo());
    expect(red.status).toBe(1);
    expect(listEntries(dir)).toEqual([]);
    expect(run(memo()).plan.kind).toBe('miss');
  });

  it('never files a check that could not run', () => {
    const m = memo();
    const plan = m.plan(check);
    m.settle(plan, 2, 'could not run', { code: 2 });
    m.settle(m.plan(check), null, '', { code: 2, condition: 'blocked' });
    expect(listEntries(dir)).toEqual([]);
  });

  it('refuses by name a check that read past its declaration, files nothing, and exits 2', () => {
    const outside = join(root, 'docs/n.md');
    const m = memo();
    const done = run(m, { PEEK: outside });
    expect(done.status).toBe(0);
    expect(done.verdict.code).toBe(2);
    expect(done.verdict.out).toContain('read docs/n.md');
    expect(listEntries(dir)).toEqual([]);
  });

  it('does not file a verdict when a file it reads changed while it ran', () => {
    const m = memo();
    const plan = m.plan(check);
    const r = spawnSync('node', ['check.mjs'], { cwd: root, encoding: 'utf8', env: plan.env });
    put('src/a.txt', 'moved under it');
    m.settle(plan, r.status, r.stdout, { code: r.status });
    expect(m.unfiled[0].reason).toMatch(/changed while it ran/);
    expect(listEntries(dir)).toEqual([]);
  });

  it('neither reads nor writes the store under --all, nor under CI', () => {
    run(memo());
    const before = listEntries(dir).length;
    for (const m of [memo(['--all']), memo([], { CI: 'true' })]) {
      expect(m.plan(check).kind).toBe('bypass');
      expect(m.summary()[0]).toMatch(/not consulted/);
    }
    expect(listEntries(dir)).toHaveLength(before);
  });

  it('names a check that cannot enumerate its inputs, runs it every time, and files nothing', () => {
    const m = new Memo({
      root,
      args: [],
      env: env(),
      baseRef: 'main',
      base: 'x',
      declarations: { c: { uncached: 'it reads remote refs' } },
    });
    expect(m.plan(check).kind).toBe('uncached');
    expect(m.summary().join('\n')).toContain('uncached  c — it reads remote refs');
    expect(listEntries(dir)).toEqual([]);
  });
});

describe('what verify declares', () => {
  const labels = [
    ...readFileSync(new URL('../verify.mjs', import.meta.url), 'utf8').matchAll(
      /^ {4}label: '([^']+)'/gm,
    ),
  ].map((m) => m[1]);

  it('has a declaration for every check it runs, and none for a check it does not', () => {
    expect(labels.length).toBeGreaterThan(20);
    expect(undeclared(labels.map((label) => ({ label })))).toEqual([]);
    expect(Object.keys(INPUTS).sort()).toEqual([...labels].sort());
  });

  it('refuses a check no declaration decides, by name', () => {
    expect(undeclared([{ label: 'brand-new' }])).toEqual([
      'brand-new: `roots` naming what it reads, or `uncached` and why',
    ]);
  });

  it('gives a check that runs biome the config files biome looks for above its directory', () => {
    for (const label of [
      'core lint',
      'scripts lint',
      'lint-budget',
      'size-budget',
      'conformance levels',
    ]) {
      expect(INPUTS[label].roots).toEqual(
        expect.arrayContaining(['biome.json', 'packages/biome.json']),
      );
    }
  });

  it('gives every cached declaration the lockfile and the ignore file, and every uncached one a reason', () => {
    for (const d of Object.values(INPUTS)) {
      if (d.uncached) expect(d.uncached.length).toBeGreaterThan(20);
      else expect(d.roots).toEqual(expect.arrayContaining(['pnpm-lock.yaml', '.gitignore']));
    }
  });

  it('lists what the store holds and names the checks it never files', () => {
    const lines = memoListing({ VERIFY_MEMO_DIR: dir });
    expect(lines[0]).toBe(`verify memo at ${dir}`);
    expect(
      lines.filter((l) => l.includes('uncached by declaration')).map((l) => l.split(' — ')[0]),
    ).toEqual([
      '  uncached by declaration: flow-coverage',
      '  uncached by declaration: cargo gates',
      '  uncached by declaration: migration-order',
    ]);
  });
});
