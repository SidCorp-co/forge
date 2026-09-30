import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { globBase, subprocessListing } from './whole-tree-shell.mjs';

// A scratch tree standing in for the repository, so a pathspec naming a directory names one that
// exists, and nothing here lists the real root.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'whole-tree-shell-')));
const CORE = join(ROOT, 'packages', 'core');
mkdirSync(join(CORE, 'src'), { recursive: true });
mkdirSync(join(ROOT, 'docs'), { recursive: true });
// A fixture repository outside it, whose remotes a fetch is read by.
const FIXTURE = realpathSync(mkdtempSync(join(tmpdir(), 'whole-tree-fixture-')));
mkdirSync(join(FIXTURE, '.git'));
writeFileSync(
  join(FIXTURE, '.git', 'config'),
  `[core]\n\tbare = false\n[remote "home"]\n\turl = ${ROOT}\n[remote "hub"]\n\turl = https://github.com/o/r.git\n`,
);
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(FIXTURE, { recursive: true, force: true });
});

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
    // Run inside the repository, git still reads its index, so the repository is listed too.
    expect(dirs('git', ['--work-tree=/elsewhere', 'status'])).toEqual(['/elsewhere', ROOT]);
    const env = { ...ENV, GIT_WORK_TREE: ROOT };
    expect(dirs('git', ['status'], { cwd: '/elsewhere', env })).toEqual([ROOT, '/elsewhere']);
  });

  it('lists nothing for a subcommand that never enumerates the tree', () => {
    expect(dirs('git', ['rev-parse', '--show-toplevel'])).toEqual([]);
    expect(dirs('git', ['log', '-1'])).toEqual([]);
    expect(dirs('git', ['merge-file', '-p', 'a', 'o', 'b'])).toEqual([]);
    expect(dirs('git', ['add', 'f.txt'], { cwd: '/elsewhere' })).toEqual(['/elsewhere/f.txt']);
    expect(dirs('git', ['add'])).toEqual([]);
  });

  it('reads log, rev-list and a quiet show as nothing only with options that print no path', () => {
    expect(dirs('git', ['log', '--oneline', '-n', '1'])).toEqual([]);
    expect(dirs('git', ['log', '-z', '--max-count=5', '--format=%H %P%n%B', 'a..b'])).toEqual([]);
    expect(dirs('git', ['show', '-s', '--format=%H'])).toEqual([]);
    expect(dirs('git', ['rev-list', '--count', 'HEAD'])).toEqual([]);
    expect(dirs('git', ['reflog'])).toEqual([]);
    expect(dirs('git', ['log', '-p'])).toEqual([ROOT]);
    expect(dirs('git', ['log', '-S', 'someRetiredKey'])).toEqual([ROOT]);
    expect(dirs('git', ['log', '--stat', '--', 'src'])).toEqual([join(CORE, 'src')]);
    expect(dirs('git', ['reflog', 'show', '-p'])).toEqual([ROOT]);
    expect(dirs('git', ['show'])).toEqual([ROOT]);
    expect(dirs('git', ['show', '-s', '--stat'])).toEqual([ROOT]);
    expect(dirs('git', ['rev-list', '--objects', '-n', '1', 'HEAD'])).toEqual([ROOT]);
    expect(dirs('git', ['rev-list', '--objects-edge-aggressive', 'HEAD'])).toEqual([ROOT]);
    expect(dirs('git', ['log', '-1'])).toEqual([]);
    expect(dirs('git', ['log', '--oneline', '--', '../..'])).toEqual([ROOT]);
    expect(dirs('git', ['log', '--oneline', '../..'])).toEqual([ROOT]);
    expect(dirs('git', ['rev-list', 'HEAD', '--', '../..'])).toEqual([ROOT]);
    expect(dirs('git', ['log', '--oneline', '--', 'src'])).toEqual([join(CORE, 'src')]);
  });

  it('places an object by the tree it names, and a peeled or whole one at the repository', () => {
    expect(dirs('git', ['show', 'HEAD:'])).toEqual([ROOT]);
    expect(dirs('git', ['show', '-s', 'HEAD:'])).toEqual([ROOT]);
    expect(dirs('git', ['show', 'HEAD:docs'])).toEqual([join(ROOT, 'docs')]);
    expect(dirs('git', ['show', 'HEAD:./src'])).toEqual([join(CORE, 'src')]);
    expect(dirs('git', ['cat-file', '-p', 'HEAD^{tree}'])).toEqual([ROOT]);
    expect(dirs('git', ['cat-file', '-p', 'HEAD:docs'])).toEqual([join(ROOT, 'docs')]);
    expect(dirs('git', ['cat-file', 'tree', '4b825dc6'])).toEqual([ROOT]);
    expect(dirs('git', ['cat-file', '--batch'])).toEqual([ROOT]);
    expect(dirs('git', ['cat-file', '-t', 'HEAD'])).toEqual([]);
    expect(dirs('git', ['cat-file', '-e', 'HEAD:docs'])).toEqual([]);
  });

  it('reads the tree readers and the store copiers as the repository', () => {
    const empty = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    expect(dirs('git', ['diff-tree', '-r', '--name-only', empty, 'HEAD'])).toEqual([ROOT]);
    expect(dirs('git', ['diff-tree', '-r', 'HEAD', '--', 'src'])).toEqual([join(CORE, 'src')]);
    expect(dirs('git', ['format-patch', '-1'])).toEqual([ROOT]);
    expect(dirs('git', ['bundle', 'create', '/elsewhere/b', 'HEAD'])).toEqual([ROOT]);
    expect(dirs('git', ['push', '/elsewhere/bare', 'HEAD'])).toEqual([ROOT]);
    expect(dirs('git', ['archive', '--remote=x', 'HEAD'], { cwd: '/elsewhere' })).toEqual([ROOT]);
  });

  it('reads a subcommand that changes the work tree as the work tree', () => {
    expect(dirs('git', ['-c', 'user.email=a@b.invalid', 'commit', '-m', 'x'])).toEqual([ROOT]);
    expect(dirs('git', ['commit', '-m', 'x'], { cwd: '/elsewhere' })).toEqual(['/elsewhere']);
    expect(dirs('git', ['checkout', '--', 'src'])).toEqual([join(CORE, 'src')]);
    expect(dirs('git', ['worktree', 'add', '/elsewhere/w'])).toEqual([ROOT]);
  });

  it('follows the repository whose objects it reads, wherever it runs', () => {
    const where = { cwd: '/elsewhere' };
    expect(dirs('git', ['--git-dir', join(ROOT, '.git'), 'show', 'HEAD:'], where)).toEqual([ROOT]);
    expect(dirs('git', [`--git-dir=${join(ROOT, '.git')}`, 'ls-files'], where)).toEqual([ROOT]);
    const objects = { ...ENV, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(ROOT, '.git', 'objects') };
    expect(dirs('git', ['log', '-p'], { ...where, env: objects })).toEqual(['/elsewhere', ROOT]);
    expect(dirs('git', ['show', 'HEAD:'], where)).toEqual(['/elsewhere']);
  });

  it('counts a repository on this machine that a clone, fetch or remote reads from', () => {
    const where = { cwd: '/elsewhere' };
    expect(dirs('git', ['clone', '--bare', ROOT, '/elsewhere/c'], where)).toEqual([ROOT]);
    expect(dirs('git', ['clone', `file://${ROOT}/.git`, 'c'], where)).toEqual([ROOT]);
    expect(dirs('git', ['clone', 'https://github.com/o/r.git'], where)).toEqual([]);
    expect(dirs('git', ['clone', '--reference', ROOT, 'git@github.com:o/r.git'], where)).toEqual([
      ROOT,
    ]);
    expect(dirs('git', ['fetch', '--filter=tree:0', ROOT, 'main'], where)).toEqual([ROOT]);
    expect(dirs('git', ['fetch', 'home'], { cwd: FIXTURE })).toEqual([ROOT]);
    expect(dirs('git', ['fetch', 'hub'], { cwd: FIXTURE })).toEqual([]);
    expect(dirs('git', ['fetch', '--all'], { cwd: FIXTURE })).toEqual([ROOT]);
    expect(dirs('git', ['fetch', 'nobody'], { cwd: FIXTURE })).toEqual([ROOT]);
    expect(dirs('git', ['remote', 'add', 'o', ROOT], where)).toEqual([ROOT]);
    expect(dirs('git', ['config', 'remote.o.url', ROOT], where)).toEqual([ROOT]);
    expect(dirs('git', ['init', '--template=../..'])).toEqual([ROOT]);
  });

  it('reads git config by the setting it writes', () => {
    expect(dirs('git', ['config', 'user.email', 'a@b.invalid'])).toEqual([]);
    expect(dirs('git', ['config', '--get', 'core.fsmonitor'])).toEqual([]);
    expect(dirs('git', ['config', 'core.fsmonitor', './walk.sh'], { cwd: '/elsewhere' })).toEqual([
      ROOT,
    ]);
  });

  it('counts git run under a program or setting the environment hands it as the root', () => {
    const run = (env) => dirs('git', ['rev-parse', 'HEAD'], { cwd: '/elsewhere', env });
    expect(run({ ...ENV, GIT_EXTERNAL_DIFF: 'walk' })).toEqual([ROOT]);
    expect(run({ ...ENV, GIT_CONFIG_PARAMETERS: "'merge.x.driver'='walk %O'" })).toEqual([ROOT]);
    expect(run({ ...ENV, GIT_CONFIG_PARAMETERS: "'alias.x'='!ls'" })).toEqual([ROOT]);
    expect(run({ ...ENV, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager' })).toEqual([ROOT]);
    expect(run({ ...ENV, GIT_EXEC_PATH: '/elsewhere/bin' })).toEqual([ROOT]);
    expect(run({ ...ENV, GIT_EDITOR: 'true', GIT_EXEC_PATH: '/usr/lib/git-core' })).toEqual([]);
    expect(run({ ...ENV, GIT_CONFIG_PARAMETERS: "'user.name'='a'" })).toEqual([]);
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
    expect(dirs('git', ['ls-files', '*/../../..'])).toEqual([ROOT]);
  });
});

describe('a program the repository git runs in is set to run', () => {
  const repo = (config = '', hooks = {}) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'whole-tree-configured-')));
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(dir, '.git', 'config'), config);
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit.sample'), '');
    for (const [name, body] of Object.entries(hooks))
      writeFileSync(join(dir, '.git', 'hooks', name), body);
    return dir;
  };
  const made = [];
  const git = (dir, args, env = ENV) => {
    made.push(dir);
    return dirs('git', args, { cwd: dir, env });
  };
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  it('counts a hook, an fsmonitor, a filter and a diff driver for the work that runs each', () => {
    const hooked = repo('', { 'pre-commit': '#!/bin/sh\nls /\n' });
    expect(git(hooked, ['commit', '-m', 'x'])).toEqual([ROOT]);
    expect(git(hooked, ['log', '--oneline'])).toEqual([]);
    const watched = repo('[core]\n\tfsmonitor = ./walk.sh\n');
    expect(git(watched, ['status'])).toEqual([ROOT]);
    const filtered = repo('[filter "x"]\n\tsmudge = walk\n');
    expect(git(filtered, ['checkout', 'main'])).toEqual([ROOT]);
    const differ = repo('[diff "x"]\n\ttextconv = walk\n');
    expect(git(differ, ['log', '-p'])).toEqual([ROOT]);
    expect(git(differ, ['log', '--oneline'])).toEqual([]);
    const merger = repo('[merge "x"]\n\tdriver = walk %O %A %B\n');
    expect(git(merger, ['merge', 'side'])).toEqual([ROOT]);
  });

  it('reads a setting an included config file holds', () => {
    const dir = repo();
    writeFileSync(join(dir, 'more.config'), '[core]\n\thooksPath = /elsewhere\n');
    writeFileSync(join(dir, '.git', 'config'), '[include]\n\tpath = ../more.config\n');
    expect(git(dir, ['commit', '-m', 'x'])).toEqual([ROOT]);
  });

  it('counts an editor a message was not handed, and a signer asked for', () => {
    const dir = repo();
    const tidy = { ...ENV, GIT_EDITOR: 'true' };
    expect(git(dir, ['commit'], { ...ENV, GIT_EDITOR: 'walk' })).toEqual([ROOT]);
    expect(git(dir, ['commit'])).toEqual([ROOT]);
    expect(git(dir, ['commit'], tidy)).toEqual([dir]);
    expect(git(dir, ['commit', '-qm', 'x'], { ...ENV, GIT_EDITOR: 'walk' })).toEqual([dir]);
    expect(git(dir, ['commit', '-S', '-m', 'x'], tidy)).toEqual([ROOT]);
    expect(git(dir, ['verify-commit', 'HEAD'])).toEqual([ROOT]);
    const signing = repo('[commit]\n\tgpgsign = true\n');
    expect(git(signing, ['commit', '-m', 'x'])).toEqual([ROOT]);
    expect(git(repo('[commit]\n\tgpgsign = false\n'), ['commit', '-m', 'x'])).toHaveLength(1);
  });

  it('counts a transport command only where the transport is not a local path', () => {
    const dir = repo(
      `[remote "hub"]\n\turl = git@github.com:o/r.git\n[remote "near"]\n\turl = ${ROOT}\n`,
    );
    const ssh = { ...ENV, GIT_SSH_COMMAND: 'walk' };
    expect(git(dir, ['fetch', 'hub'], ssh)).toEqual([ROOT]);
    expect(git(dir, ['fetch', 'near'], ssh)).toEqual([ROOT]);
    expect(git(dir, ['fetch', '/elsewhere/r'], ssh)).toEqual(['/elsewhere/r']);
    expect(git(dir, ['check-ref-format', 'refs/heads/x'], ssh)).toEqual([]);
    expect(git(dir, ['fetch', 'hub'])).toEqual([]);
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
    const fetch = ['-c', 'fetch.unpackLimit=1', '-C', '/elsewhere', 'fetch', 'https://h/r.git'];
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

describe('the expansions the shell makes itself', () => {
  it('lists the directory a pattern starts from, whatever program gets the words', () => {
    expect(sh('cat ../../*.md')).toEqual([ROOT]);
    expect(dirs('bash', ['-O', 'globstar', '-c', 'cat ../../**/*.md | wc -l'])).toEqual([ROOT]);
    expect(sh('for f in ../../*; do echo "$f"; done')).toEqual([ROOT]);
    expect(sh('grep -l k ../../*.md')).toEqual([ROOT]);
    expect(sh('find ../../* -name x')).toEqual([ROOT, join(ROOT, '*')]);
    expect(sh('wc -l < ../../*.md')).toEqual([ROOT]);
    expect(sh('shopt -s extglob; cat ../../@(CLAUDE|README).md')).toEqual([ROOT]);
    expect(sh('cat "../../"*.md')).toEqual([ROOT]);
    expect(sh('p=../../*.md; cat $p')).toEqual([ROOT]);
    expect(dirs('sh', ['-c', 'cat $@', 'sh', '../../*.md'])).toEqual([ROOT]);
  });

  it('counts a brace expansion and a pattern climbing after a wildcard as the root', () => {
    expect(sh('cat {../..,x}/*.md')).toEqual([ROOT]);
    expect(sh('ls ./*/../../..')).toEqual([ROOT, ROOT]);
  });

  it('lists nothing for a quoted pattern, an assignment, or a pattern inside the package', () => {
    expect(sh("cat '../../*.md'")).toEqual([]);
    expect(sh('p="../../*.md"; cat "$p"')).toEqual([]);
    expect(dirs('sh', ['-c', 'cat "$@"', 'sh', '../../*.md'])).toEqual([]);
    expect(sh('x=../../*; echo done')).toEqual([]);
    expect(sh('cat ./*.md')).toEqual([CORE]);
  });
});

describe('a path placed where the kernel resolves it', () => {
  const OUT = realpathSync(mkdtempSync(join(tmpdir(), 'whole-tree-link-')));
  symlinkSync(join(ROOT, 'packages'), join(OUT, 'link'));
  afterAll(() => rmSync(OUT, { recursive: true, force: true }));

  symlinkSync(ROOT, join(OUT, 'repo'));
  symlinkSync(join(OUT, 'loop'), join(OUT, 'loop'));
  const FAR = realpathSync(mkdtempSync(join(tmpdir(), 'whole-tree-far-')));
  mkdirSync(join(FAR, 'a', 'b', 'c', 'd'), { recursive: true });
  symlinkSync(join(FAR, 'a', 'b', 'c', 'd'), join(CORE, 'deep'));
  afterAll(() => rmSync(FAR, { recursive: true, force: true }));

  it('follows a symlink before its `..`, and counts a `cd` through one as the root', () => {
    expect(dirs('ls', [join(OUT, 'link')])).toEqual([join(ROOT, 'packages')]);
    expect(dirs('ls', [`${OUT}/link/..`])).toEqual([ROOT]);
    expect(sh(`cd ${OUT}/link/.. && ls`)).toEqual([ROOT]);
  });

  it('places a git pathspec both where git normalises it and where the kernel reads it', () => {
    expect(dirs('git', ['ls-files', `${OUT}/link/..`])).toEqual([ROOT, OUT]);
    expect(dirs('git', ['ls-files', `${OUT}/link/core`])).toEqual([CORE, `${OUT}/link/core`]);
    // git takes `deep/../../..` from packages/core as the root before it reads the link; the
    // kernel would take it to where the link points.
    expect(dirs('git', ['ls-files', 'deep/../../..'])).toEqual([join(FAR, 'a'), ROOT]);
  });

  it('reads git run from a spelling of a directory inside the root as running in the root', () => {
    const spelled = join(OUT, 'repo', 'packages', 'core');
    expect(dirs('git', ['ls-files', ':/'], { cwd: spelled })).toEqual([ROOT]);
    expect(dirs('git', ['status'], { cwd: spelled })).toEqual([ROOT]);
    expect(dirs('git', ['status'], { cwd: FAR })).toEqual([FAR]);
  });

  it('counts a path the kernel cannot resolve, a symlink loop, as the root', () => {
    expect(dirs('ls', [join(OUT, 'loop')])).toEqual([ROOT]);
    expect(dirs('git', ['ls-files', join(OUT, 'loop')])).toEqual([ROOT, join(OUT, 'loop')]);
  });

  it('counts a link a shell makes as the root, since a later listing can go through it', () => {
    expect(sh('ln -s ../.. r && ls r/', { cwd: '/elsewhere' })).toEqual([ROOT, '/elsewhere/r']);
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
    expect(dirs('grep', ['-d', 'recurse', 'x', '../..'])).toEqual([ROOT]);
    expect(dirs('grep', ['--directories=recurse', 'x', '../..'])).toEqual([ROOT]);
    expect(dirs('grep', ['-d', 'skip', 'x', '../..'])).toEqual([]);
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

  it('counts a program the test put on PATH, or named by a path of its own, as the root', () => {
    const bin = realpathSync(mkdtempSync(join(tmpdir(), 'whole-tree-bin-')));
    writeFileSync(join(bin, 'cat'), '#!/bin/sh\nls /\n', { mode: 0o755 });
    const env = { ...ENV, PATH: `${bin}:/usr/bin` };
    expect(dirs('cat', ['f.txt'], { env })).toEqual([ROOT]);
    expect(dirs(join(bin, 'cat'), ['f.txt'])).toEqual([ROOT]);
    expect(dirs('cat', ['f.txt'])).toEqual([]);
    writeFileSync(join(bin, 'node'), '#!/bin/sh\nls /\n', { mode: 0o755 });
    writeFileSync(join(bin, 'tsx'), '#!/usr/bin/env node\nrequire("x")\n', { mode: 0o755 });
    expect(dirs('node', ['x.mjs'], { env })).toEqual([ROOT]);
    expect(dirs('tsx', ['x.ts'], { env })).toEqual([]);
    expect(dirs(process.execPath, ['x.mjs'], { env })).toEqual([]);
    rmSync(bin, { recursive: true, force: true });
  });

  it('leaves a program that reads only the files it is named', () => {
    expect(sh('cat package.json | wc -l')).toEqual([]);
    expect(dirs('pgrep', ['-af', '/elsewhere'])).toEqual([]);
    expect(dirs('sort', ['f.txt'])).toEqual([]);
  });
});

describe('a shell string, read by an allowlist', () => {
  // Judge j9's and reopen 7's shapes, each one a shell listing the root where the reader before
  // the allowlist placed it elsewhere. T stands outside the root; lc links into it, out out of it.
  const T = realpathSync(mkdtempSync(join(tmpdir(), 'whole-tree-allow-')));
  const DEEP = join(T, 'a', 'b', 'c', 'd', 'e');
  mkdirSync(DEEP, { recursive: true });
  symlinkSync(CORE, join(T, 'lc'));
  const PROBE = join(CORE, 'src', 'probe');
  mkdirSync(PROBE, { recursive: true });
  symlinkSync(DEEP, join(PROBE, 'out'));
  const bin = join(T, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nexec /usr/bin/git -C / "$@"\n', { mode: 0o755 });
  afterAll(() => {
    rmSync(T, { recursive: true, force: true });
    rmSync(PROBE, { recursive: true, force: true });
  });
  const at =
    (cwd) =>
    (text, opts = {}) =>
      sh(text, { cwd, ...opts });
  const inT = at(T);

  it('counts every cd but the exact form as the root (j9)', () => {
    expect(inT('cd -P lc/../.. && git ls-files')).toContain(ROOT);
    expect(dirs('bash', ['-c', 'set -P; cd lc/../.. && git ls-files'], { cwd: T })).toContain(ROOT);
    expect(dirs('bash', ['-c', 'cd -P lc && cd ../.. && git ls-files'], { cwd: T })).toContain(
      ROOT,
    );
    expect(at(PROBE)('cd out && cd ../../../../.. && git ls-files')).toContain(ROOT);
    expect(at(PROBE)('cd out && cd ../../../../.. && git grep -l k')).toContain(ROOT);
    expect(inT('cd -P lc/../.. && git grep -l k')).toContain(ROOT);
    const cdpath = { env: { ...ENV, CDPATH: ROOT } };
    expect(inT('cd packages >/dev/null && cd .. && git ls-files', cdpath)).toContain(ROOT);
    expect(inT('cd packages >/dev/null && cd .. && git grep -l k', cdpath)).toContain(ROOT);
    expect(inT(`CDPATH=${ROOT}; cd packages >/dev/null && cd .. && git ls-files`)).toContain(ROOT);
    expect(dirs('zsh', ['-c', 'setopt chaselinks; cd lc/../.. && git ls-files'])).toEqual([ROOT]);
  });

  it('counts a cd as the root where the shell may not keep it, or never make it', () => {
    expect(sh('cd ../.. ; (cd /tmp); git ls-files')).toContain(ROOT);
    expect(sh('cd ../.. ; false && cd /tmp; git ls-files')).toContain(ROOT);
    expect(sh('cd ../.. ; cd /tmp | true; git ls-files')).toContain(ROOT);
    expect(sh('for i in 1 2 3; do git ls-files; cd ..; done')).toContain(ROOT);
    expect(sh('cd ../..; pushd /tmp; git ls-files')).toContain(ROOT);
    expect(sh('cd ../..; cd /no-such-dir; git ls-files')).toContain(ROOT);
    expect(sh('cd() { :; }; cd /tmp; git ls-files', { cwd: ROOT })).toContain(ROOT);
    expect(sh('cd ../.. || exit; git ls-files')).toContain(ROOT);
    expect(sh('cd ../..', { env: { ...ENV, PWD: `${T}/lc` } })).toEqual([]);
    expect(sh('cd ../.. && git ls-files', { cwd: CORE, env: { ...ENV, PWD: `${T}/lc` } })).toEqual([
      ROOT,
    ]);
  });

  it('keeps a substitution’s cd inside it', () => {
    expect(sh('echo $(cd /tmp) >/dev/null; git ls-files', { cwd: ROOT })).toEqual([ROOT]);
    expect(sh('echo "$(cd /tmp && git ls-files)"', { cwd: ROOT })).toEqual([ROOT]);
    expect(sh('x=$(cd src && pwd); ls')).toEqual([CORE]);
  });

  it('counts a shell whose start it has not read as the root', () => {
    const fn = { env: { ...ENV, 'BASH_FUNC_git%%': '() { command git -C ../.. "$@"; }' } };
    expect(dirs('bash', ['-c', 'git ls-files'], fn)).toEqual([ROOT]);
    for (const key of ['BASH_ENV', 'SHELLOPTS', 'BASHOPTS', 'PS4', 'EXECIGNORE'])
      expect(dirs('bash', ['-c', 'true'], { env: { ...ENV, [key]: 'x' } })).toEqual([ROOT]);
    expect(dirs('bash', ['-c', 'true'], { env: { ...ENV, SSH_CLIENT: 'h 1 2' } })).toEqual([ROOT]);
    expect(dirs('bash', ['-c', 'true'], { env: { ...ENV, SSH_CLIENT: 'h', SHLVL: '1' } })).toEqual(
      [],
    );
    expect(dirs('bash', ['-lc', 'git ls-files'])).toEqual([ROOT]);
    expect(dirs('bash', ['-i', '-c', 'true'])).toEqual([ROOT]);
    expect(dirs('bash', ['--rcfile', 'x', '-c', 'true'])).toEqual([ROOT]);
    expect(dirs('bash', ['-P', '-c', 'true'])).toEqual([ROOT]);
    expect(dirs('bash', ['-o', 'physical', '-c', 'true'])).toEqual([ROOT]);
    expect(dirs('zsh', ['-c', 'true'])).toEqual([ROOT]);
    expect(dirs('ksh', ['-c', 'true'])).toEqual([ROOT]);
    expect(sh('git ls-files', { shell: '/usr/bin/zsh' })).toEqual([ROOT]);
    expect(dirs('bash', ['-euo', 'pipefail', '-c', 'set -euo pipefail; true'])).toEqual([]);
    expect(dirs('bash', ['-euo', 'physical', '-c', 'true'])).toEqual([ROOT]);
    expect(sh('set -eo physical; true')).toEqual([ROOT]);
    expect(dirs('bash', ['-eu', '-o', 'pipefail', '--noprofile', '--norc', '-c', 'true'])).toEqual(
      [],
    );
  });

  it('counts a builtin that runs or rebinds code as the root, and one that sets a name as unevaluable', () => {
    expect(sh("trap 'git -C ../.. ls-files' EXIT")).toEqual([ROOT]);
    expect(dirs('bash', ['-c', "PS4='$(ls ../..)'; set -x; true"])).toEqual([ROOT]);
    expect(dirs('bash', ['-c', 'hash -p /usr/bin/git cat; cat ls-files ../..'])).toContain(ROOT);
    expect(sh("alias cat='git ls-files ../..'\ncat")).toContain(ROOT);
    expect(dirs('bash', ['-c', 'shopt -s lastpipe; echo ../.. | read X; ls $X'])).toContain(ROOT);
    expect(dirs('bash', ['-c', 'jobs -x git ls-files ../..'])).toEqual([ROOT]);
    expect(dirs('bash', ['-c', 'x=1; declare -i x; true'])).toEqual([ROOT]);
    expect(dirs('bash', ['-c', "[ -v 'a[$(ls /)]' ]"])).toContain(ROOT);
    expect(dirs('bash', ['-c', "printf -v 'a[$(ls /)]' x"])).toContain(ROOT);
    expect(dirs('bash', ['-c', "x='a[$(ls /)]'; [[ $x -eq 0 ]]"])).toEqual([ROOT]);
    expect(dirs('bash', ['-c', 'echo $((x))'])).toEqual([ROOT]);
    expect(dirs('bash', ['-c', 'echo ${x:0:1} ${!x} ${a[1]} ${x@P}'])).toEqual([ROOT]);
    expect(sh('export -f f; true')).toEqual([ROOT]);
    expect(sh('X=/tmp; X=../.. :; git ls-files $X')).toContain(ROOT);
    expect(sh('X=; : ${X:=../..}; git ls-files $X')).toContain(ROOT);
    expect(sh('X=/tmp; echo ../.. | { read X; git ls-files $X; }')).toContain(ROOT);
    expect(sh('X=/tmp; read X; git ls-files $X')).toContain(ROOT);
    expect(sh('OPTARG=src; getopts x: o -x ../..; git ls-files "$OPTARG"')).toContain(ROOT);
    expect(sh("read -p 'a[$(ls /)]' x")).toContain(ROOT);
  });

  it('counts an unquoted word the shell would split as unevaluable', () => {
    expect(sh('D="../.. x"; ls $D')).toContain(ROOT);
    expect(dirs('sh', ['-c', 'ls $@', 'sh', '../.. x'])).toContain(ROOT);
    expect(dirs('sh', ['-c', 'ls "x$@"', 'sh', 'a', '../..'])).toContain(ROOT);
    expect(sh('IFS=/; D=src; ls $D')).toEqual([ROOT]);
    expect(sh('ls $D', { env: { ...ENV, IFS: ':', D: 'src' } })).toEqual([ROOT]);
    expect(sh('D=; ls $D')).toEqual([CORE]);
  });

  it('reads a program on the PATH the string sets, and counts one it made unevaluable', () => {
    expect(sh(`PATH=${bin}; git merge-file a b c`)).toEqual([ROOT]);
    expect(sh('PATH=/usr/bin; git merge-file a b c')).toEqual([]);
    expect(sh('false && PATH=/x; git merge-file a b c')).toEqual([ROOT]);
    expect(sh('NODE_OPTIONS=--x; node x.mjs')).toEqual([ROOT]);
    expect(sh('unset GIT_DIR; git ls-files src')).toEqual([ROOT]);
  });

  it('keeps an exact state for the forms it has read', () => {
    expect(sh('cd src && git ls-files')).toEqual([join(CORE, 'src')]);
    expect(sh('set -eu; cd src && ls')).toEqual([join(CORE, 'src')]);
    expect(sh('cd src; cd ..; ls')).toEqual([CORE]);
    expect(sh('cd ./src/../src && ls')).toEqual([join(CORE, 'src')]);
    expect(sh('git ls-files src | wc -l')).toEqual([join(CORE, 'src')]);
    expect(sh('cd src && ls &')).toEqual([join(CORE, 'src')]);
    expect(sh('X=src; ls "$X"; ls $X')).toEqual([join(CORE, 'src'), join(CORE, 'src')]);
    expect(sh('true && X=src && ls $X')).toEqual([join(CORE, 'src')]);
    expect(sh('export D=src; ls $D')).toEqual([join(CORE, 'src')]);
    expect(sh('set -- src; ls "$1"')).toEqual([join(CORE, 'src')]);
    expect(sh('read X; echo "$X"')).toEqual([]);
    expect(sh('[ -n "$x" ] && echo y')).toEqual([]);
    expect(sh('echo ${HOME:-x} ${#HOME} ${HOME%/*}')).toEqual([]);
    expect(dirs('bash', ['-c', 'shopt -s nullglob dotglob; echo done'])).toEqual([]);
    expect(dirs('dash', ['-ec', 'cd ../.. && ls'])).toEqual([ROOT]);
  });
});
