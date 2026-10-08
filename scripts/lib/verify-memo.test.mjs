// @gate-input whole-tree — its fixtures are git repositories, and the code it exercises lists a checkout whole.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
import { externalDeps, externalHolds } from './verify-memo-external.mjs';
import { gitFault } from './verify-memo-git.mjs';
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
    const [plainBefore, builtBefore] = [key(decl).key, key(built).key];
    put('dist/out.js', 'two');
    expect(key(decl).key).toBe(plainBefore);
    expect(key(built).key).not.toBe(builtBefore);
  });

  it('holds a single built file by content, and a probed path by its name, kind and size and not by what it holds', () => {
    put('.gitignore', 'gen.d.ts\nbuildinfo\n');
    commit();
    put('gen.d.ts', 'one');
    put('buildinfo', 'one');
    const both = { roots: ['src'], built: ['gen.d.ts'], probed: ['buildinfo'] };
    const before = key(both).key;
    put('buildinfo', 'two');
    expect(key(both).key).toBe(before);
    put('buildinfo', 'two, a longer text');
    const resized = key(both).key;
    expect(resized).not.toBe(before);
    put('gen.d.ts', 'two');
    const built = key(both).key;
    expect(built).not.toBe(resized);
    rmSync(join(root, 'buildinfo'));
    expect(key(both).key).not.toBe(built);
  });

  it('holds the content a link leads to, so a declared link cannot hide an undeclared file', () => {
    symlinkSync('../docs/n.md', join(root, 'src/link.txt'));
    const before = key(decl).key;
    put('docs/n.md', 'the target changed');
    expect(key(decl).key).not.toBe(before);
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
  const held = {
    head: 'a'.repeat(40),
    parent: 'b'.repeat(40),
    baseRef: 'origin/main',
    base: `abc0000${'0'.repeat(33)}`,
  };
  const faults = (lines, d = decl) =>
    audit({ root, decl: d, tree: new Tree(root), lines, git: held });
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

  it('accepts a stat of a probed path and refuses a read of it, which the key does not hold', () => {
    put('docs/n.md', 'note');
    const probed = { ...decl, probed: ['docs/n.md'] };
    expect(
      faults([`P ${join(root, 'docs/n.md')}`, `M ${join(root, 'docs/n.md')}`], probed),
    ).toEqual([]);
    expect(faults([R('docs/n.md')], probed)).toEqual(['read docs/n.md']);
    expect(faults([`P ${join(root, 'docs/n.md')}`])).toEqual(['stat docs/n.md']);
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
      faults([line('merge-base', 'origin/main', 'HEAD'), line('diff', '--name-only', 'abc0000')], {
        ...decl,
        git: true,
      }),
    ).toEqual([]);
  });
});

describe('the git questions a check may ask', () => {
  const sha = (c) => c.repeat(40);
  const state = {
    head: sha('a'),
    parent: sha('b'),
    baseRef: 'origin/main',
    base: sha('c'),
  };
  const asks = { git: true };
  const fault = (decl, ...argv) => gitFault(['git', ...argv], decl, state);

  it('accepts the head, its parent, the base ref and the shas the key holds', () => {
    expect(fault(asks, 'show', `${sha('b')}:CHANGELOG.md`)).toBeNull();
    expect(fault(asks, 'diff', '--name-only', sha('c'))).toBeNull();
    expect(fault(asks, 'merge-base', 'origin/main', 'HEAD')).toBeNull();
    expect(fault(asks, 'rev-parse', '--verify', '--quiet', 'origin/main^{commit}')).toBeNull();
    expect(fault(asks, 'log', '-1', '--format=%ct', '--', 'docs/VISION.md')).toBeNull();
    expect(fault(asks, 'ls-remote', '--symref', 'origin', 'HEAD')).toBeNull();
  });

  it('refuses a revision the key does not hold, so another branch moving cannot serve a stale verdict', () => {
    expect(fault(asks, 'show', 'origin/other:CHANGELOG.md')).toMatch(/names origin\/other/);
    expect(fault(asks, 'show', 'origin/main:CHANGELOG.md')).toMatch(/names origin\/main/);
    expect(fault(asks, 'diff', '--name-only', 'origin/main')).toMatch(/names origin\/main/);
    expect(fault(asks, 'diff', '--name-only', sha('e'))).toMatch(/names e+/);
    expect(fault(asks, 'rev-parse', 'origin/main')).toMatch(/names origin\/main/);
    expect(fault(asks, 'rev-parse', '--verify', 'origin/main')).toMatch(/names origin\/main/);
    expect(fault(asks, 'log', '--first-parent', 'origin/release', '^origin/main')).toMatch(
      /names origin\/release/,
    );
  });

  it('refuses an option that selects revisions of its own, such as every branch', () => {
    for (const flag of ['--all', '--branches', '--glob=refs/heads/*', '--remotes=origin', '-g']) {
      expect(fault(asks, 'log', flag)).toMatch(/selects revisions/);
    }
    expect(fault(asks, 'rev-list', '--all', 'HEAD')).toMatch(/selects revisions/);
  });

  it('refuses a question to a remote beyond the default branch lookup', () => {
    expect(fault(asks, 'ls-remote', 'origin')).toMatch(/asks a remote/);
    expect(fault(asks, 'ls-remote', '--heads', 'origin')).toMatch(/asks a remote/);
  });

  it('refuses everything that asks history of a check declaring no git', () => {
    expect(fault({}, 'merge-base', 'origin/main', 'HEAD')).toMatch(/no `git`/);
    expect(fault({}, 'ls-remote', '--symref', 'origin', 'HEAD')).toMatch(/no `git`/);
  });
});

describe('what a check reads outside the checkout', () => {
  const home = '/nowhere/home';
  const tmp = '/nowhere/tmp';
  const deps = (lines) => externalDeps({ root, lines, home, tmp });

  it('holds a config file by content, an absent probe as absent, and nothing of a directory', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    writeFileSync(join(outside, 'cfg'), 'one');
    const found = deps([
      `R ${join(outside, 'cfg')}`,
      `R ${join(outside, 'missing')}`,
      `R ${outside}`,
    ]);
    expect(
      found.deps.map(([p, sig]) => [p.split('/').pop(), sig === '-' ? '-' : 'content']),
    ).toEqual([
      ['cfg', 'content'],
      ['missing', '-'],
    ]);
    expect(externalHolds(found.deps)).toBe(true);
    writeFileSync(join(outside, 'cfg'), 'two');
    expect(externalHolds(found.deps)).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('holds the machine config under /etc, and names a file written after the run began', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    const file = join(outside, 'cfg');
    writeFileSync(file, 'one');
    const lines = [`R ${file}`, 'R /etc/passwd'];
    const found = deps(lines);
    expect(found.deps.map(([p]) => p)).toContain('/etc/passwd');
    expect(found.moved).toEqual([]);
    expect(externalDeps({ root, lines, since: Date.now() - 60_000, home, tmp }).moved).toEqual([
      file,
    ]);
    rmSync(outside, { recursive: true, force: true });
  });

  it('holds the content an outside link leads to, and a link that leads nowhere', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    writeFileSync(join(outside, 'real.rc'), 'one');
    symlinkSync(join(outside, 'real.rc'), join(outside, 'link.rc'));
    symlinkSync(join(outside, 'gone.rc'), join(outside, 'dangling.rc'));
    const found = deps([`R ${join(outside, 'link.rc')}`, `R ${join(outside, 'dangling.rc')}`]);
    expect(found.deps.map(([, sig]) => sig.endsWith(':dangling'))).toEqual([true, false]);
    expect(externalHolds(found.deps)).toBe(true);
    writeFileSync(join(outside, 'real.rc'), 'two');
    expect(externalHolds(found.deps)).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('holds a probe that later appears, which would change what a tool resolves', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    const found = deps([`R ${join(outside, 'package.json')}`]);
    writeFileSync(join(outside, 'package.json'), '{}');
    expect(externalHolds(found.deps)).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('skips tool state and the machine, and a path the checkout spells in another case', () => {
    const lines = [
      `R ${home}/.npm/_logs/x.log`,
      `R ${home}/.cache/a`,
      `R ${tmp}/pipe`,
      'R /usr/lib/x',
      `R ${root.toUpperCase()}/NODE_MODULES/X`,
    ];
    expect(deps(lines)).toEqual({ deps: [], faults: [], moved: [] });
  });

  it('names a directory listed outside the checkout, which no signature holds', () => {
    expect(deps([`L ${home}/projects`]).faults).toEqual([
      `listed ${home}/projects/, outside the checkout`,
    ]);
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

  it('is refused when a shell runs a script, a substitution or a redirected input, which the trace cannot list', () => {
    expect(spawnFault(['sh', 'tool.sh'], none)).toMatch(/`sh script`/);
    expect(spawnFault(['bash', '-c', 'node $(which cat) x'], none)).toMatch(/substitution/);
    expect(spawnFault(['sh', '-c', 'node child.cjs < docs/input.txt'], none)).toMatch(
      /input redirection/,
    );
  });
});

describe('the preload', () => {
  it('records what a real child process read, listed and started', () => {
    const traced = traceEnv({ PATH: process.env.PATH });
    put(
      'probe.cjs',
      "const fs=require('node:fs');fs.readFileSync('src/a.txt');fs.readdirSync('docs');fs.existsSync('nope.txt');fs.statSync('quiet.txt',{throwIfNoEntry:false});fs.statSync('src/b.txt');require('node:child_process').spawnSync('git',['ls-files']);",
    );
    const r = spawnSync('node', ['probe.cjs'], { cwd: root, env: traced.env, encoding: 'utf8' });
    const lines = readTrace(traced.dir);
    expect(r.status).toBe(0);
    expect(lines).toContain(`R ${join(root, 'src/a.txt')}`);
    expect(lines).toContain(`L ${join(root, 'docs')}`);
    expect(lines).toContain(`M ${join(root, 'nope.txt')}`);
    expect(lines).toContain(`M ${join(root, 'quiet.txt')}`);
    expect(lines).toContain(`P ${join(root, 'src/b.txt')}`);
    expect(lines).not.toContain(`R ${join(root, 'src/b.txt')}`);
    expect(lines).toContain('S ["git","ls-files"]');
    expect(existsSync(traced.dir)).toBe(false);
  });

  it('records whether an async read found its file, for a promise and for a callback', () => {
    const traced = traceEnv({ PATH: process.env.PATH });
    put(
      'async.cjs',
      "const fs=require('node:fs');(async()=>{await fs.promises.readFile('src/a.txt');await fs.promises.readFile('gone.txt').catch(()=>{});fs.readFile('src/a.txt',()=>{});fs.readFile('gone-too.txt',()=>{});})();",
    );
    spawnSync('node', ['async.cjs'], { cwd: root, env: traced.env, encoding: 'utf8' });
    const lines = readTrace(traced.dir);
    expect(lines).toContain(`R ${join(root, 'src/a.txt')}`);
    expect(lines).toContain(`M ${join(root, 'gone.txt')}`);
    expect(lines).toContain(`M ${join(root, 'gone-too.txt')}`);
  });
});

/** A check as verify runs one: `node check.mjs` over the files under `src`, red when one holds BAD. */
const CHECK = `
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
const files = readdirSync('src');
const bad = files.filter((f) => readFileSync('src/' + f, 'utf8').includes('BAD'));
if (process.env.PEEK) readFileSync(process.env.PEEK);
if (process.env.IMPORT) await import(process.env.IMPORT);
if (process.env.PROBE) existsSync(process.env.PROBE);
if (process.env.STAT) statSync(process.env.STAT);
if (process.env.SIZED && statSync(process.env.SIZED).size > 10) bad.push('size');
if (process.env.STREAM) await new Promise((done) => createReadStream(process.env.STREAM).on('data', () => {}).on('close', done));
if (process.env.ASYNC) await (await import('node:fs/promises')).readFile(process.env.ASYNC);
if (process.env.SHELLED) {
  const { spawnSync } = await import('node:child_process');
  spawnSync('node', [process.env.SHELLED + ' < docs/n.md'], { shell: true });
}
if (process.env.CHILD) {
  const { spawnSync } = await import('node:child_process');
  spawnSync(process.execPath, ['-e', 'require("fs").readFileSync(process.argv[1])', process.env.CHILD], { env: {} });
}
console.log('c: ' + files.length + ' file(s) scanned');
process.exit(bad.length ? 1 : 0);
`;

describe('a check taken through the memo', () => {
  const check = { label: 'c', cmd: ['node', 'check.mjs'] };
  const declarations = { c: { roots: ['check.mjs', 'src'] } };
  const env = () => ({ PATH: process.env.PATH, VERIFY_MEMO_DIR: dir });
  const memo = (args = [], more = {}) =>
    new Memo({ root, args, env: { ...env(), ...more }, baseRef: 'main', declarations });

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

  it('sees a file added between two plans of one memo, so a hit never uses a stale file list', () => {
    const m = memo();
    run(m);
    expect(m.plan(check).kind).toBe('hit');
    put('src/zz.txt', 'BAD');
    const next = run(m);
    expect(next.plan.kind).toBe('miss');
    expect(next.status).toBe(1);
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

  it('refuses a stat of a path its declaration does not name, and files a check that only stats a probed one', () => {
    const outside = join(root, 'docs/n.md');
    expect(run(memo(), { STAT: outside }).verdict.out).toContain('stat docs/n.md');
    expect(listEntries(dir)).toEqual([]);
    const probed = { c: { roots: ['check.mjs', 'src'], probed: ['docs/n.md'] } };
    const m = new Memo({ root, args: [], env: env(), baseRef: 'main', declarations: probed });
    expect(run(m, { STAT: outside }).verdict.code).toBe(0);
    expect(listEntries(dir)).toHaveLength(1);
    put('docs/n.md', 'NOTE');
    const again = new Memo({ root, args: [], env: env(), baseRef: 'main', declarations: probed });
    expect(run(again, { STAT: outside }).plan.kind).toBe('hit');
    rmSync(outside);
    const gone = new Memo({ root, args: [], env: env(), baseRef: 'main', declarations: probed });
    expect(run(gone, { STAT: outside }).plan.kind).toBe('miss');
  });

  it('goes red when a probed file grows past what the check allows, through a store that holds the green', () => {
    const sized = join(root, 'docs/n.md');
    const probed = { c: { roots: ['check.mjs', 'src'], probed: ['docs/n.md'] } };
    const plan = () =>
      new Memo({ root, args: [], env: env(), baseRef: 'main', declarations: probed });
    expect(run(plan(), { SIZED: sized }).verdict.code).toBe(0);
    expect(run(plan(), { SIZED: sized }).plan.kind).toBe('hit');
    put('docs/n.md', 'a note grown well past ten bytes');
    const grown = run(plan(), { SIZED: sized });
    expect(grown.plan.kind).toBe('miss');
    expect(grown.status).toBe(1);
    expect(listEntries(dir)).toHaveLength(1);
  });

  it('refuses a module the check imports from outside its declaration', () => {
    put('docs/rule.mjs', 'export default 1;');
    const done = run(memo(), { IMPORT: join(root, 'docs/rule.mjs') });
    expect(done.verdict.code).toBe(2);
    expect(done.verdict.out).toContain('docs/rule.mjs');
    expect(listEntries(dir)).toEqual([]);
  });

  it('refuses a read made by a child that was started with no environment, which is still traced', () => {
    const done = run(memo(), { CHILD: join(root, 'docs/n.md') });
    expect(done.verdict.code).toBe(2);
    expect(done.verdict.out).toContain('read docs/n.md');
    expect(listEntries(dir)).toEqual([]);
  });

  it('serves an entry only while the files it read outside the checkout read as they did', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    const peek = join(outside, 'user.rc');
    writeFileSync(peek, 'one');
    const minuteAgo = new Date(Date.now() - 60_000);
    utimesSync(peek, minuteAgo, minuteAgo);
    const places = { home: '/nowhere/home', tmp: '/nowhere/tmp' };
    const asMemo = () =>
      new Memo({ root, args: [], env: env(), baseRef: 'main', declarations, places });
    expect(run(asMemo(), { PEEK: peek }).plan.kind).toBe('miss');
    expect(asMemo().plan(check).kind).toBe('hit');
    writeFileSync(peek, 'two');
    expect(asMemo().plan(check).kind).toBe('miss');
    rmSync(outside, { recursive: true, force: true });
  });

  it('does not file a verdict whose outside file was written as the run began, so a fast runner cannot make that a hit', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    const peek = join(outside, 'user.rc');
    writeFileSync(peek, 'one');
    const soon = new Date(Date.now() + 50);
    utimesSync(peek, soon, soon);
    const places = { home: '/nowhere/home', tmp: '/nowhere/tmp' };
    const m = new Memo({ root, args: [], env: env(), baseRef: 'main', declarations, places });
    expect(run(m, { PEEK: peek }).plan.kind).toBe('miss');
    expect(m.unfiled[0].reason).toMatch(/outside the checkout changed while it ran/);
    expect(listEntries(dir)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it('does not file a verdict when a file it read outside the checkout was replaced while it ran', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    const peek = join(outside, 'user.rc');
    writeFileSync(peek, 'passing');
    const places = { home: '/nowhere/home', tmp: '/nowhere/tmp' };
    const m = new Memo({
      root,
      args: [],
      env: env(),
      baseRef: 'main',
      declarations,
      places,
    });
    const plan = m.plan(check);
    const r = spawnSync('node', ['check.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...plan.env, PEEK: peek },
    });
    writeFileSync(peek, 'failing');
    m.settle(plan, r.status, r.stdout, { code: r.status });
    expect(m.unfiled[0].reason).toMatch(/outside the checkout changed while it ran/);
    expect(listEntries(dir)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it('does not file a verdict when a file it read outside was deleted, or one it found missing was created, while it ran', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    const places = { home: '/nowhere/home', tmp: '/nowhere/tmp' };
    const settled = (extra, after) => {
      const m = new Memo({ root, args: [], env: env(), baseRef: 'main', declarations, places });
      const plan = m.plan(check);
      const r = spawnSync('node', ['check.mjs'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...plan.env, ...extra },
      });
      after();
      m.settle(plan, r.status, r.stdout, { code: r.status });
      return m.unfiled.map((u) => u.reason);
    };
    const read = join(outside, 'read.rc');
    writeFileSync(read, 'passing');
    expect(settled({ PEEK: read }, () => rmSync(read))[0]).toMatch(/outside the checkout changed/);
    const awaited = join(outside, 'awaited.rc');
    writeFileSync(awaited, 'passing');
    expect(settled({ ASYNC: awaited }, () => rmSync(awaited))[0]).toMatch(
      /outside the checkout changed/,
    );
    const streamed = join(outside, 'streamed.rc');
    writeFileSync(streamed, 'passing');
    expect(settled({ STREAM: streamed }, () => rmSync(streamed))[0]).toMatch(
      /outside the checkout changed/,
    );
    const probed = join(outside, 'probed.rc');
    expect(settled({ PROBE: probed }, () => writeFileSync(probed, 'appeared'))[0]).toMatch(
      /outside the checkout changed/,
    );
    rmSync(outside, { recursive: true, force: true });
  });

  it('refuses a command a shell option would redirect input into, and a git state that moved during the run', () => {
    const shelled = run(memo(), { SHELLED: 'child.cjs' });
    expect(shelled.verdict.code).toBe(2);
    expect(shelled.verdict.out).toMatch(/input redirection/);
    const asks = { c: { roots: ['check.mjs', 'src'], git: true } };
    const m = new Memo({ root, args: [], env: env(), baseRef: 'main', declarations: asks });
    const plan = m.plan(check);
    const r = spawnSync('node', ['check.mjs'], { cwd: root, encoding: 'utf8', env: plan.env });
    put('docs/n.md', 'a commit the check never reads');
    commit('moves the head');
    m.settle(plan, r.status, r.stdout, { code: r.status });
    expect(m.unfiled[0].reason).toMatch(/head or the base moved/);
  });

  it('leaves a verdict unfiled, and says why, when the store cannot be written', () => {
    const blocked = join(root, 'a-file');
    writeFileSync(blocked, 'not a directory');
    const m = new Memo({
      root,
      args: [],
      env: { ...env(), VERIFY_MEMO_DIR: join(blocked, 'store') },
      baseRef: 'main',
      declarations,
    });
    const done = run(m);
    expect(done.verdict.code).toBe(0);
    expect(m.unfiled[0].reason).toMatch(/the store refused it/);
  });

  it('shows the first of a long refusal and counts the rest', () => {
    const faults = Array.from({ length: 25 }, (_, i) => `read src/f${i}.txt`);
    const refused = memo().refuse(check, { code: 0 }, faults);
    expect(refused.code).toBe(2);
    expect(refused.out).toContain('  read src/f19.txt');
    expect(refused.out).not.toContain('read src/f20.txt');
    expect(refused.out).toContain('… and 5 more');
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
