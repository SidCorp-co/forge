// The git half of the verify memo: the checkout's file list, and which questions a check may put
// to git without the key holding the answer.

import { spawnSync } from 'node:child_process';

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  return r.status === 0 ? r.stdout : null;
}

const split = (text) => (text ?? '').split('\0').filter(Boolean);

export function listFiles(root) {
  const tracked = split(git(root, ['ls-files', '-z', '--cached']));
  const untracked = split(git(root, ['ls-files', '-z', '--others', '--exclude-standard']));
  if (tracked.length === 0) throw new Error(`git listed no tracked file under ${root}`);
  return { tracked, untracked };
}

/** What `git: true` adds to a key: the head, its parent, the base ref and the merge base. */
export function gitState(root, baseRef) {
  const rev = (name) =>
    git(root, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`])?.trim() ?? null;
  const base = git(root, ['merge-base', baseRef, 'HEAD'])?.trim() ?? null;
  return { head: rev('HEAD'), parent: rev('HEAD~1'), baseRef, base };
}

/** The subcommand of a git argv, past `-c key=value`, `-C dir` and the other leading options. */
export function gitCommand(argv) {
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '-c' || rest[i] === '-C') i += 1;
    else if (!rest[i].startsWith('-')) return { name: rest[i], args: rest.slice(i + 1) };
  }
  return { name: null, args: [] };
}

const LS_FILES_FLAGS = new Set([
  '-z',
  '-o',
  '-c',
  '--others',
  '--cached',
  '--exclude-standard',
  '--full-name',
  '--',
]);
const TREE_REV_PARSE = new Set(['--show-toplevel', '--git-dir', '--is-shallow-repository']);
/** Answers about history and the base, held only where a declaration says `git: true`. */
const STATE = new Set(['rev-parse', 'merge-base', 'show', 'log', 'diff', 'cat-file', 'rev-list']);
const INDEX_FLAGS = new Set(['--cached', '--staged']);
/** Options that choose revisions of their own, which no key here holds. */
const SELECTORS =
  /^--(all|branches|tags|remotes|glob|exclude|stdin|reflog|walk-reflogs|alternate-refs)(=|$)|^-g$/;

const options = (args) => args.filter((a) => a.startsWith('-') && a !== '--');
const operands = (args) => {
  const end = args.indexOf('--');
  return args.slice(0, end < 0 ? args.length : end).filter((a) => !a.startsWith('-'));
};
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The part of a revision argument the key does not hold; the base ref's tip only reaches a merge base. */
function unheld(arg, state, tipOk) {
  const names = tipOk ? `HEAD|${literal(state.baseRef ?? 'HEAD')}` : 'HEAD';
  const named = new RegExp(`^(${names})([~^][0-9]*)*$`);
  const known = [state.head, state.parent, state.base].filter(Boolean);
  const pieces = arg
    .split(':')[0]
    .replace(/\^\{(commit|tree)\}$/, '')
    .split(/\.{2,3}/);
  return (
    pieces
      .map((p) => p.replace(/^\^/, ''))
      .find(
        (p) =>
          p !== '' &&
          !named.test(p) &&
          !(/^[0-9a-f]{7,64}$/.test(p) && known.some((k) => k.startsWith(p))),
      ) ?? null
  );
}

/** Why a git command a traced run made is not covered by `decl` and `state`, or null where it is. */
export function gitFault(argv, decl, state = {}) {
  const { name, args } = gitCommand(argv);
  const said = `git ${name ?? argv.slice(1).join(' ')}`;
  const refuse = (why) => `ran \`${said}\`, ${why}`;
  if (name === 'ls-files') {
    return args.every((a) => LS_FILES_FLAGS.has(a) || !a.startsWith('-'))
      ? null
      : refuse('which reads the index');
  }
  if (name === 'check-ignore') return null;
  if (name === 'rev-parse' && args.every((a) => TREE_REV_PARSE.has(a))) return null;
  if (!decl.git)
    return refuse(
      STATE.has(name) || name === 'symbolic-ref' || name === 'ls-remote'
        ? 'but its declaration has no `git`'
        : 'which the key cannot hold',
    );
  if (name === 'ls-remote') {
    return args.join(' ') === '--symref origin HEAD'
      ? null
      : refuse('which asks a remote the key does not hold');
  }
  if (name === 'symbolic-ref') {
    return args.every((a) => a === '--short' || /^refs\/remotes\/[^/]+\/HEAD$/.test(a))
      ? null
      : refuse('which names a ref the key does not hold');
  }
  if (name === 'grep')
    return operands(args).length <= 1 && !options(args).some((a) => INDEX_FLAGS.has(a))
      ? null
      : refuse('which reads past the working tree');
  if (!STATE.has(name)) return refuse('which the key cannot hold');
  if (args.some((a) => INDEX_FLAGS.has(a) || a.startsWith(':')))
    return refuse('which reads the index');
  if (args.some((a) => SELECTORS.test(a)))
    return refuse('which selects revisions the key does not hold');
  if (name === 'diff' && operands(args).length === 0)
    return refuse('which with no revision reads the index');
  const stray = operands(args)
    .map((a) => unheld(a, state, name === 'merge-base' || name === 'rev-parse'))
    .find(Boolean);
  return stray ? refuse(`which names ${stray}, a revision the key does not hold`) : null;
}
