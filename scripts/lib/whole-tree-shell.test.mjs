import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { globBase, subprocessListing } from './whole-tree-shell.mjs';

// A scratch tree standing in for the repository, so a pathspec naming a directory names one that
// exists, and nothing here lists the real root.
const ROOT = mkdtempSync(join(tmpdir(), 'whole-tree-shell-'));
const CORE = join(ROOT, 'packages', 'core');
mkdirSync(join(CORE, 'src'), { recursive: true });
mkdirSync(join(ROOT, 'docs'), { recursive: true });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const ENV = { HOME: '/home/someone', PATH: '/usr/bin' };
const entries = (command, args = [], opts = {}) =>
  subprocessListing({ command, args, cwd: CORE, root: ROOT, env: ENV, ...opts });
const dirs = (...a) => entries(...a).map((e) => e.dir);
const sh = (text, opts = {}) => dirs(text, [], { shell: true, ...opts });

describe('where a glob pattern starts listing', () => {
  it('is its segments before the first magic one', () => {
    expect(globBase('../../docs/**/*.md')).toBe('../../docs');
    expect(globBase('**/*.md')).toBe('.');
    expect(globBase('/abs/*')).toBe('/abs');
    expect(globBase('/*')).toBe('/');
  });
});

describe('git, read by its subcommand and every pathspec', () => {
  it('lists from where it runs, narrowed by a pathspec relative, absolute or top-level', () => {
    expect(dirs('git', ['ls-files'])).toEqual([CORE]);
    expect(dirs('git', ['ls-files', '../..'])).toEqual([ROOT]);
    expect(dirs('git', ['ls-files', ROOT])).toEqual([ROOT]);
    expect(dirs('git', ['ls-files', 'src'])).toEqual([join(CORE, 'src')]);
    expect(dirs('git', ['ls-files', ':/'])).toEqual([ROOT]);
    expect(dirs('git', ['ls-files', ':(top)docs'])).toEqual([join(ROOT, 'docs')]);
    expect(dirs('git', ['ls-files', '*.md'])).toEqual([CORE]);
    expect(dirs('git', ['ls-files', 'src', ':!src/x'])).toEqual([join(CORE, 'src')]);
  });

  it('takes grep’s pattern and ls-tree’s tree-ish out of the pathspecs, and a revision too', () => {
    expect(dirs('git', ['grep', '-l', 'pnpm', '--', '../..'])).toEqual([ROOT]);
    expect(dirs('git', ['grep', 'src'])).toEqual([CORE]);
    expect(dirs('git', ['grep', '-e', 'x', 'src'])).toEqual([join(CORE, 'src')]);
    expect(dirs('git', ['-C', ROOT, 'grep', 'x', 'HEAD'])).toEqual([ROOT]);
    expect(dirs('git', ['ls-tree', '-r', 'HEAD', 'src'])).toEqual([join(CORE, 'src')]);
    expect(dirs('git', ['ls-tree', '-r', '--full-tree', 'HEAD'])).toEqual([ROOT]);
  });

  it('reads status, diff and their like as the whole work tree unless handed pathspecs', () => {
    expect(dirs('git', ['status', '--porcelain'])).toEqual([ROOT]);
    expect(dirs('git', ['diff', 'HEAD'])).toEqual([ROOT]);
    expect(dirs('git', ['diff', '--', 'src'])).toEqual([join(CORE, 'src')]);
    expect(dirs('git', ['status'], { cwd: '/elsewhere/repo' })).toEqual(['/elsewhere/repo']);
  });

  it('follows -C, --work-tree and GIT_WORK_TREE to where it really runs', () => {
    expect(dirs('git', ['-C', '../..', 'ls-files'])).toEqual([ROOT]);
    expect(dirs('git', ['--work-tree=/elsewhere', 'status'])).toEqual(['/elsewhere']);
    const env = { ...ENV, GIT_WORK_TREE: ROOT };
    expect(dirs('git', ['status'], { cwd: '/elsewhere', env })).toEqual([ROOT]);
  });

  it('lists nothing for a subcommand that never enumerates the tree', () => {
    expect(dirs('git', ['rev-parse', '--show-toplevel'])).toEqual([]);
    expect(dirs('git', ['log', '-1'])).toEqual([]);
    expect(dirs('git', ['-c', 'user.email=a@b.invalid', 'commit', '-m', 'x'])).toEqual([]);
    expect(dirs('git', ['add', 'f.txt'], { cwd: '/elsewhere' })).toEqual(['/elsewhere/f.txt']);
    expect(dirs('git', ['add'])).toEqual([]);
  });

  it('counts a subcommand, a setting or a pathspec file it cannot read as the root', () => {
    expect(entries('git', ['submodule', 'foreach', 'ls'])).toEqual([
      expect.objectContaining({
        dir: ROOT,
        unseen: true,
        via: expect.stringContaining('git submodule'),
      }),
    ]);
    expect(
      dirs('git', ['-c', 'core.fsmonitor=./walk.sh', 'status'], { cwd: '/elsewhere' }),
    ).toEqual([ROOT]);
    expect(dirs('git', ['-c', 'alias.x=!ls ../..', 'x'], { cwd: '/elsewhere' })).toEqual([ROOT]);
    expect(dirs('git', ['ls-files', '--pathspec-from-file=list'], { cwd: '/elsewhere' })).toEqual([
      ROOT,
    ]);
  });
});

describe('a shell string, run command by command', () => {
  it('counts a directory moved to by a substitution as the root, quoted or not', () => {
    expect(sh('cd "$(git rev-parse --show-toplevel)" && git ls-files')).toEqual([ROOT]);
    expect(sh('git -C "$(git rev-parse --show-toplevel)" ls-files')).toEqual([ROOT]);
    expect(sh('cd $(git rev-parse --show-toplevel) && git ls-files | head -1')).toEqual([ROOT]);
    expect(sh('cd `git rev-parse --show-toplevel`; ls')).toEqual([ROOT]);
  });

  it('names the unevaluable directory in the reason, not a path that was never listed', () => {
    const [entry] = entries('cd "$(git rev-parse --show-toplevel)" && ls', [], { shell: true });
    expect(entry.via).toBe(
      'ls (at a directory or word the guard cannot evaluate, so counted as the root)',
    );
  });

  it('reads a literal cd, a variable it was set, the environment, and a quoted word whole', () => {
    expect(sh('cd ../.. && find . -name "*.md"')).toEqual([ROOT]);
    expect(sh('d=../..; ls "$d"')).toEqual([ROOT]);
    expect(sh('ls $ROOTDIR', { env: { ...ENV, ROOTDIR: ROOT } })).toEqual([ROOT]);
    expect(sh('ls $NOBODY_SET_THIS')).toEqual([ROOT]);
    expect(sh('ls ~')).toEqual(['/home/someone']);
    expect(sh("ls 'src dir'")).toEqual([join(CORE, 'src dir')]);
  });

  it('reads the commands a substitution runs, wherever it stands', () => {
    expect(sh('echo "$(ls ../..)"')).toEqual([ROOT]);
    expect(sh('x=`find ../.. -name y`')).toEqual([ROOT]);
    expect(sh('cat <<EOF\n$(ls ../..)\nEOF')).toEqual([ROOT]);
  });

  it('skips a here-document’s body, a comment and a redirection’s target', () => {
    expect(sh("cat <<'EOF'\nls ../..\nEOF\necho done")).toEqual([]);
    expect(sh('echo hi # ls ../..')).toEqual([]);
    expect(sh('git rev-parse HEAD 2>/dev/null >out.txt')).toEqual([]);
    expect(sh('if [ -n "$x" ]; then echo y; fi')).toEqual([]);
  });

  it('reads the positional parameters a -c string is handed, moved by shift', () => {
    const script = 'ulimit -f "$1" && shift && exec git "$@"';
    const fetch = ['-c', 'fetch.unpackLimit=1', '-C', '/elsewhere', 'fetch', 'origin'];
    expect(dirs('sh', ['-c', script, 'sh', '9', ...fetch])).toEqual([]);
    expect(dirs('sh', ['-c', script, 'sh', '9', '-C', '../..', 'ls-files'])).toEqual([ROOT]);
    expect(dirs('bash', ['-ec', 'ls "$1"', 'bash', '../..'])).toEqual([ROOT]);
  });

  it('counts eval, source and a shell handed a script as the root', () => {
    expect(sh('eval "$CMD"')).toEqual([ROOT]);
    expect(sh('. ./env.sh')).toEqual([ROOT]);
    expect(dirs('bash', ['scripts/check.sh'], { cwd: '/elsewhere' })).toEqual([ROOT]);
  });
});

describe('the programs around git', () => {
  it('reads find, ls, rg and a recursive grep, each by what it is handed or where it runs', () => {
    expect(dirs('find', ['../..', '-name', 'x'])).toEqual([ROOT]);
    expect(dirs('find', ['-L', '--', '../..'])).toEqual([ROOT]);
    expect(dirs('find')).toEqual([CORE]);
    expect(dirs('ls', ['-la', '../..'])).toEqual([ROOT]);
    expect(dirs('rg', ['--files', '../..'])).toEqual([ROOT]);
    expect(dirs('rg', ['pattern'])).toEqual([CORE]);
    expect(dirs('rg', ['-g', '*.md', 'pattern', '../..'])).toEqual([ROOT]);
    expect(dirs('grep', ['-rn', 'x', 'src'])).toEqual([join(CORE, 'src')]);
    expect(dirs('grep', ['-rn', '-e', 'src', '../..'])).toEqual([ROOT]);
    expect(dirs('grep', ['-rn', 'x'], { cwd: ROOT })).toEqual([ROOT]);
    expect(dirs('grep', ['-r', '--unknown-flag', 'x', 'src'])).toEqual([
      join(CORE, 'x'),
      join(CORE, 'src'),
      CORE,
    ]);
    expect(dirs('rg', ['-ex', '../..', 'src'])).toEqual([ROOT, join(CORE, 'src')]);
    expect(dirs('rg', ['--', 'needle'], { cwd: ROOT })).toEqual([ROOT]);
    expect(dirs('grep', ['-rnC', '3', 'x', 'src'])).toEqual([join(CORE, 'src')]);
    expect(dirs('grep', ['-rK', 'x', 'src'])).toEqual([join(CORE, 'x'), join(CORE, 'src'), CORE]);
    expect(dirs('rg', ['--pre', 'walk', 'x'], { cwd: '/elsewhere' })).toEqual([ROOT]);
    expect(dirs('grep', ['x', 'file.txt'])).toEqual([]);
    expect(dirs('cp', ['-r', '../..', '/elsewhere'])).toEqual([ROOT, '/elsewhere']);
    expect(dirs('cp', ['a', 'b'])).toEqual([]);
  });

  it('reads what a find -exec runs, and what a launcher runs', () => {
    expect(dirs('find', ['/elsewhere', '-exec', 'ls', '../..', ';'])).toEqual(['/elsewhere', ROOT]);
    expect(dirs('timeout', ['5', 'find', '../..'])).toEqual([ROOT]);
    expect(dirs('env', ['-C', '../..', 'ls'])).toEqual([ROOT]);
    expect(dirs('env', ['FOO=1', 'cat', 'x'])).toEqual([]);
    expect(sh('echo . | xargs ls')).toEqual([ROOT]);
    expect(dirs('pnpm', ['exec', 'rg', '--files', '/elsewhere'], { cwd: '/elsewhere' })).toEqual([
      '/elsewhere',
    ]);
  });

  it('leaves Node, watched from inside, unless it was started without the preload', () => {
    expect(dirs('node', ['x.mjs'])).toEqual([]);
    expect(dirs('pnpm', ['exec', 'vitest', 'run'])).toEqual([]);
    expect(sh('env -i node x.mjs')).toEqual([ROOT]);
    expect(sh('env -i pnpm exec vitest run')).toEqual([ROOT]);
    expect(sh('NODE_OPTIONS= pnpm exec vitest run')).toEqual([ROOT]);
    expect(sh('NODE_OPTIONS= node x.mjs')).toEqual([ROOT]);
    expect(dirs('env', ['-u', 'NODE_OPTIONS', 'node', 'x.mjs'])).toEqual([ROOT]);
  });

  it('counts every program it cannot see into as the root, whatever it is handed', () => {
    const [entry] = entries('python3', ['-c', 'print(1)'], { cwd: '/elsewhere' });
    expect(entry).toEqual({
      dir: ROOT,
      via: '`python3` (a program the guard cannot see into, so counted as listing the root)',
      unseen: true,
      program: 'python3',
    });
    expect(dirs('awk', ['BEGIN{system("ls ../..")}'])).toEqual([ROOT]);
    expect(dirs('sed', ['-n', 'p', 'f.txt'])).toEqual([ROOT]);
    expect(dirs('sort', ['--compress-program=walk', 'f'])).toEqual([ROOT]);
    expect(dirs('pnpm', ['exec', 'biome', 'check'])).toEqual([ROOT]);
  });

  it('leaves a program that reads only the files it is named', () => {
    expect(sh('cat package.json | wc -l')).toEqual([]);
    expect(dirs('pgrep', ['-af', '/elsewhere'])).toEqual([]);
    expect(dirs('sort', ['f.txt'])).toEqual([]);
  });
});
