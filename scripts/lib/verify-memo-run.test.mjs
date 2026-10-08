// @gate-input whole-tree — its fixtures are git repositories, and the code it exercises lists a checkout whole.
// The memo as verify drives it: plan a check, run it traced, settle it, and what a later plan serves.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listEntries } from './verify-memo.mjs';
import { Memo, memoListing } from './verify-memo-run.mjs';

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
  root = mkdtempSync(join(tmpdir(), 'verify-memo-run-test-'));
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
if (process.env.EXEC && statSync(process.env.EXEC).mode & 0o111) bad.push('exec');
if (process.env.LINKED && statSync(process.env.LINKED).nlink > 1) bad.push('linked');
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

  it('goes red in a place where the native program reads differently, through a store that holds the green', () => {
    const asked = [];
    const place = (said) => ({
      biome: {
        configs: () => [],
        view: () => {
          asked.push(said);
          return said;
        },
      },
    });
    const blind = { c: { roots: ['check.mjs', 'src'], blind: ['biome'] } };
    const at = (said) =>
      new Memo({
        root,
        args: [],
        env: env(),
        baseRef: 'main',
        declarations: blind,
        readings: place(said),
      });
    expect(run(at('config read')).plan.kind).toBe('miss');
    expect(run(at('config read')).plan.kind).toBe('hit');
    const clone = run(at('config unread'));
    expect(clone.plan.kind).toBe('miss');
    expect(clone.status).toBe(0);
    expect(listEntries(dir)).toHaveLength(2);
    expect(run(at('config read')).plan.kind).toBe('hit');
    expect(asked).toContain('config unread');
  });

  it('asks a native program about its place once while the files it leans on stand', () => {
    let asks = 0;
    const biome = {
      configs: (files) => files.filter((f) => f === 'src/a.txt'),
      view: () => ++asks,
    };
    const m = new Memo({
      root,
      args: [],
      env: env(),
      baseRef: 'main',
      declarations: { c: { roots: ['check.mjs', 'src'], blind: ['biome'] } },
      readings: { biome },
    });
    m.plan(check);
    m.plan(check);
    expect(asks).toBe(1);
    put('src/a.txt', 'alpha, edited');
    m.plan(check);
    expect(asks).toBe(2);
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

  it('goes red when the target of a probed link grows past what the check allows, the link itself unchanged', () => {
    put('.gitignore', 'target.txt\nlinked\n');
    commit();
    put('target.txt', 'small');
    symlinkSync(join(root, 'target.txt'), join(root, 'linked'));
    const probed = { c: { roots: ['check.mjs', 'src'], probed: ['linked'] } };
    const plan = () =>
      new Memo({ root, args: [], env: env(), baseRef: 'main', declarations: probed });
    expect(run(plan(), { SIZED: join(root, 'linked') }).verdict.code).toBe(0);
    expect(run(plan(), { SIZED: join(root, 'linked') }).plan.kind).toBe('hit');
    put('target.txt', 'a target grown well past ten bytes');
    const grown = run(plan(), { SIZED: join(root, 'linked') });
    expect(grown.plan.kind).toBe('miss');
    expect(grown.status).toBe(1);
  });

  it('goes red when only the permission bits of a probed file change, through a store that holds the green', () => {
    const file = join(root, 'docs/n.md');
    chmodSync(file, 0o644);
    const probed = { c: { roots: ['check.mjs', 'src'], probed: ['docs/n.md'] } };
    const plan = () =>
      new Memo({ root, args: [], env: env(), baseRef: 'main', declarations: probed });
    expect(run(plan(), { EXEC: file }).verdict.code).toBe(0);
    expect(run(plan(), { EXEC: file }).plan.kind).toBe('hit');
    chmodSync(file, 0o755);
    const changed = run(plan(), { EXEC: file });
    expect(changed.plan.kind).toBe('miss');
    expect(changed.status).toBe(1);
  });

  it('goes red when a second hard link to a probed file appears elsewhere, through a store that holds the green', () => {
    put('.gitignore', 'solo.txt\nelsewhere.txt\n');
    commit();
    put('solo.txt', 'one name');
    const probed = { c: { roots: ['check.mjs', 'src'], probed: ['solo.txt'] } };
    const plan = () =>
      new Memo({ root, args: [], env: env(), baseRef: 'main', declarations: probed });
    const file = join(root, 'solo.txt');
    expect(run(plan(), { LINKED: file }).verdict.code).toBe(0);
    expect(run(plan(), { LINKED: file }).plan.kind).toBe('hit');
    linkSync(file, join(root, 'elsewhere.txt'));
    const linked = run(plan(), { LINKED: file });
    expect(linked.plan.kind).toBe('miss');
    expect(linked.status).toBe(1);
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
