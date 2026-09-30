import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { globBase, printGrammar, subprocessListing } from './whole-tree-shell.mjs';

// A scratch tree standing in for the repository, so a path naming a directory names one that
// exists, and nothing here lists the real root. Each git subject makes it a real repository.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'whole-tree-shell-')));
const CORE = join(ROOT, 'packages', 'core');
mkdirSync(join(CORE, 'src'), { recursive: true });
mkdirSync(join(ROOT, 'docs'), { recursive: true });
// A symlink inside the tree pointing at another in-tree directory: a git pathspec climbing `..`
// through it cancels it textually (git is lexical), so the `..` sequence escapes to the root a
// `node:fs` call would instead follow the symlink out of. (ISS-1314 j9-k05)
symlinkSync(join(ROOT, 'docs'), join(CORE, 'src', 'down'));
mkdirSync(join(ROOT, '.git'));
execFileSync('git', ['init', '-q'], { cwd: ROOT });
// A fixture repository outside it, trusted (no alternate, hook or off-list config key).
const FIXTURE = realpathSync(mkdtempSync(join(tmpdir(), 'whole-tree-fixture-')));
execFileSync('git', ['init', '-q', FIXTURE]);
// A fixture whose config names a merge driver — a program git would run, so it is not trusted.
const RIGGED = realpathSync(mkdtempSync(join(tmpdir(), 'whole-tree-rigged-')));
execFileSync('git', ['init', '-q', RIGGED]);
writeFileSync(join(RIGGED, '.git', 'config'), '[merge "evil"]\n\tdriver = ./run %O %A %B\n', {
  flag: 'a',
});
afterAll(() => {
  for (const d of [ROOT, FIXTURE, RIGGED]) rmSync(d, { recursive: true, force: true });
});

// The base the reader compares a spawn against: the environment before any test ran. Here it is the
// scratch env, so a spawn that keeps it is admitted and one that moves PATH or a startup key is not.
const BASE_ENV = { HOME: '/home/someone', PATH: '/usr/bin', GIT_CONFIG_NOSYSTEM: '1' };
const base = {
  env: { ...BASE_ENV, __WT_BASE_EXECARGV: '' },
  configs: {},
  execArgv: [],
  hasFrame: true,
};
const run = (command, { args = [], opts = {}, env = BASE_ENV, ...rest } = {}) =>
  subprocessListing({ command, args, cwd: CORE, root: ROOT, env, opts, base, ...rest });
/** Whether a spawn would be refused: it lists a directory that covers the scratch root. */
const listsRoot = (res) => res.some((e) => e.dir === ROOT);
const dirsOf = (res) => res.map((e) => e.dir);

// --- spawn options ---------------------------------------------------------------------------------

describe('spawn options', () => {
  it('admits only a known-safe set; argv0, shell and uid/gid are outside', () => {
    expect(listsRoot(run('git', { args: ['ls-files', 'src'] }))).toBe(false);
    expect(listsRoot(run('git', { args: ['ls-files', 'src'], argv0: '-git' }))).toBe(true);
    expect(listsRoot(run('git', { args: ['ls-files', 'src'], opts: { uid: 0 } }))).toBe(true);
    expect(listsRoot(run('git', { args: ['ls-files', 'src'], opts: { detached: true } }))).toBe(
      false,
    );
  });
});

// --- a shell string --------------------------------------------------------------------------------

describe('a shell string', () => {
  const onDash =
    realpathSync('/bin/sh') === '/usr/bin/dash' || realpathSync('/bin/sh') === '/bin/dash';
  it('reads plain words through /bin/sh where it is dash', () => {
    if (!onDash) return;
    expect(dirsOf(run('git', { args: ['ls-files', 'src'], shell: true }))).toEqual([
      join(CORE, 'src'),
    ]);
  });
  it('refuses a shell option that names a program, and shell: true off dash', () => {
    expect(listsRoot(run('git', { args: ['ls-files'], shell: '/bin/bash' }))).toBe(true);
  });
  it('refuses any metacharacter, quote or non-ASCII in the string', () => {
    if (!onDash) return;
    for (const text of [
      'git ls-files; ls',
      'git ls-files && ls',
      'cat ../../*.md',
      'git ls-files $HOME',
      'echo `pwd`',
      'git ls-files "src"',
      'ls (x)',
      'git ls-files ../..>out',
    ])
      expect(listsRoot(run(text, { shell: true }))).toBe(true);
  });
  it('refuses a first word that is not a program in the grammar (an assignment, exec, a builtin)', () => {
    if (!onDash) return;
    for (const text of ['X=1 git ls-files', 'exec git ls-files', 'command git ls-files', 'cd src'])
      expect(listsRoot(run(text, { shell: true }))).toBe(true);
  });
});

// --- where a program resolves ----------------------------------------------------------------------

describe('where a program resolves', () => {
  it('reads git and grep only from a system directory, and node only as this Node', () => {
    expect(listsRoot(run('git', { args: ['ls-files', 'src'] }))).toBe(false);
    expect(listsRoot(run('/usr/local/bin/git', { args: ['ls-files', 'src'] }))).toBe(false);
    expect(listsRoot(run(join(CORE, 'node_modules/.bin/git'), { args: ['ls-files'] }))).toBe(true);
  });
  it('refuses a program that is not git, grep or node, and one that resolves nowhere', () => {
    for (const p of ['ls', 'find', 'cat', 'diff', 'du', 'python3', 'pnpm', 'npx', 'sh', 'bash'])
      expect(listsRoot(run(p, { args: ['../..'] }))).toBe(true);
    expect(listsRoot(run('no-such-program-anywhere', { args: [] }))).toBe(true);
  });
});

// --- the environment -------------------------------------------------------------------------------

describe('the environment against the base', () => {
  it('refuses a changed PATH or a moved startup key', () => {
    expect(
      listsRoot(
        run('git', {
          args: ['ls-files', 'src'],
          env: { ...BASE_ENV, PATH: `${CORE}/bin:/usr/bin` },
        }),
      ),
    ).toBe(true);
    for (const key of ['LD_PRELOAD', 'BASH_ENV', 'IFS', 'CDPATH', 'BASH_FUNC_git%%'])
      expect(
        listsRoot(run('git', { args: ['ls-files', 'src'], env: { ...BASE_ENV, [key]: 'x' } })),
      ).toBe(true);
  });
  it('lets a program keep its own harmless keys, and git its own GIT_* and editor set to true', () => {
    expect(
      listsRoot(
        run('git', {
          args: ['ls-files', 'src'],
          env: { ...BASE_ENV, GIT_AUTHOR_NAME: 'x', GIT_EDITOR: 'true' },
        }),
      ),
    ).toBe(false);
    expect(
      listsRoot(run('git', { args: ['ls-files', 'src'], env: { ...BASE_ENV, GIT_EDITOR: 'vim' } })),
    ).toBe(true);
    expect(
      listsRoot(
        run('git', { args: ['ls-files', 'src'], env: { ...BASE_ENV, GIT_EXTERNAL_DIFF: 'x' } }),
      ),
    ).toBe(true);
  });
});

// --- git -------------------------------------------------------------------------------------------

describe('git, by its subcommand table', () => {
  const g = (...args) => run('git', { args });
  it('lists the repository top for a tree-reader with no path, and a path operand narrows it', () => {
    expect(dirsOf(g('ls-files'))).toEqual([ROOT]);
    expect(dirsOf(g('ls-files', 'src'))).toEqual([join(CORE, 'src')]);
    expect(dirsOf(g('ls-files', '../..'))).toEqual([ROOT]);
    expect(dirsOf(g('ls-files', ROOT))).toEqual([ROOT]);
    expect(dirsOf(g('-C', ROOT, 'ls-files'))).toEqual([ROOT]);
    expect(dirsOf(g('grep', '-l', 'x', 'src'))).toEqual([join(CORE, 'src')]);
    expect(dirsOf(g('diff', '--name-only'))).toEqual([ROOT]);
    expect(dirsOf(g('add', '-A'))).toEqual([ROOT]);
  });
  it('reads a pathspec: :/ and a climb reach the root, :(top) and a glob place at their base', () => {
    expect(listsRoot(g('ls-files', ':/'))).toBe(true);
    expect(dirsOf(g('ls-files', ':(top)docs'))).toEqual([join(ROOT, 'docs')]);
    expect(listsRoot(g('ls-files', '../..'))).toBe(true);
    expect(dirsOf(g('ls-files', '*.md'))).toEqual([CORE]);
    expect(listsRoot(g('ls-files', 'src/**/../../..'))).toBe(true);
    // A `..` climb through an in-tree symlink is lexical to git, so it reaches the root — the reader
    // must not follow the symlink physically and land in the symlink's target instead.
    expect(listsRoot(g('ls-files', 'src/down/../../../..'))).toBe(true);
  });
  it('reads git show by its object: a named file, and the whole tree for REV: or a bare commit', () => {
    expect(dirsOf(g('show', 'HEAD:CHANGELOG.md'))).toEqual([join(ROOT, 'CHANGELOG.md')]);
    expect(dirsOf(g('show', 'HEAD:'))).toEqual([ROOT]);
    expect(listsRoot(g('show', 'HEAD'))).toBe(true);
  });
  it('lists nothing of the tree for a ref, object or config subcommand', () => {
    for (const args of [
      ['rev-parse', 'HEAD'],
      ['symbolic-ref', '--short', 'HEAD'],
      ['commit', '-m', 'x'],
      ['checkout', '-b', 'iss'],
      ['config', 'user.name', 'x'],
      ['merge-base', 'a', 'b'],
      ['tag', '--list'],
    ])
      expect(listsRoot(g(...args))).toBe(false);
  });
  it('refuses a subcommand, option, count or -c setting off the table', () => {
    for (const args of [
      ['cat-file', '-p', 'HEAD^{tree}'],
      ['diff-tree', '-r', '--name-only', 'HEAD'],
      ['rev-list', '--objects', 'HEAD'],
      ['ls-files', '--modified'],
      ['commit'],
      ['-c', 'core.pager=cat', 'ls-files'],
      ['-c', 'core.fsmonitor=./x', 'status'],
    ])
      expect(listsRoot(g(...args))).toBe(true);
  });
  it('lists a local repository named as a clone source, and nothing for a remote URL fetch', () => {
    expect(
      dirsOf(run('git', { args: ['clone', FIXTURE, join(FIXTURE, '..', 'clone-dest')] })),
    ).toContain(FIXTURE);
    expect(run('git', { args: ['fetch', 'https://github.com/o/r.git'], cwd: FIXTURE })).toEqual([]);
  });
  it('refuses a clone that borrows the objects of a repository it names by option', () => {
    const dest = join(FIXTURE, '..', 'clone-ref-dest');
    for (const ref of [['--reference', ROOT], [`--reference=${ROOT}`]])
      expect(listsRoot(run('git', { args: ['clone', ...ref, FIXTURE, dest] }))).toBe(true);
  });
  it('lists nothing for git in a trusted fixture, and refuses one whose config runs a program', () => {
    expect(run('git', { args: ['ls-files'], cwd: FIXTURE }).length).toBe(1); // its own top, not this root
    expect(listsRoot(run('git', { args: ['ls-files'], cwd: FIXTURE }))).toBe(false);
    expect(listsRoot(run('git', { args: ['ls-files'], cwd: RIGGED }))).toBe(true);
  });
});

// --- grep ------------------------------------------------------------------------------------------

describe('grep', () => {
  it('lists each path operand, and where it runs for -r with none', () => {
    expect(dirsOf(run('grep', { args: ['-rl', 'x', 'src', '--include=*.ts'] }))).toEqual([
      join(CORE, 'src'),
    ]);
    expect(dirsOf(run('grep', { args: ['-r', 'x'] }))).toEqual([CORE]);
    expect(listsRoot(run('grep', { args: ['-rl', 'x', '../..'] }))).toBe(true);
  });
  it('refuses an option off the grammar', () => {
    expect(listsRoot(run('grep', { args: ['--pre=./x', '-r', 'y', 'src'] }))).toBe(true);
  });
});

// --- node ------------------------------------------------------------------------------------------

describe('node', () => {
  const NODE = process.execPath;
  const withArgv = {
    ...base,
    env: { ...BASE_ENV, __WT_BASE_EXECARGV: '--require\nsuppress-warnings.cjs' },
  };
  it('reads options before the script, and lists a script argument that is a directory', () => {
    expect(dirsOf(run(NODE, { args: ['-e', 'x', '../..'] }))).toEqual([ROOT]);
    expect(listsRoot(run(NODE, { args: ['--conditions', 'node', 'src/app.js'] }))).toBe(false);
  });
  it('refuses a startup module the worker was not started with, and admits the base one', () => {
    expect(listsRoot(run(NODE, { args: ['--require', '/tmp/probe.cjs', '-e', '0'] }))).toBe(true);
    expect(
      listsRoot(
        subprocessListing({
          command: NODE,
          args: ['--require', '/x/suppress-warnings.cjs', 'app.js'],
          cwd: CORE,
          root: ROOT,
          env: withArgv.env,
          base: withArgv,
        }),
      ),
    ).toBe(false);
  });
  it('refuses --run and any option off the list', () => {
    expect(listsRoot(run(NODE, { args: ['--run', 'test'] }))).toBe(true);
    expect(listsRoot(run(NODE, { args: ['--experimental-vm-modules', 'app.js'] }))).toBe(true);
  });
});

// --- fork ------------------------------------------------------------------------------------------

describe('fork', () => {
  it('reads this Node with execArgv and module, and refuses a fork of another program', () => {
    expect(
      listsRoot(
        subprocessListing({
          command: process.execPath,
          args: [join(CORE, 'worker.js')],
          cwd: CORE,
          root: ROOT,
          env: BASE_ENV,
          fork: true,
          opts: { execArgv: [] },
          base,
        }),
      ),
    ).toBe(false);
    expect(
      listsRoot(
        subprocessListing({
          command: '/bin/ls',
          args: ['../..'],
          cwd: CORE,
          root: ROOT,
          env: BASE_ENV,
          fork: true,
          opts: { execPath: '/bin/ls' },
          base,
        }),
      ),
    ).toBe(true);
  });
});

// --- reviewed helper -------------------------------------------------------------------------------

describe('the reviewed helper', () => {
  it('exempts esbuild’s service with no repository frame, and nothing else', () => {
    const esbuild = join(CORE, 'node_modules', '@esbuild', 'x', 'bin', 'esbuild');
    mkdirSync(join(CORE, 'node_modules', '@esbuild', 'x', 'bin'), { recursive: true });
    writeFileSync(esbuild, '');
    const noFrame = { ...base, hasFrame: false };
    expect(
      listsRoot(
        subprocessListing({
          command: esbuild,
          args: ['--service=0.28.2', '--ping'],
          cwd: CORE,
          root: ROOT,
          env: BASE_ENV,
          base: noFrame,
        }),
      ),
    ).toBe(false);
    expect(
      listsRoot(
        subprocessListing({
          command: esbuild,
          args: [],
          cwd: CORE,
          root: ROOT,
          env: BASE_ENV,
          base: noFrame,
        }),
      ),
    ).toBe(true);
    expect(
      listsRoot(
        subprocessListing({
          command: esbuild,
          args: ['--service=0.28.2', '--ping'],
          cwd: CORE,
          root: ROOT,
          env: BASE_ENV,
          base,
        }),
      ),
    ).toBe(true);
  });
});

// --- the printed grammar ---------------------------------------------------------------------------

describe('--print-grammar', () => {
  it('prints the grammar from the same tables the reader uses', () => {
    const text = printGrammar();
    expect(text).toContain('ls-files');
    expect(text).toContain('argv0, shell, uid, gid and any other option: outside.');
    expect(text).toContain('Programs: git, grep, node');
    expect(globBase('../../docs/**/*.md')).toBe('../../docs');
  });
});

// The file distinguishes the two constant-verdict mutations: every `listsRoot(...) toBe(true)` fails
// against a reader that admits everything (returns nothing), and every `toBe(false)` / `dirsOf`
// control fails against one that refuses everything (returns the root). Neither mutation is silent.
