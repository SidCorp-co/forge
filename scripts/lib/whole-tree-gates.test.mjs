import {
  ChildProcess,
  exec,
  execFile,
  execFileSync,
  execSync,
  spawn,
  spawnSync,
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  coversRoot,
  declarationExit,
  declarationsIn,
  fsListing,
  globListings,
  guardVerdict,
  judgeConfigs,
  judgeDeclarations,
  judgeGlobs,
  judgeRun,
  pathOf,
  runDirOf,
  spawnCwd,
  suiteMessage,
  vitestSetup,
} from './whole-tree-gates.mjs';
import { subprocessListing } from './whole-tree-shell.mjs';
import { spawnCall } from './whole-tree-watch.mjs';

const MARK = `@gate-${'input'}`;
const declared = (value, body = 'it();') => [`/**`, ` * ${MARK} ${value}`, ` */`, body].join('\n');
const WALKER_PATH = 'packages/core/src/pipeline/walks.test.ts';

const ROOT = '/repo';
const CORE = '/repo/packages/core';

describe('reading a declaration', () => {
  it('finds one in a docblock and one after //, with the line each sits on', () => {
    expect(declarationsIn(declared('whole-tree'))).toEqual([{ value: 'whole-tree', line: 2 }]);
    expect(declarationsIn(`x();\n// ${MARK} whole-tree`)).toEqual([
      { value: 'whole-tree', line: 2 },
    ]);
  });

  it('does not read one that is only quoted mid-line', () => {
    expect(declarationsIn(`const s = "// ${MARK} whole-tree";`)).toEqual([]);
  });
});

describe('which listed directory covers the root', () => {
  it('is the root itself or a directory above it', () => {
    expect(coversRoot(ROOT, ROOT)).toBe(true);
    expect(coversRoot(ROOT, '/')).toBe(true);
    expect(coversRoot(`${ROOT}/a/b`, ROOT)).toBe(true);
  });

  it('is never a directory inside the root, nor a sibling sharing its prefix', () => {
    expect(coversRoot(ROOT, `${ROOT}/docs`)).toBe(false);
    expect(coversRoot(ROOT, '/repo-other')).toBe(false);
    expect(coversRoot(ROOT, '/rep')).toBe(false);
  });

  describe('decided on canonical paths, whatever the spelling', () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'whole-tree-canon-')));
    mkdirSync(join(real, 'repo', 'docs'), { recursive: true });
    symlinkSync(join(real, 'repo'), join(real, 'link'));
    symlinkSync(join(real, 'loop'), join(real, 'loop'));
    afterAll(() => rmSync(real, { recursive: true, force: true }));
    const repo = join(real, 'repo');

    it('covers a symlink to the root, and the root reached through a /proc link', () => {
      expect(coversRoot(repo, join(real, 'link'))).toBe(true);
      expect(coversRoot(join(real, 'link'), repo)).toBe(true);
      const here = realpathSync(process.cwd());
      expect(coversRoot(here, `/proc/${process.pid}/cwd`)).toBe(true);
      expect(coversRoot(here, '/proc/self/cwd/..')).toBe(true);
    });

    it('covers a directory the kernel cannot resolve, and not a spelling of one inside', () => {
      expect(coversRoot(repo, join(real, 'loop'))).toBe(true);
      expect(coversRoot(repo, join(real, 'link', 'docs'))).toBe(false);
    });
  });
});

describe('what a node:fs call lists', () => {
  it('resolves a relative path against the directory the test runs in', () => {
    expect(fsListing('readdirSync', ['../..'], CORE)).toEqual([ROOT]);
    expect(fsListing('readdirSync', ['src'], CORE)).toEqual([`${CORE}/src`]);
  });

  it('reads a file URL, trailing slash and all, and a Buffer', () => {
    expect(fsListing('readdirSync', [pathToFileURL(`${ROOT}/`)], CORE)).toEqual([ROOT]);
    expect(fsListing('opendirSync', [Buffer.from('../..')], CORE)).toEqual([ROOT]);
    expect(fsListing('readdir', [new URL('https://example.com/')], CORE)).toEqual([]);
  });

  it('reads a URL by its shape, as Node does, so one from another realm is placed', () => {
    const foreign = { href: pathToFileURL(`${ROOT}/`).href, protocol: 'file:' };
    expect(fsListing('readdirSync', [foreign], CORE)).toEqual([ROOT]);
    expect(fsListing('readdirSync', [new TextEncoder().encode('../..')], CORE)).toEqual([ROOT]);
    expect(fsListing('readdirSync', [{ href: 'http://x/', protocol: 'http:' }], CORE)).toEqual([]);
  });

  it('gives a path it cannot read as null, which the watch counts as the root', () => {
    expect(fsListing('readdirSync', [42], CORE)).toEqual([null]);
    expect(fsListing('globSync', [[/x/]], CORE)).toEqual([null]);
    expect(fsListing('globSync', ['*', { cwd: 7 }], CORE)).toEqual([null]);
  });

  it('reads cp and cpSync as listing the tree they copy', () => {
    expect(fsListing('cpSync', ['../..', '/tmp/copy', { recursive: true }], CORE)).toEqual([ROOT]);
  });

  it('lists a glob from its cwd and the pattern’s segments before the first magic one', () => {
    expect(fsListing('globSync', ['**/*.md', { cwd: ROOT }], CORE)).toEqual([ROOT]);
    expect(fsListing('glob', ['../../docs/**/*.md'], CORE)).toEqual([`${ROOT}/docs`]);
    expect(fsListing('globSync', [['src/*.ts', '../../*']], CORE)).toEqual([`${CORE}/src`, ROOT]);
    expect(fsListing('globSync', [`${ROOT}/**`], CORE)).toEqual([ROOT]);
  });

  it('gives a glob climbing after a wildcard as null, since its prefix says nothing', () => {
    expect(fsListing('globSync', ['./*/../../../*.yaml'], CORE)).toEqual([null]);
  });

  describe('placed where the kernel resolves it', () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'whole-tree-real-')));
    mkdirSync(join(real, 'a', 'b'), { recursive: true });
    symlinkSync(join(real, 'a', 'b'), join(real, 'link'));
    afterAll(() => rmSync(real, { recursive: true, force: true }));

    it('follows a symlink, and its `..` from where the link points', () => {
      expect(fsListing('readdirSync', [join(real, 'link')], '/')).toEqual([join(real, 'a', 'b')]);
      expect(fsListing('readdirSync', [`${real}/link/..`], '/')).toEqual([join(real, 'a')]);
      expect(fsListing('readdirSync', ['link/..'], real)).toEqual([join(real, 'a')]);
    });

    it.runIf(existsSync('/proc/self/cwd'))('follows /proc/self/cwd to the directory it is', () => {
      expect(fsListing('readdirSync', ['/proc/self/cwd/..'], '/')).toEqual([
        dirname(realpathSync(process.cwd())),
      ]);
    });
  });
});

describe('the path Node reads off an argument', () => {
  it('is a string, the bytes of a Buffer or byte array, or the path a file URL names', () => {
    expect(pathOf('../..')).toBe('../..');
    expect(pathOf(Buffer.from('/a/b'))).toBe('/a/b');
    expect(pathOf(new TextEncoder().encode('/a/b'))).toBe('/a/b');
    expect(pathOf(pathToFileURL('/a/b/'))).toBe('/a/b/');
    expect(pathOf({ href: 'file:///a/b', protocol: 'file:' })).toBe('/a/b');
  });

  it('is null for a URL of another scheme, and for anything that is not a path', () => {
    for (const value of [new URL('http://localhost:3000/@fs/a'), 42, {}, [], null, () => '/a']) {
      expect(pathOf(value)).toBeNull();
    }
  });
});

describe('the directory a spawn runs in', () => {
  it('is where the test runs when no cwd is handed', () => {
    for (const cwd of [undefined, null, '']) expect(spawnCwd(cwd, CORE)).toBe(CORE);
  });

  it('is a relative cwd resolved from there, and the directory a file URL names', () => {
    expect(spawnCwd('../..', CORE)).toBe(ROOT);
    expect(spawnCwd(Buffer.from('src'), CORE)).toBe(`${CORE}/src`);
    expect(spawnCwd(pathToFileURL(`${ROOT}/`), CORE)).toBe(ROOT);
    expect(spawnCwd(new URL('../../..', pathToFileURL(`${CORE}/src/a.test.ts`)), CORE)).toBe(ROOT);
  });

  describe('placed where the kernel’s chdir lands', () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'whole-tree-cwd-')));
    mkdirSync(join(real, 'repo', 'packages', 'core'), { recursive: true });
    symlinkSync(join(real, 'repo'), join(real, 'link'));
    symlinkSync(join(real, 'repo', 'packages', 'core'), join(real, 'core'));
    symlinkSync(join(real, 'loop'), join(real, 'loop'));
    afterAll(() => rmSync(real, { recursive: true, force: true }));

    it('follows a symlink, and its `..` from where the link points', () => {
      expect(spawnCwd(join(real, 'link'), '/')).toBe(join(real, 'repo'));
      expect(spawnCwd('core/../..', real)).toBe(join(real, 'repo'));
      expect(spawnCwd(pathToFileURL(join(real, 'link')), '/')).toBe(join(real, 'repo'));
    });

    it.runIf(existsSync('/proc/self/cwd'))('follows a /proc cwd link before its `..`', () => {
      const up = dirname(dirname(realpathSync(process.cwd())));
      expect(spawnCwd(`/proc/${process.pid}/cwd/../..`, '/')).toBe(up);
      expect(spawnCwd('/proc/self/cwd/../..', '/')).toBe(up);
    });

    it('throws on a cwd the kernel cannot resolve, which the watch counts as the root', () => {
      expect(() => spawnCwd(join(real, 'loop'), '/')).toThrow(/a spawn cwd the guard cannot place/);
    });
  });

  it('throws on a cwd Node would not take as a path, which the watch counts as the root', () => {
    for (const cwd of [new URL('http://localhost:3000/@fs/repo'), 7, {}]) {
      expect(() => spawnCwd(cwd, CORE)).toThrow(/a spawn cwd the guard cannot place/);
    }
  });
});

describe('what a spawner call runs', () => {
  it('reads a fork as the execPath it names, and as Node without one', () => {
    const call = spawnCall('fork', ['../..', [], { execPath: '/bin/ls', execArgv: [] }]);
    expect([call.command, call.args]).toEqual(['/bin/ls', ['../..']]);
    expect(subprocessListing({ ...call, cwd: CORE, root: ROOT }).map((e) => e.dir)).toEqual([ROOT]);
    expect(spawnCall('fork', ['./child.mjs', ['x']]).command).toBe(process.execPath);
  });

  it('reads exec as a shell string and spawn with shell: true the same way', () => {
    expect(spawnCall('exec', ['ls ../..']).shell).toBe(true);
    expect(spawnCall('spawn', ['ls', ['../..'], { shell: true }]).shell).toBe(true);
    expect(spawnCall('spawnSync', ['ls', ['../..']]).shell).toBe(false);
  });
});

describe('what a run owes after it listed the root', () => {
  const hit = (dir, at = 'packages/core/src/pipeline/walks.fixture.ts:5') => ({
    dir,
    via: 'readdirSync()',
    at,
  });

  it('refuses an undeclared file, naming the file, the listing, its call site and the line to add', () => {
    const why = guardVerdict({ file: WALKER_PATH, source: 'it();', hits: [hit(ROOT)], root: ROOT });
    expect(why).toBe(
      `whole-tree-gates: ${WALKER_PATH} readdirSync() listed the repository root (called at packages/core/src/pipeline/walks.fixture.ts:5), ` +
        'so its input is the whole tree and not the paths its job is selected by, and a change outside them skips it — add a line ' +
        `\`// ${MARK} whole-tree\` (or \` * ${MARK} whole-tree\` in its opening docblock) so it runs on every change`,
    );
  });

  it('names a directory above the root as that, and counts past three', () => {
    const hits = [hit('/'), hit(ROOT), hit(ROOT), hit(ROOT), hit(ROOT, null)];
    const why = guardVerdict({ file: WALKER_PATH, source: '', hits, root: ROOT });
    expect(why).toContain('readdirSync() listed /, above the repository root');
    expect(why).toContain(', and 2 more,');
  });

  it('owes nothing for a declared file, nor for a listing inside the root', () => {
    const source = declared('whole-tree');
    expect(guardVerdict({ file: WALKER_PATH, source, hits: [hit(ROOT)], root: ROOT })).toBeNull();
    const inside = [hit(`${ROOT}/packages/core`)];
    expect(guardVerdict({ file: WALKER_PATH, source: '', hits: inside, root: ROOT })).toBeNull();
  });

  it('does not take a declaration with a wrong value as a declaration', () => {
    const source = declared('wholetree');
    expect(guardVerdict({ file: WALKER_PATH, source, hits: [hit(ROOT)], root: ROOT })).toContain(
      'listed the repository root',
    );
  });
});

describe('the guard installed in this very run', () => {
  const REPO = resolve(import.meta.dirname, '..', '..');
  const state = globalThis[Symbol.for('forge.whole-tree-guard')];
  const covering = () => state.hits.filter((h) => coversRoot(REPO, h.dir));
  // Every case here lists the root on purpose, so each clears what it recorded before `afterAll`
  // would refuse this undeclared file for it.
  afterEach(() => {
    state.hits = [];
  });

  it('is installed by the configuration that collects this file', () => {
    expect(state?.installed).toBe(true);
  });

  it('sees a named node:fs import list the root, with this file as the call site', () => {
    readdirSync(join(REPO, 'packages', '..'));
    expect(covering()).toEqual([
      expect.objectContaining({
        dir: REPO,
        via: 'readdirSync()',
        at: expect.stringMatching(/^scripts\/lib\/whole-tree-gates\.test\.mjs:\d+$/),
      }),
    ]);
  });

  it('sees node:fs/promises and a git subprocess list it', async () => {
    await readdir(REPO);
    execFileSync('git', ['ls-files', '--', '[p]ackage.json'], { cwd: REPO });
    expect(covering().map((h) => h.via)).toEqual([
      'readdir()',
      'execFileSync() running git ls-files',
    ]);
  });

  it('sees a program list it from a cwd handed as a file URL', () => {
    const cwd = pathToFileURL(`${REPO}/`);
    execFileSync('git', ['ls-files', '--', '[p]ackage.json'], { cwd });
    execSync('ls >/dev/null', { cwd });
    spawnSync('git', ['grep', '-l', 'no-such-text-anywhere'], { cwd, stdio: 'ignore' });
    expect(covering().map((h) => h.via)).toEqual([
      'execFileSync() running git ls-files',
      'execSync() running ls',
      'spawnSync() running git grep',
    ]);
  });

  it('counts a spawn whose cwd it cannot place as the root, and Node refuses to run it', () => {
    const cwd = new URL('http://localhost:3000/@fs/');
    expect(() => execFileSync('ls', [], { cwd })).toThrow(/scheme file/);
    expect(covering()).toEqual([
      expect.objectContaining({
        dir: REPO,
        via: expect.stringMatching(/^execFileSync\(\) with an argument the guard cannot place/),
      }),
    ]);
  });

  it('keeps promisify(execFile) resolving to stdout and stderr, and watches it too', async () => {
    const out = await promisify(execFile)('git', ['ls-files', '--', '[p]ackage.json'], {
      cwd: REPO,
    });
    expect(out.stdout.trim()).toBe('package.json');
    expect(out.stderr).toBe('');
    expect(covering().map((h) => h.via)).toEqual(['execFile() running git ls-files']);
  });

  it('sees a Node child list it, a call handing its own env included', () => {
    const script = `require('node:fs').readdirSync(${JSON.stringify(REPO)})`;
    spawnSync(process.execPath, ['-e', script], { env: { PATH: process.env.PATH } });
    const logged = readFileSync(state.log, 'utf8').trim().split('\n').filter(Boolean);
    writeFileSync(state.log, '');
    expect(logged.map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({
        dir: REPO,
        via: expect.stringMatching(/^readdirSync\(\) in child process \d+$/),
        at: null,
      }),
    ]);
  });

  it('sees an eval worker list it', async () => {
    const code = `require('node:fs').readdirSync(${JSON.stringify(REPO)});`;
    await new Promise((done, fail) =>
      new Worker(code, { eval: true }).on('exit', done).on('error', fail),
    );
    const logged = readFileSync(state.log, 'utf8').trim().split('\n').filter(Boolean);
    writeFileSync(state.log, '');
    expect(logged.map((l) => JSON.parse(l).via)).toEqual([
      expect.stringMatching(/^readdirSync\(\) in worker \d+ of process \d+$/),
    ]);
  });

  it('sees a worker thread list it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whole-tree-worker-'));
    const file = join(dir, 'lists.mjs');
    writeFileSync(
      file,
      `import { readdirSync } from 'node:fs'; readdirSync(${JSON.stringify(REPO)});`,
    );
    await new Promise((done, fail) => new Worker(file).on('exit', done).on('error', fail));
    rmSync(dir, { recursive: true, force: true });
    const logged = readFileSync(state.log, 'utf8').trim().split('\n').filter(Boolean);
    writeFileSync(state.log, '');
    expect(logged.map((l) => JSON.parse(l).dir)).toEqual([REPO]);
  });

  it('counts a directory a shell moved to by a substitution as the root', () => {
    execFileSync('sh', ['-c', 'cd "$(pwd)" && ls >/dev/null'], { cwd: import.meta.dirname });
    expect(covering().map((h) => h.via)).toEqual([
      'execFileSync() running ls (at a directory or word the guard cannot evaluate, so counted as the root)',
    ]);
  });

  it('counts a program it cannot see into as the root, wherever it runs', () => {
    spawnSync('sh', [join(import.meta.dirname, 'no-such-script.sh')], { stdio: 'ignore' });
    expect(covering()).toEqual([
      expect.objectContaining({
        dir: REPO,
        via: expect.stringMatching(/^spawnSync\(\) running `sh` running .*no-such-script\.sh/),
      }),
    ]);
  });

  it('counts an executable a dependency spawns from its own callback, but a reviewed helper', async () => {
    const dep = mkdtempSync(join(tmpdir(), 'whole-tree-dep-'));
    const lib = join(dep, 'node_modules', 'lister');
    mkdirSync(join(lib, 'bin'), { recursive: true });
    writeFileSync(
      join(lib, 'index.mjs'),
      "import { spawnSync } from 'node:child_process';\n" +
        "export const later = (bin) => new Promise((done) => setTimeout(() => { spawnSync(bin, [], { stdio: 'ignore' }); done(); }, 0));",
    );
    const { later } = await import(pathToFileURL(join(lib, 'index.mjs')).href);
    await later(join(lib, 'bin', 'walk'));
    await later(join(lib, 'bin', 'esbuild'));
    rmSync(dep, { recursive: true, force: true });
    expect(covering()).toEqual([
      expect.objectContaining({
        at: null,
        via: expect.stringContaining('/node_modules/lister/bin/walk'),
      }),
    ]);
  });

  it('sees a ChildProcess spawned directly list it, and a spawn read once', async () => {
    const child = new ChildProcess();
    child.spawn({ file: 'ls', args: ['ls', REPO], stdio: ['ignore', 'ignore', 'ignore'] });
    await new Promise((done) => child.on('exit', done));
    const direct = spawn('ls', [REPO], { stdio: 'ignore' });
    await new Promise((done) => direct.on('exit', done));
    expect(covering().map((h) => h.via)).toEqual([
      'ChildProcess#spawn() running ls',
      'spawn() running ls',
    ]);
  });

  it('reads exec once, not again as the execFile it runs', async () => {
    await promisify(exec)(`ls ${REPO}`);
    expect(covering().map((h) => h.via)).toEqual(['exec() running ls']);
  });

  it('sees a listing through a symlink to it, or through a symlink’s `..`', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whole-tree-link-'));
    symlinkSync(REPO, join(dir, 'repo'));
    symlinkSync(join(REPO, 'scripts'), join(dir, 'scripts'));
    readdirSync(join(dir, 'repo'));
    readdirSync(`${dir}/scripts/..`);
    rmSync(dir, { recursive: true, force: true });
    expect(covering().map((h) => h.dir)).toEqual([REPO, REPO]);
  });

  it('sees git list it from a cwd that is a symlink to it, or a /proc cwd link climbed to it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whole-tree-cwd-link-'));
    symlinkSync(REPO, join(dir, 'repo'));
    const up = relative(process.cwd(), REPO);
    const args = ['ls-files', '--', '[p]ackage.json'];
    execFileSync('git', args, { cwd: join(dir, 'repo') });
    spawnSync('git', ['grep', '-l', 'no-such-text-anywhere'], {
      cwd: join(dir, 'repo'),
      stdio: 'ignore',
    });
    execFileSync('git', args, { cwd: `/proc/${process.pid}/cwd/${up}` });
    execSync('git ls-files -- "[p]ackage.json" >/dev/null', { cwd: `/proc/self/cwd/${up}` });
    rmSync(dir, { recursive: true, force: true });
    expect(covering().map((h) => [h.via, h.dir])).toEqual([
      ['execFileSync() running git ls-files', REPO],
      ['spawnSync() running git grep', REPO],
      ['execFileSync() running git ls-files', REPO],
      ['execSync() running git ls-files', REPO],
    ]);
  });

  it('records nothing covering the root for a listing inside it', () => {
    readdirSync(import.meta.dirname);
    expect(covering()).toEqual([]);
  });
});

describe('a run of a file that lists the root', () => {
  const REPO = resolve(import.meta.dirname, '..', '..');
  const dir = mkdtempSync(join(tmpdir(), 'whole-tree-guard-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const config = `export default { test: { globals: true, include: ['*.test.mjs'], setupFiles: [${JSON.stringify(join(REPO, 'scripts/lib/whole-tree-guard.mjs'))}] } };`;
  writeFileSync(join(dir, 'vitest.config.mjs'), config);
  const body = [
    "import { readdirSync } from 'node:fs';",
    "it('lists the root', () => { expect(readdirSync(process.env.WT_ROOT)).toContain('pnpm-workspace.yaml'); });",
  ];
  // The vitest this suite runs under, started on a scratch root that holds nothing but the file.
  // Its own main process expands the glob case's pattern over the root, which the preload reports
  // to this file's guard: that listing is the subject here, so it is cleared once read.
  const vitest = (file) => {
    const r = spawnSync(
      process.execPath,
      [join(REPO, 'node_modules/vitest/vitest.mjs'), 'run', '--root', dir, file],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, WT_ROOT: REPO, FORCE_COLOR: '0' } },
    );
    writeFileSync(globalThis[Symbol.for('forge.whole-tree-guard')].log, '');
    return r;
  };

  it('fails an undeclared one in afterAll, naming the file, the listing and the line to add', () => {
    writeFileSync(join(dir, 'plain.test.mjs'), body.join('\n'));
    const r = vitest('plain.test.mjs');
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(
      /plain\.test\.mjs readdirSync\(\) listed the repository root \(called at [^)]*plain\.test\.mjs:2\)[^\n]*add a line `\/\/ @gate-input whole-tree`/,
    );
  }, 60_000);

  it('fails an undeclared one whose own import.meta.glob covers the root', () => {
    const pattern = `${relative(dir, REPO)}/*.json`;
    writeFileSync(
      join(dir, 'globs.test.mjs'),
      `const found = import.meta.glob('${pattern}');\nit('globs', () => { expect(Object.keys(found).length).toBeGreaterThan(0); });`,
    );
    const r = vitest('globs.test.mjs');
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain(
      `globs.test.mjs import.meta.glob('${pattern}') listed the repository root`,
    );
  }, 60_000);

  it('passes the same file once it carries the declaration', () => {
    writeFileSync(join(dir, 'marked.test.mjs'), [`// ${MARK} whole-tree`, ...body].join('\n'));
    const r = vitest('marked.test.mjs');
    expect(`${r.stdout}${r.stderr}`).not.toContain('listed the repository root');
    expect(r.status).toBe(0);
  }, 60_000);
});

describe('what an import.meta.glob lists', () => {
  const REPO = resolve(import.meta.dirname, '..', '..');
  const ts = createRequire(join(REPO, 'packages/core/package.json'))('typescript');
  const file = join(REPO, 'packages/core/src/pipeline/globs.test.ts');
  const at = (source) => globListings({ source, file, root: REPO, ts });
  const call = (args) => `const g = import.meta.glob(${args});`;

  it('resolves a relative pattern from the file, and a rooted one from its package', () => {
    expect(at(call("'../../../../**/*.md', { eager: true }"))).toEqual([
      {
        dir: REPO,
        via: "import.meta.glob('../../../../**/*.md')",
        at: 'packages/core/src/pipeline/globs.test.ts:1',
        call: "import.meta.glob('../../../../**/*.md')",
        line: 1,
        resolved: true,
      },
    ]);
    expect(at(call("'/src/**/*.ts'")).map((g) => g.dir)).toEqual([join(REPO, 'packages/core/src')]);
    expect(at(call("'**/*.ts'")).map((g) => g.dir)).toEqual([join(REPO, 'packages/core')]);
    expect(at(call('`./fixtures/*.json`')).map((g) => g.dir)).toEqual([
      join(REPO, 'packages/core/src/pipeline/fixtures'),
    ]);
  });

  it('reads each pattern of an array, and a negated one as listing nothing', () => {
    expect(
      at(call("['./a/*.ts', '!./a/b.ts', '../../../../docs/*.md']")).map((g) => g.dir),
    ).toEqual([join(REPO, 'packages/core/src/pipeline/a'), join(REPO, 'docs')]);
  });

  it('counts an alias, a # import and a pattern that is not a literal as the root', () => {
    const substituted = `\`$${'{dir}'}/*.md\``;
    for (const args of ["'@/x/*.ts'", "'#fixtures/*'", 'PATTERN', substituted]) {
      const [g] = at(call(args));
      expect(g.dir).toBe(REPO);
      expect(g.via).toContain('a pattern the guard cannot resolve, so counted as the root');
      expect(g.resolved).toBe(false);
    }
    const [refused] = judgeGlobs({
      files: [{ path: 'packages/core/src/pipeline/globs.test.ts', source: call("'@/x/*.ts'") }],
      root: REPO,
      ts,
    });
    expect(refused.why).toMatch(
      /^line 1 expands import\.meta\.glob\('@\/x\/\*\.ts'\) with a pattern the guard cannot resolve \(an alias, a `#` import, not a literal, or a '\.\.' after a wildcard\), which counts as the root before the test runs/,
    );
  });

  it('counts a pattern climbing after a wildcard as the root, which vite resolves past its prefix', () => {
    const [g] = at(call("'./../*/../../../../**/*.md', { eager: true }"));
    expect(g).toEqual(
      expect.objectContaining({
        dir: REPO,
        resolved: false,
        via: "import.meta.glob('./../*/../../../../**/*.md') (a '..' after a wildcard, which ends wherever the matches lead, so counted as the root)",
      }),
    );
    const [refused] = judgeGlobs({
      files: [
        {
          path: 'packages/core/src/pipeline/globs.test.ts',
          source: call("'./../*/../../../../**/*.md'"),
        },
      ],
      root: REPO,
      ts,
    });
    expect(refused.why).toContain("a '..' after a wildcard");
  });

  it('reads a call, never the same text in a string or a comment', () => {
    const quoted = [
      `const s = "import.meta.glob('../../../../**')";`,
      `// import.meta.glob('../../../../**')`,
    ].join('\n');
    expect(at(quoted)).toEqual([]);
  });

  it('refuses a root glob in an undeclared test and in any module, and passes a declared test', () => {
    const glob = call("'../../../../**/*.md'");
    const files = [
      { path: 'packages/core/src/pipeline/globs.test.ts', source: glob },
      { path: 'packages/core/src/pipeline/docs-index.ts', source: glob },
      {
        path: 'packages/core/src/pipeline/marked.test.ts',
        source: `// ${MARK} whole-tree\n${glob}`,
      },
      { path: 'packages/core/src/pipeline/local.test.ts', source: call("'./x/*.ts'") },
    ];
    const refused = judgeGlobs({ files, root: REPO, ts });
    expect(refused.map((r) => r.path)).toEqual([
      'packages/core/src/pipeline/globs.test.ts',
      'packages/core/src/pipeline/docs-index.ts',
    ]);
    expect(refused[0].why).toContain(
      `line 1 expands import.meta.glob('../../../../**/*.md') from the repository root`,
    );
    expect(refused[0].why).toContain(`add a line \`// ${MARK} whole-tree\``);
    expect(refused[1].why).toContain('a declaration cannot travel with an import of a module');
  });
});

describe('judging the declarations', () => {
  it('selects a declared test wherever it lives, since the declaration moves with it', () => {
    const files = [
      { path: WALKER_PATH, source: declared('whole-tree') },
      { path: 'packages/web-v2/src/moved/walks.test.ts', source: declared('whole-tree') },
    ];
    const out = judgeDeclarations({ files });
    expect(out.declared).toEqual([
      'packages/core/src/pipeline/walks.test.ts',
      'packages/web-v2/src/moved/walks.test.ts',
    ]);
    expect(out.refused).toEqual([]);
    expect(declarationExit(out)).toBe(0);
  });

  it('refuses a value other than whole-tree, naming the value and the valid shape', () => {
    const out = judgeDeclarations({
      files: [{ path: WALKER_PATH, source: declared('wholetree') }],
    });
    expect(out.declared).toEqual([]);
    expect(out.refused[0].why).toBe(
      `line 2 declares \`${MARK} wholetree\`, and the only valid shape is \`${MARK} whole-tree\``,
    );
  });

  it('refuses a declaration with no value at all', () => {
    const out = judgeDeclarations({ files: [{ path: WALKER_PATH, source: declared('') }] });
    expect(out.refused[0].why).toContain(`${MARK} (nothing)`);
  });

  it('refuses a declaration in a file no vitest configuration could run', () => {
    const out = judgeDeclarations({
      files: [{ path: 'packages/runner/src/lib.rs', source: `// ${MARK} whole-tree` }],
    });
    expect(out.declared).toEqual([]);
    expect(out.refused[0].why).toContain('not a JavaScript test file');
  });

  it('reads a tree that declares nothing as an empty scope, never as a pass', () => {
    const out = judgeDeclarations({ files: [{ path: 'a/b.test.ts', source: 'it()' }] });
    expect(out.tests).toBe(1);
    expect(declarationExit(out)).toBe(2);
  });
});

describe('judging the vitest configurations', () => {
  const guard = `${ROOT}/scripts/lib/whole-tree-guard.mjs`;

  it('passes one whose resolved test.setupFiles holds the guard', () => {
    const configs = [
      { path: 'packages/core/vitest.config.ts', root: CORE, setupFiles: [`${CORE}/s.ts`, guard] },
    ];
    expect(judgeConfigs(configs, ROOT)).toEqual([]);
  });

  it('refuses one that does not, naming the path to add from the root vitest resolves it at', () => {
    const configs = [
      {
        path: 'packages/extra/vitest.config.ts',
        root: `${ROOT}/packages/extra`,
        setupFiles: [`${ROOT}/packages/extra/setup.ts`],
      },
      { path: 'vitest.config.ts', root: ROOT, setupFiles: [] },
      { path: 'packages/core/tests/nested/vitest.config.ts', root: CORE, setupFiles: [] },
    ];
    expect(judgeConfigs(configs, ROOT)).toEqual([
      {
        path: 'packages/extra/vitest.config.ts',
        why: "does not install the guard that refuses an undeclared root walk — add '../../scripts/lib/whole-tree-guard.mjs' to its `test.setupFiles`",
      },
      {
        path: 'vitest.config.ts',
        why: "does not install the guard that refuses an undeclared root walk — add 'scripts/lib/whole-tree-guard.mjs' to its `test.setupFiles`",
      },
      {
        path: 'packages/core/tests/nested/vitest.config.ts',
        why: "does not install the guard that refuses an undeclared root walk — add '../../scripts/lib/whole-tree-guard.mjs' to its `test.setupFiles`",
      },
    ]);
  });

  describe('resolved by the vitest this suite runs under', () => {
    const REPO = resolve(import.meta.dirname, '..', '..');
    const VITEST_NODE = createRequire(join(REPO, 'package.json')).resolve('vitest/node');
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'whole-tree-config-')));
    mkdirSync(join(dir, 'sub'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    // Loading a configuration starts vite's esbuild service from this file's frame, which the
    // guard counts as a program it cannot see into; that spawn is dropped, and nothing else is.
    const guard = globalThis[Symbol.for('forge.whole-tree-guard')];
    afterEach(() => {
      guard.hits = guard.hits.filter(
        (h) => !/\/node_modules\/@esbuild\/[^/]+\/bin\/esbuild`/.test(h.via),
      );
    });
    const write = (name, test, vite = {}) => {
      const path = join(dir, 'sub', name);
      writeFileSync(path, `export default ${JSON.stringify({ ...vite, test })};`);
      return path;
    };

    it('reads setupFiles from the configuration’s own test.root, wherever it is run from', () => {
      const path = write('vitest.rooted.config.mjs', { root: dir, setupFiles: ['./setup.mjs'] });
      for (const cwd of [dir, join(dir, 'sub')]) {
        expect(vitestSetup(path, VITEST_NODE, cwd)).toEqual({
          root: dir,
          setupFiles: [join(dir, 'setup.mjs')],
        });
      }
    });

    it('reads them from the directory it is run from where it names no root', () => {
      const path = write('vitest.config.mjs', { setupFiles: ['./setup.mjs'] });
      expect(vitestSetup(path, VITEST_NODE, dir)).toEqual({
        root: dir,
        setupFiles: [join(dir, 'setup.mjs')],
      });
    });

    it('reads Vite’s top-level root from there too, and lets test.root beat it', () => {
      const vite = write(
        'vitest.vite-root.config.mjs',
        { setupFiles: ['./s.mjs'] },
        { root: 'sub' },
      );
      expect(vitestSetup(vite, VITEST_NODE, dir)).toEqual({
        root: join(dir, 'sub'),
        setupFiles: [join(dir, 'sub', 's.mjs')],
      });
      const both = write(
        'vitest.both.config.mjs',
        { root: dir, setupFiles: ['./s.mjs'] },
        { root: 'sub' },
      );
      expect(vitestSetup(both, VITEST_NODE, dir).root).toBe(dir);
    });

    it('throws what vitest said for a configuration it cannot load', () => {
      const path = join(dir, 'sub', 'vitest.broken.config.mjs');
      writeFileSync(path, 'export default {');
      expect(() => vitestSetup(path, VITEST_NODE, dir)).toThrow(
        /vitest\.broken\.config\.mjs|Unexpected/,
      );
    });
  });

  it('runs a configuration from its package’s directory, wherever inside it the file sits', () => {
    const REPO = resolve(import.meta.dirname, '..', '..');
    const isolation = join(REPO, 'packages/core/tests/helpers/file-isolation/vitest.config.ts');
    expect(runDirOf(isolation, REPO)).toBe(join(REPO, 'packages', 'core'));
    expect(runDirOf(join(REPO, 'packages/web-v2/vitest.config.ts'), REPO)).toBe(
      join(REPO, 'packages', 'web-v2'),
    );
  });

  it('refuses one vitest could not load, rather than trusting it', () => {
    const configs = [{ path: 'packages/core/vitest.config.ts', error: 'Unexpected token' }];
    expect(judgeConfigs(configs, ROOT)[0].why).toBe(
      'could not be loaded by vitest, so whether it installs the guard is unknown: Unexpected token',
    );
  });
});

describe('the message a failed suite is refused with', () => {
  it('carries a header ending in a colon on to the error it introduces', () => {
    const message =
      'Transform failed with 1 error:\n/x/a.test.ts:4:0: ERROR: Unexpected end of file\n  at y';
    expect(suiteMessage(message)).toBe(
      'Transform failed with 1 error: /x/a.test.ts:4:0: ERROR: Unexpected end of file',
    );
  });

  it('keeps one line that stands on its own, with the colour codes gone', () => {
    expect(suiteMessage("\u001b[31mCannot find module './gone.js'\u001b[39m\nstack")).toBe(
      "Cannot find module './gone.js'",
    );
    expect(suiteMessage('')).toBeNull();
    expect(suiteMessage(undefined)).toBeNull();
  });
});

describe('judging the run', () => {
  const one = ['packages/core/src/pipeline/walks.test.ts'];
  const collected = { 'packages/core/vitest.config.ts': one };

  it('passes a declared file that a configuration collected and that ran a case', () => {
    expect(judgeRun({ declared: one, collected, executed: { [one[0]]: 14 } }).refused).toEqual([]);
  });

  it('refuses a declared file no configuration collected', () => {
    const out = judgeRun({ declared: one, collected: {}, executed: { [one[0]]: 0 } });
    expect(out.refused[0].why).toContain('no vitest configuration collects it');
  });

  it('refuses a declared file that ran no case, as when every case is skipped', () => {
    const out = judgeRun({ declared: one, collected, executed: { [one[0]]: 0 } });
    expect(out.refused[0].why).toContain('executed no case');
  });

  it('names a suite that failed before any case ran by its error, never as a skip', () => {
    const suiteErrors = { [one[0]]: 'Error: the tree could not be listed' };
    const out = judgeRun({ declared: one, collected, executed: { [one[0]]: 0 }, suiteErrors });
    expect(out.refused).toHaveLength(1);
    expect(out.refused[0].why).toBe(
      'failed before any of its cases ran: Error: the tree could not be listed — fix what it imports, evaluates at load or throws in a hook; the declaration stays',
    );
  });
});
