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
  cpSync,
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
import { SHARE_ENV, Worker } from 'node:worker_threads';
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
  logLines,
  pathOf,
  processRunning,
  runDirOf,
  spawnCwd,
  suiteMessage,
  unjudgedVerdict,
  vitestSetup,
} from './whole-tree-gates.mjs';
import { subprocessListing } from './whole-tree-shell.mjs';
import { LOG_ENV, spawnCall } from './whole-tree-watch.mjs';

const MARK = `@gate-${'input'}`;
const OPTIONS = 'NODE_OPTIONS';
const declared = (value, body = 'it();') => [`/**`, ` * ${MARK} ${value}`, ` */`, body].join('\n');
const WALKER_PATH = 'packages/core/src/pipeline/walks.test.ts';

const ROOT = '/repo';
const CORE = '/repo/packages/core';

/** An asymmetric matcher for a string that begins with `prefix`, compared as text. */
function startingWith(prefix) {
  return {
    asymmetricMatch: (actual) => typeof actual === 'string' && actual.startsWith(prefix),
    toString: () => 'StringStartingWith',
    toAsymmetricMatcher: () => `StringStartingWith ${JSON.stringify(prefix)}`,
  };
}
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
    expect(spawnCall('execSync', ['ls', { shell: '/usr/bin/zsh' }]).shell).toBe('/usr/bin/zsh');
    const zsh = { ...spawnCall('exec', ['ls', { shell: 'zsh' }]), cwd: CORE, root: ROOT };
    expect(subprocessListing(zsh).map((e) => e.dir)).toEqual([ROOT]);
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

  it('says once that a listing it could not read was counted as the root (j13)', () => {
    const counted = {
      dir: ROOT,
      via: 'execFileSync() running `ls` is not git, grep or node, so counted as listing the repository root',
      at: 'packages/core/src/x.test.ts:3',
      unseen: true,
    };
    const why = guardVerdict({ file: WALKER_PATH, source: '', hits: [counted], root: ROOT });
    expect(why).toContain(
      `${WALKER_PATH} execFileSync() running \`ls\` is not git, grep or node, so counted as listing the repository root (called at packages/core/src/x.test.ts:3), so its input`,
    );
    expect(why).not.toContain('listed the repository root');
  });

  it('refuses a file it cannot judge, naming why, whatever it listed (j13)', () => {
    const unnamed = unjudgedVerdict({
      file: null,
      why: 'vitest named no test file',
      hits: [],
      root: ROOT,
    });
    expect(unnamed).toMatch(/^whole-tree-gates: a test file: vitest named no test file, so /);
    const gone = unjudgedVerdict({
      file: WALKER_PATH,
      why: 'its source could not be read (ENOENT)',
      hits: [hit(ROOT), hit('/'), hit(`${ROOT}/packages`)],
      root: ROOT,
    });
    expect(gone).toMatch(
      new RegExp(
        `^whole-tree-gates: ${WALKER_PATH}: its source could not be read \\(ENOENT\\), so `,
      ),
    );
    expect(gone).toContain('2 listing(s) it made');
  });

  it('names its own globs as what would pass unjudged when it listed nothing (j14)', () => {
    const why = unjudgedVerdict({
      file: WALKER_PATH,
      why: 'its source could not be read (ENOENT)',
      hits: [hit(`${ROOT}/packages`)],
      root: ROOT,
    });
    expect(why).not.toMatch(/\d+ listing\(s\)/);
    expect(why).toContain(
      '; it made no listing covering the repository root, but whatever those calls list would pass unjudged;',
    );
    expect(why).toContain('its own `import.meta.glob` calls');
  });

  it('does not take a declaration with a wrong value as a declaration', () => {
    const source = declared('wholetree');
    expect(guardVerdict({ file: WALKER_PATH, source, hits: [hit(ROOT)], root: ROOT })).toContain(
      'listed the repository root',
    );
  });
});

describe('reading a child log', () => {
  const bytes = (text) => Buffer.from(text, 'utf8');
  it('reads each whole line once, and a line appended after a read on the next', () => {
    const first = logLines(bytes('{"started":1}\n{"dir":"/r"}\n'), 0);
    expect(first.lines).toEqual([{ started: 1 }, { dir: '/r' }]);
    const next = logLines(bytes('{"started":1}\n{"dir":"/r"}\n{"dir":"/late"}\n'), first.offset);
    expect(next.lines).toEqual([{ dir: '/late' }]);
  });
  it('leaves a line its writer has not ended for the next read', () => {
    const part = logLines(bytes('{"dir":"/a"}\n{"dir":"/b'), 0);
    expect(part.lines).toEqual([{ dir: '/a' }]);
    expect(logLines(bytes('{"dir":"/a"}\n{"dir":"/b"}\n'), part.offset).lines).toEqual([
      { dir: '/b' },
    ]);
  });
  it('says a line is pending while the log ends mid-line, and not once it ends on a newline', () => {
    expect(logLines(bytes('{"dir":"/a"}\n{"dir"'), 0).pending).toBe(true);
    expect(logLines(bytes('{"dir":"/a"}\n'), 0).pending).toBe(false);
  });
  it('hands back a line that is not a record as such, rather than throwing on it', () => {
    expect(logLines(bytes('{"dir":"/a"}\nnot a record\n'), 0).lines).toEqual([
      { dir: '/a' },
      { malformed: 'not a record' },
    ]);
  });
  it('reads a log emptied since the last read from its start', () => {
    expect(logLines(bytes('{"dir":"/c"}\n'), 400).lines).toEqual([{ dir: '/c' }]);
  });
});

describe('whether a process a file started is still running', () => {
  const fail = (code) => () => {
    throw Object.assign(new Error(code), { code });
  };
  const ok = () => {};
  it('ends only on its absence or a zombie state', () => {
    expect(processRunning(1, { signal: fail('ESRCH'), stat: ok })).toBe(false);
    expect(processRunning(1, { signal: ok, stat: () => '1 (node) Z 0' })).toBe(false);
    expect(processRunning(1, { signal: ok, stat: fail('ENOENT') })).toBe(false);
    expect(processRunning(1, { signal: ok, stat: () => '1 (node) S 0' })).toBe(true);
  });
  it('is running wherever its state cannot be read', () => {
    expect(processRunning(1, { signal: fail('EPERM'), stat: ok })).toBe(true);
    expect(processRunning(1, { signal: ok, stat: fail('EACCES') })).toBe(true);
  });
});

describe('the guard installed in this very run', () => {
  const REPO = resolve(import.meta.dirname, '..', '..');
  const state = globalThis[Symbol.for('forge.whole-tree-guard')];
  const covering = () => state.hits.filter((h) => coversRoot(REPO, h.dir));
  const vias = () => covering().map((h) => h.via);
  /** What the processes and workers this file started listed, read off its log and emptied; the
   * lines naming a process that started are the guard's, not a listing. */
  const childLines = () => {
    const lines = readFileSync(state.log, 'utf8').trim().split('\n').filter(Boolean);
    writeFileSync(state.log, '');
    return lines.map((l) => JSON.parse(l)).filter((l) => !l.started);
  };
  /** The refusal a git call in the root's own repository with no pathspec is read as, compared as
   * text: a spawner's name is never read as a pattern. */
  const readsWholeTree = (spawner, sub = 'ls-files') =>
    startingWith(`${spawner} running \`git ${sub}\` in the root's own repository with no pathspec`);

  it('reads a spawner name as text, whatever characters it holds', () => {
    const said = (name) =>
      `${name} running \`git ls-files\` in the root's own repository with no pathspec, so`;
    const name = String.raw`a\.b()`;
    expect(said(name)).toEqual(readsWholeTree(name));
    // What each name would match were it read as a pattern: `\.` a bare dot, and `.` any character.
    expect(said('a.b()')).not.toEqual(readsWholeTree(name));
    expect(said('axb()')).not.toEqual(readsWholeTree('a.b()'));
  });
  // Every case here lists the root on purpose, so each clears what it recorded before `afterAll`
  // would refuse this undeclared file for it.
  afterEach(() => {
    state.hits = [];
    childLines();
  });

  it('is installed by the configuration that collects this file, capturing a base', () => {
    expect(state?.installed).toBe(true);
    expect(globalThis[Symbol.for('forge.whole-tree-watch')].base).toBeTruthy();
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
    execFileSync('git', ['ls-files'], { cwd: REPO });
    expect(vias()).toEqual(['readdir()', readsWholeTree('execFileSync()')]);
  });

  it('sees git list the root from a cwd handed as a file URL', () => {
    const cwd = pathToFileURL(`${REPO}/`);
    execFileSync('git', ['ls-files'], { cwd });
    expect(vias()).toEqual([readsWholeTree('execFileSync()')]);
  });

  it('counts a spawn whose cwd it cannot place as the root, and Node refuses to run it', () => {
    const cwd = new URL('http://localhost:3000/@fs/');
    expect(() => execFileSync('git', ['ls-files'], { cwd })).toThrow(/scheme file/);
    expect(covering()).toEqual([
      expect.objectContaining({
        dir: REPO,
        via: expect.stringMatching(/^execFileSync\(\) with an argument the guard cannot place/),
      }),
    ]);
  });

  it('keeps promisify(execFile) resolving to stdout and stderr, and watches it too', async () => {
    const out = await promisify(execFile)('git', ['ls-files'], { cwd: REPO });
    expect(out.stdout).toContain('package.json');
    expect(out.stderr).toBe('');
    expect(vias()).toEqual([readsWholeTree('execFile()')]);
  });

  it('refuses a program that is not git, grep or node, whatever it is handed (j10 diff)', () => {
    try {
      execFileSync('diff', ['-q', REPO, tmpdir()], { stdio: 'ignore' });
    } catch {
      // diff exits non-zero when the trees differ; the guard has already recorded the refusal.
    }
    expect(vias()).toEqual([
      expect.stringMatching(/^execFileSync\(\) running `diff` is not git, grep or node/),
    ]);
  });

  it('refuses any shell string, and every shell but Node’s /bin/sh (j10 login shell, cd, subst)', () => {
    for (const line of [
      'exec -l bash -c "git ls-files"',
      'cd ../.. && git ls-files',
      'git ls-files $(pwd)',
      'cat ../../*.md',
    ]) {
      try {
        execSync(line, { cwd: import.meta.dirname, stdio: 'ignore', shell: '/bin/sh' });
      } catch {
        // The subprocess may fail; the guard recorded the root listing before it ran.
      }
    }
    try {
      execFileSync('bash', ['-c', 'git ls-files'], { cwd: REPO, stdio: 'ignore' });
    } catch {}
    expect(covering().length).toBe(5);
    expect(covering().every((h) => h.dir === REPO)).toBe(true);
  });

  it('refuses a spawn that sets argv0, and one that adds a startup variable (j10 argv0, LD_PRELOAD)', () => {
    try {
      execFileSync('git', ['ls-files'], { cwd: REPO, argv0: '-git', stdio: 'ignore' });
    } catch {}
    try {
      execFileSync('git', ['ls-files'], {
        cwd: REPO,
        env: { ...process.env, LD_PRELOAD: '/x.so' },
        stdio: 'ignore',
      });
    } catch {}
    expect(covering().length).toBe(2);
    expect(covering().every((h) => h.dir === REPO)).toBe(true);
  });

  it('refuses a program a test put first on PATH under node_modules (j10 class 4)', () => {
    const bin = mkdtempSync(join(tmpdir(), 'wt-bin-'));
    mkdirSync(join(bin, 'node_modules', '.bin'), { recursive: true });
    const fake = join(bin, 'node_modules', '.bin', 'git');
    writeFileSync(fake, '#!/bin/sh\nexec /usr/bin/git "$@"\n');
    execFileSync('chmod', ['+x', fake]);
    try {
      execFileSync('git', ['ls-files'], {
        cwd: REPO,
        env: { ...process.env, PATH: `${join(bin, 'node_modules', '.bin')}:${process.env.PATH}` },
        stdio: 'ignore',
      });
    } catch {
      // The fake exists, so PATH changed — the reader refuses before it runs.
    }
    rmSync(bin, { recursive: true, force: true });
    expect(covering().length).toBeGreaterThanOrEqual(1);
    expect(covering().every((h) => h.dir === REPO)).toBe(true);
  });

  it('refuses a Node child given a startup module the worker was not started with, via CLI and NODE_OPTIONS', () => {
    const probe = join(mkdtempSync(join(tmpdir(), 'wt-req-')), 'r.cjs');
    writeFileSync(probe, `require('node:fs').readdirSync(${JSON.stringify(REPO)});`);
    execFileSync(process.execPath, ['--require', probe, '-e', '0'], { stdio: 'ignore' });
    execFileSync(process.execPath, ['-e', '0'], {
      env: { ...process.env, NODE_OPTIONS: `--require ${probe}` },
      stdio: 'ignore',
    });
    rmSync(dirname(probe), { recursive: true, force: true });
    expect(covering().length).toBe(2);
    expect(covering().every((h) => h.dir === REPO)).toBe(true);
  });

  it('refuses a worker thread handed its own startup module', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-worker-'));
    const mod = join(dir, 'pre.mjs');
    writeFileSync(mod, '');
    const w = new Worker('', { eval: true, execArgv: ['--import', pathToFileURL(mod).href] });
    w.terminate();
    rmSync(dir, { recursive: true, force: true });
    expect(vias()).toEqual([expect.stringMatching(/^Worker\(\) with the startup module `file:/)]);
  });

  it('refuses a worker inheriting a startup module the vitest worker was not started with', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-inherit-'));
    const mod = join(dir, 'pre.cjs');
    writeFileSync(mod, '');
    const saved = [...process.execArgv];
    process.execArgv.push('--require', mod);
    try {
      new Worker('0', { eval: true }).terminate();
      new Worker('0', { eval: true, execArgv: saved }).terminate();
    } finally {
      process.execArgv.splice(0, process.execArgv.length, ...saved);
      rmSync(dir, { recursive: true, force: true });
    }
    expect(vias()).toEqual([
      expect.stringMatching(/^Worker\(\) with the startup module `\/.*pre\.cjs`/),
    ]);
  });

  it('sees a Node child list it, a call handing its own env included', () => {
    const script = `require('node:fs').readdirSync(${JSON.stringify(REPO)})`;
    execFileSync(process.execPath, ['-e', script], {
      env: { PATH: process.env.PATH },
      stdio: 'ignore',
    });
    const logged = childLines();
    expect(logged).toEqual([
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
    const logged = childLines();
    expect(logged.map((l) => l.via)).toEqual([
      expect.stringMatching(/^readdirSync\(\) in worker \d+ of process \d+$/),
    ]);
  });

  it('sees a worker thread file list it, with the preload ahead of the test’s own execArgv', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whole-tree-worker-'));
    const file = join(dir, 'lists.mjs');
    writeFileSync(
      file,
      `import { readdirSync } from 'node:fs'; readdirSync(${JSON.stringify(REPO)});`,
    );
    await new Promise((done, fail) => new Worker(file).on('exit', done).on('error', fail));
    rmSync(dir, { recursive: true, force: true });
    const logged = childLines();
    expect(logged.map((l) => l.dir)).toEqual([REPO]);
  });

  /** A worker on `code`, a file unless `options.eval`, run to its exit or its error. */
  const runWorker = (code, options) =>
    new Promise((done, fail) => new Worker(code, options).on('exit', done).on('error', fail));
  const listsRoot = `require('node:fs').readdirSync(${JSON.stringify(REPO)});`;
  const inWorker = expect.stringMatching(/^readdirSync\(\) in worker \d+ of process \d+$/);

  it('watches a worker handed its own env, empty or not, file or eval (j13)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whole-tree-worker-env-'));
    const file = join(dir, 'lists.cjs');
    writeFileSync(file, listsRoot);
    try {
      await runWorker(file, { env: {} });
      await runWorker(file, { env: { NODE_ENV: 'test' } });
      await runWorker(listsRoot, { eval: true, env: { NODE_ENV: 'test' } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(childLines().map((l) => l.via)).toEqual([inWorker, inWorker, inWorker]);
  });

  it('watches a worker started after the test deleted the log from its env, shared or copied (j13)', async () => {
    const saved = process.env[LOG_ENV];
    delete process.env[LOG_ENV];
    try {
      await runWorker(listsRoot, { eval: true });
      delete process.env[LOG_ENV];
      await runWorker(listsRoot, { eval: true, env: SHARE_ENV });
    } finally {
      process.env[LOG_ENV] = saved;
    }
    expect(childLines().map((l) => l.via)).toEqual([inWorker, inWorker]);
  });

  /** A worker file that starts `inner` as a worker and posts back what it posts. */
  const nesting = (inner, options = '{}') =>
    `import { Worker, parentPort } from 'node:worker_threads'; const w = new Worker(${JSON.stringify(inner)}, ${options}); w.once('message', (m) => parentPort.postMessage(m)); w.once('error', (e) => { throw e; });`;
  /** `src` written to a file of its own; the caller removes `dir`. */
  const written = (dir, name, src) => {
    const file = join(dir, name);
    writeFileSync(file, src);
    return file;
  };
  const answer = (file, options) =>
    new Promise((done, fail) => {
      const w = new Worker(file, options);
      w.once('message', done);
      w.once('error', fail);
    });

  it('lets a worker started inside a watched worker run with the preload once, counting nothing it did not list (j14 c3, c4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whole-tree-nested-'));
    try {
      const argv = written(
        dir,
        'argv.mjs',
        "import { parentPort } from 'node:worker_threads'; parentPort.postMessage(process.execArgv);",
      );
      const pkg = written(
        dir,
        'pkg.mjs',
        `import { readdirSync } from 'node:fs'; import { parentPort } from 'node:worker_threads'; parentPort.postMessage(readdirSync(${JSON.stringify(join(REPO, 'scripts'))}));`,
      );
      const execArgv = await answer(written(dir, 'outer-argv.mjs', nesting(argv)));
      expect(execArgv.filter((a) => a.includes('whole-tree-child.mjs'))).toHaveLength(1);
      expect(await answer(written(dir, 'outer-pkg.mjs', nesting(pkg)))).toContain('lib');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(vias()).toEqual([]);
    expect(childLines()).toEqual([]);
  });

  it('still sees a worker started inside a watched worker list the root, with its env or none (j14 n1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whole-tree-nested-'));
    const root = `import { readdirSync } from 'node:fs'; import { parentPort } from 'node:worker_threads'; parentPort.postMessage(readdirSync(${JSON.stringify(REPO)}));`;
    try {
      const inner = written(dir, 'root.mjs', root);
      await answer(written(dir, 'outer.mjs', nesting(inner)));
      await answer(written(dir, 'outer-env.mjs', nesting(inner, '{ env: {} }')), { env: {} });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(vias()).toEqual([]);
    expect(childLines().map((l) => l.via)).toEqual([inWorker, inWorker]);
  });

  it('reads a program a worker with its own env spawns (j13 s5)', async () => {
    const code = `require('node:child_process').execFileSync('ls', [${JSON.stringify(REPO)}], { stdio: 'ignore' });`;
    await runWorker(code, { eval: true, env: { PATH: process.env.PATH } });
    expect(childLines().map((l) => l.via)).toEqual([
      expect.stringMatching(
        /^execFileSync\(\) running `ls` is not git, grep or node.* in worker \d+ of process \d+$/,
      ),
    ]);
  });

  it('names a listing the watch counted as the root once, with no listing added after it (j13)', () => {
    execFileSync('ls', [REPO], { stdio: 'ignore' });
    process.binding('fs');
    const why = guardVerdict({ file: 'x.test.ts', source: '', hits: covering(), root: REPO });
    expect(covering()).toHaveLength(2);
    expect(why).not.toMatch(/counted as[^;]*listed the repository root/);
    expect(why).toMatch(/so counted as listing the repository root \(called at /);
  });

  it('refuses to run a Node child or a worker the preload reaches with no log, rather than run it unwatched', async () => {
    const watch = globalThis[Symbol.for('forge.whole-tree-watch')];
    const saved = { log: watch.log, env: process.env[LOG_ENV] };
    const dir = mkdtempSync(join(tmpdir(), 'whole-tree-nolog-'));
    const ran = join(dir, 'ran');
    const marks = `require('node:fs').writeFileSync(${JSON.stringify(ran)}, '');`;
    let child;
    let failed;
    watch.log = '';
    try {
      child = spawnSync(process.execPath, ['-e', marks], { encoding: 'utf8' });
      failed = await runWorker(marks, { eval: true }).then(
        () => null,
        (e) => e,
      );
    } finally {
      watch.log = saved.log;
      process.env[LOG_ENV] = saved.env;
    }
    const ranAtAll = existsSync(ran);
    rmSync(dir, { recursive: true, force: true });
    expect(ranAtAll).toBe(false);
    expect(child.status).not.toBe(0);
    expect(child.stderr).toMatch(
      /whole-tree guard: child process \d+ loaded the preload with no FORGE_WHOLE_TREE_LOG/,
    );
    expect(String(failed?.message)).toMatch(
      /whole-tree guard: worker \d+ of process \d+ loaded the preload with no FORGE_WHOLE_TREE_LOG/,
    );
    state.hits = [];
  });

  it('counts a program it cannot see into as the root, wherever it runs (a non-Node shell script)', () => {
    try {
      execFileSync('sh', [join(import.meta.dirname, 'no-such-script.sh')], { stdio: 'ignore' });
    } catch {
      // The script does not exist; the guard counted `sh` as the root before it ran.
    }
    expect(covering()).toEqual([
      expect.objectContaining({
        dir: REPO,
        via: expect.stringMatching(/^execFileSync\(\) running `sh` is not git, grep or node/),
      }),
    ]);
  });

  it('counts an executable a dependency spawns from its own callback, but exempts esbuild’s service', async () => {
    const dep = mkdtempSync(join(tmpdir(), 'whole-tree-dep-'));
    const lib = join(dep, 'node_modules', 'lister');
    mkdirSync(join(lib, 'bin'), { recursive: true });
    writeFileSync(
      join(lib, 'index.mjs'),
      "import { spawnSync } from 'node:child_process';\n" +
        "export const later = (bin, args=[]) => new Promise((done) => setTimeout(() => { spawnSync(bin, args, { stdio: 'ignore' }); done(); }, 0));",
    );
    const { later } = await import(pathToFileURL(join(lib, 'index.mjs')).href);
    await later(join(lib, 'bin', 'walk'));
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
    child.spawn({
      file: 'git',
      args: ['git', 'ls-files'],
      cwd: REPO,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    await new Promise((done) => child.on('exit', done));
    const direct = spawn('git', ['ls-files'], { cwd: REPO, stdio: 'ignore' });
    await new Promise((done) => direct.on('exit', done));
    expect(vias()).toEqual([readsWholeTree('ChildProcess#spawn()'), readsWholeTree('spawn()')]);
  });

  it('reads a ChildProcess whose args[0] is an argv0 as outside the grammar', async () => {
    const child = new ChildProcess();
    child.spawn({
      file: 'git',
      args: ['-git', 'ls-files'],
      cwd: REPO,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    await new Promise((done) => child.on('exit', done));
    expect(covering().length).toBe(1);
    expect(covering()[0].dir).toBe(REPO);
  });

  it('reads exec once, not again as the execFile it runs', async () => {
    await promisify(exec)('git ls-files', { cwd: REPO });
    expect(vias()).toEqual([readsWholeTree('exec()')]);
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
    execFileSync('git', ['ls-files'], { cwd: join(dir, 'repo'), stdio: 'ignore' });
    execFileSync('git', ['ls-files'], { cwd: `/proc/${process.pid}/cwd/${up}`, stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
    expect(covering().map((h) => h.dir)).toEqual([REPO, REPO]);
  });

  it('re-arms a Node child a test scrubbed NODE_OPTIONS and the log for, and sees it list (j12 p04)', () => {
    const saved = { options: process.env[OPTIONS], log: process.env[LOG_ENV] };
    delete process.env[OPTIONS];
    delete process.env[LOG_ENV];
    try {
      const code = `require('node:fs').readdirSync(${JSON.stringify(REPO)})`;
      execFileSync(process.execPath, ['-e', code], { stdio: 'ignore' });
      spawnSync(process.execPath, ['-e', code], { env: { PATH: process.env.PATH } });
    } finally {
      process.env[OPTIONS] = saved.options;
      process.env[LOG_ENV] = saved.log;
    }
    expect(childLines().map((l) => l.dir)).toEqual([REPO, REPO]);
  });

  it('reads a spawn made inside a listing call’s callback (j12 p08)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-cp-'));
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a', 'f'), 'x');
    cpSync(join(dir, 'a'), join(dir, 'b'), {
      recursive: true,
      filter: () => {
        execFileSync('ls', [REPO], { stdio: 'ignore' });
        return true;
      },
    });
    rmSync(dir, { recursive: true, force: true });
    expect(vias().length).toBeGreaterThanOrEqual(1);
    expect(
      vias().every((v) => /^execFileSync\(\) running `ls` is not git, grep or node/.test(v)),
    ).toBe(true);
  });

  it('counts a raw fs or spawn binding, and a Node child replacing itself by execve, as the root', () => {
    process.binding('fs');
    process.binding('spawn_sync');
    expect(vias()).toEqual([
      expect.stringMatching(/^process\.binding\('fs'\) reaches node:fs round the watch/),
      expect.stringMatching(/^process\.binding\('spawn_sync'\) reaches a synchronous spawn/),
    ]);
    execFileSync(process.execPath, ['-e', "process.execve('/bin/true', ['true'])"]);
    expect(childLines().map((l) => l.via)).toEqual([
      expect.stringMatching(/^process\.execve\(\) replaces this process with `\/bin\/true`/),
    ]);
  });

  it('reads a spawn the spawn_sync binding makes for a spawner the watch did not wrap', () => {
    const pipe = (readable, writable) => ({ type: 'pipe', readable, writable });
    process.binding('spawn_sync').spawn({
      file: 'git',
      args: ['git', 'ls-files'],
      cwd: REPO,
      envPairs: [`PATH=${process.env.PATH}`],
      stdio: [pipe(true, false), pipe(false, true), pipe(false, true)],
    });
    expect(vias()).toEqual([
      expect.stringMatching(/^process\.binding\('spawn_sync'\)/),
      readsWholeTree('spawn_sync binding'),
    ]);
  });

  it('sees a data: URL worker and a module eval worker list it, a static import included', async () => {
    const lists = `import fs from "node:fs"; fs.readdirSync(${JSON.stringify(REPO)});`;
    const url = new URL(`data:text/javascript,${encodeURIComponent(lists)}`);
    await new Promise((done, fail) => new Worker(url).on('exit', done).on('error', fail));
    const esm = `import 'data:text/javascript,${encodeURIComponent(lists)}'; export {};`;
    await new Promise((done, fail) =>
      new Worker(esm, { eval: true }).on('exit', done).on('error', fail),
    );
    expect(childLines().map((l) => l.via)).toEqual([
      expect.stringMatching(/^readdirSync\(\) in worker \d+ of process \d+$/),
      expect.stringMatching(/^readdirSync\(\) in worker \d+ of process \d+$/),
    ]);
  });

  it('puts every Node child it starts on the log before the spawn returns', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], { stdio: 'ignore' });
    const started = readFileSync(state.log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(started).toContainEqual({ started: child.pid });
    await new Promise((done) => child.on('exit', done));
  });

  it('counts a child it could not put on the log as the root', async () => {
    const saved = state.log;
    const unwritable = join(mkdtempSync(join(tmpdir(), 'wt-nolog-')), 'missing', 'log.jsonl');
    const watch = globalThis[Symbol.for('forge.whole-tree-watch')];
    watch.log = unwritable;
    try {
      const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
      await new Promise((done) => child.on('exit', done));
    } finally {
      watch.log = saved;
    }
    expect(vias()).toEqual([
      expect.stringMatching(/^child process \d+ could not be put on the log \(ENOENT\)/),
    ]);
  });

  it('records nothing covering the root for a listing inside it', () => {
    readdirSync(import.meta.dirname);
    execFileSync('git', ['ls-files', 'whole-tree-gates.mjs'], {
      cwd: import.meta.dirname,
      stdio: 'ignore',
    });
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

  it('fails one that leaves a Node child running past its end, whose listing nobody would read (j12 p09)', () => {
    writeFileSync(
      join(dir, 'lingers.test.mjs'),
      [
        "import { spawn } from 'node:child_process';",
        "it('leaves a child', () => { spawn(process.execPath, ['-e', 'setTimeout(() => {}, 9000)'], { detached: true, stdio: 'ignore' }).unref(); });",
      ].join('\n'),
    );
    const r = vitest('lingers.test.mjs');
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(
      /lingers\.test\.mjs child process \d+ was still running when the file ended[^\n]*add a line `\/\/ @gate-input whole-tree`/,
    );
  }, 60_000);

  it('fails one whose child starts a lingering grandchild while the file’s end waits, then exits', () => {
    const grandchild =
      "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 9000)'], { detached: true, stdio: 'ignore' }).unref()";
    writeFileSync(
      join(dir, 'hands-off.test.mjs'),
      [
        "import { spawn } from 'node:child_process';",
        `const code = ${JSON.stringify(`setTimeout(() => { ${grandchild}; }, 300)`)};`,
        "it('hands off', () => { spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' }).unref(); });",
      ].join('\n'),
    );
    const r = vitest('hands-off.test.mjs');
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(
      /hands-off\.test\.mjs child process \d+ was still running when the file ended/,
    );
  }, 60_000);

  it('counts a worker against the file that started it, not a later one in the same worker process', () => {
    const shared = mkdtempSync(join(tmpdir(), 'whole-tree-shared-'));
    const guard = JSON.stringify(join(REPO, 'scripts/lib/whole-tree-guard.mjs'));
    writeFileSync(
      join(shared, 'vitest.config.mjs'),
      `export default { test: { globals: true, isolate: false, maxWorkers: 1, include: ['*.test.mjs'], setupFiles: [${guard}] } };`,
    );
    writeFileSync(
      join(shared, 'a.test.mjs'),
      [
        "import { Worker } from 'node:worker_threads';",
        "it('leaves a worker', () => { new Worker('setTimeout(() => {}, 20000)', { eval: true }).unref(); });",
      ].join('\n'),
    );
    writeFileSync(join(shared, 'b.test.mjs'), "it('starts nothing', () => {});");
    const r = spawnSync(
      process.execPath,
      [join(REPO, 'node_modules/vitest/vitest.mjs'), 'run', '--root', shared],
      { cwd: shared, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } },
    );
    writeFileSync(globalThis[Symbol.for('forge.whole-tree-guard')].log, '');
    rmSync(shared, { recursive: true, force: true });
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toMatch(/a\.test\.mjs 1 worker thread\(s\) were still running when the file ended/);
    expect(out).not.toMatch(/b\.test\.mjs[^\n]*were still running/);
    expect(r.status).toBe(1);
  }, 60_000);

  it('fails one whose own source is gone by its end, rather than dropping what it listed (j13)', () => {
    writeFileSync(
      join(dir, 'vanishes.test.mjs'),
      [
        "import { readdirSync, rmSync } from 'node:fs';",
        "import { fileURLToPath } from 'node:url';",
        "it('lists and leaves', () => { readdirSync(process.env.WT_ROOT); rmSync(fileURLToPath(import.meta.url)); });",
      ].join('\n'),
    );
    const r = vitest('vanishes.test.mjs');
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(
      /whole-tree-gates: [^\n]*vanishes\.test\.mjs: its source could not be read \(ENOENT\)/,
    );
  }, 60_000);

  it('fails one vitest names no test path for, rather than dropping what it listed (j13)', () => {
    writeFileSync(
      join(dir, 'unnamed.test.mjs'),
      [
        "import { readdirSync } from 'node:fs';",
        "it('lists and unnames', () => { readdirSync(process.env.WT_ROOT); expect.setState({ testPath: undefined }); });",
      ].join('\n'),
    );
    const r = vitest('unnamed.test.mjs');
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(
      /whole-tree-gates: a test file: vitest named no test file at its end/,
    );
  }, 60_000);

  it('fails one whose child log was removed, since what its processes listed is then unknown', () => {
    writeFileSync(
      join(dir, 'unlogged.test.mjs'),
      [
        "import { rmSync } from 'node:fs';",
        "it('removes the log', () => { rmSync(process.env.FORGE_WHOLE_TREE_LOG); });",
      ].join('\n'),
    );
    const r = vitest('unlogged.test.mjs');
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(
      /unlogged\.test\.mjs this file's child log could not be read \(ENOENT\)/,
    );
  }, 60_000);

  it('fails one whose child log ends in a line nothing finished writing', () => {
    writeFileSync(
      join(dir, 'torn.test.mjs'),
      [
        "import { appendFileSync } from 'node:fs';",
        "it('tears the log', () => { appendFileSync(process.env.FORGE_WHOLE_TREE_LOG, '{\"dir\":'); });",
      ].join('\n'),
    );
    const r = vitest('torn.test.mjs');
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(
      /torn\.test\.mjs the child log ends in a line no process finished writing/,
    );
  }, 60_000);

  it('fails one whose child log holds a line that is not a record', () => {
    writeFileSync(
      join(dir, 'garbles.test.mjs'),
      [
        "import { appendFileSync } from 'node:fs';",
        "it('garbles the log', () => { appendFileSync(process.env.FORGE_WHOLE_TREE_LOG, 'not a record\\n'); });",
      ].join('\n'),
    );
    const r = vitest('garbles.test.mjs');
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(
      /garbles\.test\.mjs the child log holds a line that is not a record/,
    );
  }, 60_000);

  it('fails one whose child log is rewritten after the guard first read it', () => {
    writeFileSync(
      join(dir, 'rewrites.test.mjs'),
      [
        "import { spawn } from 'node:child_process';",
        "import { readFileSync, writeFileSync } from 'node:fs';",
        'const log = process.env.FORGE_WHOLE_TREE_LOG;',
        "it('rewrites the log while the end waits', () => {",
        "  spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600)'], { stdio: 'ignore' });",
        "  setTimeout(() => writeFileSync(log, readFileSync(log, 'utf8').replace(/[0-9]/g, '1')), 300);",
        '});',
      ].join('\n'),
    );
    const r = vitest('rewrites.test.mjs');
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(
      /rewrites\.test\.mjs this file's child log was rewritten/,
    );
  }, 60_000);

  it('fails one whose child log loses a line the guard saw but had not yet read to its end', () => {
    writeFileSync(
      join(dir, 'unwrites.test.mjs'),
      [
        "import { appendFileSync, writeFileSync } from 'node:fs';",
        "import { Worker } from 'node:worker_threads';",
        'const log = process.env.FORGE_WHOLE_TREE_LOG;',
        "it('unwrites a pending line while the end waits', () => {",
        "  new Worker('setTimeout(() => {}, 600)', { eval: true });",
        '  appendFileSync(log, \'{"dir":\');',
        "  setTimeout(() => writeFileSync(log, ''), 300);",
        '});',
      ].join('\n'),
    );
    const r = vitest('unwrites.test.mjs');
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(
      /unwrites\.test\.mjs this file's child log was rewritten/,
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

  it('passes one whose resolved test.setupFiles holds the guard first', () => {
    const configs = [
      { path: 'packages/core/vitest.config.ts', root: CORE, setupFiles: [guard, `${CORE}/s.ts`] },
    ];
    expect(judgeConfigs(configs, ROOT)).toEqual([]);
  });

  it('refuses one that runs another setup file before the guard, naming both', () => {
    const configs = [
      { path: 'packages/core/vitest.config.ts', root: CORE, setupFiles: [`${CORE}/s.ts`, guard] },
    ];
    expect(judgeConfigs(configs, ROOT)).toEqual([
      {
        path: 'packages/core/vitest.config.ts',
        why: "runs 's.ts' before the guard, so a listing function it takes is never watched — put '../../scripts/lib/whole-tree-guard.mjs' first in its `test.setupFiles`",
      },
    ]);
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
