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

/** What `git: true` adds to a key: the head, and the base the change is judged against. */
export function gitState(root, baseRef, base) {
  return { head: git(root, ['rev-parse', 'HEAD'])?.trim() ?? null, baseRef, base };
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
/** Answers about history, branches and the base, held only where a declaration says `git: true`. */
const STATE = new Set([
  'rev-parse',
  'symbolic-ref',
  'ls-remote',
  'merge-base',
  'show',
  'log',
  'diff',
  'cat-file',
  'grep',
  'rev-list',
]);
const INDEX_FLAGS = new Set(['--cached', '--staged']);

const revisions = (args) =>
  args
    .slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'))
    .filter((a) => !a.startsWith('-'));

/** Why a git command a traced run made is not covered by `decl`, or null where it is. */
export function gitFault(argv, decl) {
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
  if (!STATE.has(name)) return refuse('which the key cannot hold');
  if (args.some((a) => INDEX_FLAGS.has(a) || a.startsWith(':')))
    return refuse('which reads the index');
  if (name === 'diff' && revisions(args).length === 0)
    return refuse('which with no revision reads the index');
  return decl.git ? null : refuse('but its declaration has no `git`');
}
