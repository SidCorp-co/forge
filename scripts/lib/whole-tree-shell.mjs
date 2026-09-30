// What a program a test spawns lists, read against a CLOSED GRAMMAR (ISS-1314, reopen 8). The watch
// cannot see inside a program that is not Node, and eight rounds of interpreting shell strings,
// launchers, builtins and each program's options each let one more form through. So this no longer
// interprets: it admits a small, printable set of spawns and refuses everything else as listing the
// repository root. The accepted grammar is `node scripts/lib/whole-tree-shell.mjs --print-grammar`,
// generated from the very tables the reader uses, so the two cannot drift.
//
// A spawn is admitted only when every rule below holds; the first one broken names the refusal.
// - spawn options: only a known-safe set (no argv0, no shell, no uid/gid);
// - a shell string: only `exec`/`execSync` through Node's /bin/sh where that is dash, plain words;
// - the program resolves to a system path, and is one of git, grep, node;
// - the environment equals the worker's base but for keys a program is allowed to move;
// - the program's own grammar (git's subcommand table, grep's options, node's options) holds.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** The file every watched Node process preloads; a NODE_OPTIONS still naming it keeps the watch. */
export const PRELOAD_MARK = 'whole-tree-child.mjs';

const MAGIC_SEGMENT = /[*?[\]{}()!+@]/;

/** The directory a glob pattern starts listing from: its segments before the first magic one. */
export function globBase(pattern) {
  const kept = [];
  for (const seg of pattern.split(/[\\/]/)) {
    if (MAGIC_SEGMENT.test(seg)) break;
    kept.push(seg);
  }
  const base = kept.join('/');
  if (base) return base;
  return pattern.startsWith('/') ? '/' : '.';
}

/**
 * Whether a glob climbs with a `..` after its first magic segment: the walk then ends wherever the
 * matches lead, which no reading of the prefix says, so such a pattern counts as the root.
 */
export function climbsAfterMagic(pattern) {
  let magic = false;
  for (const seg of pattern.split(/[\\/]/)) {
    if (magic && seg === '..') return true;
    if (MAGIC_SEGMENT.test(seg)) magic = true;
  }
  return false;
}

/**
 * Where the kernel resolves a path: the realpath of the path as written, its parent segments not
 * collapsed first, so a symlink's `..` and `/proc/self/cwd` land where a listing of them lands. A
 * path that does not exist keeps its lexical placement; one the kernel cannot resolve for any other
 * reason (a symlink loop, a directory it may not search) is `null`, which every caller counts as the
 * root.
 */
export function physical(path) {
  try {
    return realpathSync.native(path);
  } catch (e) {
    return e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? resolve(path) : null;
  }
}

/**
 * Whether `dir` is `root` or inside it, decided on canonical paths: each side is read both as
 * written and by its realpath, and either reading inside counts. A directory that cannot be
 * canonicalized counts as inside, since nothing rules it out.
 */
export function withinRoot(root, dir) {
  const dirs = [dir, physical(dir)];
  if (dirs.includes(null)) return true;
  const roots = [...new Set([root, physical(root) ?? root])];
  return dirs.some((d) => roots.some((r) => d === r || d.startsWith(`${r}${sep}`)));
}

const isWord = (w) => typeof w === 'string';

/** A listing entry: the directory listed and how, or a refusal counted as the root. */
function at(dir, via) {
  return { dir, via };
}
function root(via, r) {
  return { dir: r, via, unseen: true };
}

// --- the grammar, as data --------------------------------------------------------------------------

/** Spawn options a call may carry. Anything else — argv0, shell, uid, gid — puts it outside. */
const ALLOWED_OPTIONS = new Set([
  ...['cwd', 'env', 'encoding', 'stdio', 'input', 'timeout', 'maxBuffer', 'killSignal'],
  ...['windowsHide', 'signal', 'detached'],
]);
/** Options only a `fork` may add. */
const FORK_OPTIONS = new Set(['execPath', 'execArgv', 'silent', 'serialization', 'cwd']);

/** The shells Node's `shell: true`/`exec` may resolve to: only the dash Node starts as `/bin/sh`. */
const DASH_PATHS = new Set(['/bin/dash', '/usr/bin/dash']);
/** A plain-word shell string: only these characters, space-separated words. */
const PLAIN_WORD = /^[A-Za-z0-9._/:@%+,=^-]+$/;

/** System directories a program name may resolve into; anything else is a program nobody reviewed. */
const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin'];
/** The programs the grammar reads. Everything else counts as the root. */
const PROGRAMS = new Set(['git', 'grep', 'node']);

/** Environment keys that make a program run code at startup, refused whenever a spawn SETS one to a
 * non-empty value (dropping one is safe). Compared against the spawn's own env, not the base. */
const STARTUP_KEYS = [
  'ENV',
  'BASH_ENV',
  'SHELLOPTS',
  'BASHOPTS',
  'PS4',
  'IFS',
  'CDPATH',
  'OPENSSL_CONF',
  'OPENSSL_MODULES',
  'OPENSSL_ENGINES',
];
/** Keys naming an editor or pager a program launches: allowed only when they run nothing. */
const EDITOR_KEYS = ['EDITOR', 'VISUAL', 'PAGER', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR'];
/** git environment keys naming a program git runs, refused whenever set. */
const GIT_PROGRAM_ENV = [
  'GIT_EXTERNAL_DIFF',
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'GIT_PROXY_COMMAND',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_EXEC_PATH',
];
const runsProgram = (key) =>
  key.startsWith('LD_') || key.startsWith('DYLD_') || key.startsWith('BASH_FUNC_');

/** git's subcommand table: flags (no value), valued options and how they take it, operand bounds. */
const GIT_SUBCOMMANDS = {
  add: { flags: ['-A'], valued: {}, min: 0, max: Infinity },
  'check-ref-format': { flags: [], valued: {}, min: 1, max: 1, lists: false },
  checkout: {
    flags: ['-q', '--quiet', '--detach', '-f', '--force'],
    valued: { '-b': 'next', '-B': 'next' },
    min: 0,
    max: 2,
  },
  clone: {
    flags: ['-q', '--quiet', '--bare'],
    valued: {
      '-b': 'next',
      '--branch': 'both',
      '--depth': 'both',
      '-o': 'next',
      '--origin': 'next',
    },
    min: 1,
    max: 2,
    repos: 'clone',
  },
  'commit-tree': {
    flags: [],
    valued: { '-p': 'next', '-m': 'next', '-F': 'next' },
    min: 1,
    max: 1,
  },
  log: {
    flags: ['-z', '--oneline', '--reverse', '--first-parent', '--all', '--no-color', '--graph'],
    valued: {
      '--max-count': 'both',
      '-n': 'next',
      '--format': 'both',
      '--pretty': 'both',
      '--since': 'both',
      '--until': 'both',
      '--author': 'both',
      '--grep': 'both',
    },
    min: 0,
    max: 2,
  },
  'for-each-ref': {
    flags: [],
    valued: { '--points-at': 'next', '--format': 'both', '--count': 'next', '--sort': 'both' },
    min: 0,
    max: Infinity,
  },
  'update-ref': { flags: ['-d'], valued: {}, min: 1, max: 3 },
  commit: {
    flags: ['-q', '--quiet', '--allow-empty'],
    valued: { '-m': 'next', '-am': 'next' },
    min: 0,
    max: 0,
    needsMessage: true,
  },
  config: { flags: [], valued: {}, min: 2, max: 2, config: true },
  diff: {
    flags: ['--cached', '--name-only', '--no-renames', '--no-color', '-z'],
    valued: { '--unified': 'eq', '--diff-filter': 'eq' },
    min: 0,
    max: 2,
  },
  fetch: {
    flags: ['-q', '--quiet', '--no-tags', '--tags', '--prune', '-p', '--all', '--force', '-f'],
    valued: { '--filter': 'both', '--depth': 'both' },
    min: 0,
    max: Infinity,
    repos: 'remote',
  },
  init: {
    flags: ['-q', '--quiet', '--bare'],
    valued: { '-b': 'next', '--initial-branch': 'eq' },
    min: 0,
    max: 1,
    repos: 'init',
  },
  'ls-files': {
    flags: ['--others', '--exclude-standard', '-z'],
    valued: {},
    min: 0,
    max: Infinity,
  },
  'ls-remote': { flags: ['--tags'], valued: {}, min: 1, max: 2, repos: 'remote' },
  'ls-tree': {
    flags: ['--name-only', '-r', '--full-tree'],
    valued: {},
    min: 1,
    max: Infinity,
    dashdash: true,
  },
  grep: {
    flags: ['-l', '-i', '-n', '-w', '-F', '-E', '--cached', '-r', '-h', '-I', '-c'],
    valued: { '-e': 'next', '--max-depth': 'both' },
    min: 0,
    max: Infinity,
    dashdash: true,
  },
  merge: {
    flags: ['-q', '--quiet', '--no-ff', '--ff-only', '--no-commit', '--no-edit', '--squash'],
    valued: { '-m': 'next' },
    min: 1,
    max: Infinity,
    needsMessageOrNoEdit: true,
  },
  'merge-base': {
    flags: ['--is-ancestor', '--all', '--independent', '--octopus', '--fork-point'],
    valued: {},
    min: 1,
    max: Infinity,
  },
  push: {
    flags: ['-q', '-f', '--delete'],
    valued: { '--force-with-lease': 'eq' },
    min: 1,
    max: Infinity,
    repos: 'remote',
  },
  remote: { flags: ['-a'], valued: {}, min: 1, max: 3, repos: 'remote-sub' },
  'rev-list': { flags: ['--parents', '--count'], valued: { '-n': 'next' }, min: 1, max: 1 },
  'rev-parse': {
    flags: [
      '--verify',
      '--abbrev-ref',
      '--short',
      '--quiet',
      '-q',
      '--show-toplevel',
      '--show-prefix',
      '--show-cdup',
      '--git-dir',
      '--git-common-dir',
      '--absolute-git-dir',
      '--is-inside-work-tree',
      '--is-inside-git-dir',
      '--is-bare-repository',
      '--is-shallow-repository',
      '--symbolic-full-name',
      '--verify-quiet',
    ],
    valued: {},
    min: 0,
    max: Infinity,
  },
  rm: { flags: ['-q', '--quiet', '-r'], valued: {}, min: 1, max: Infinity },
  show: { flags: [], valued: {}, min: 1, max: 1 },
  'symbolic-ref': { flags: ['--short', '-d'], valued: {}, min: 1, max: 2 },
  tag: {
    flags: ['-d', '--list'],
    valued: { '--points-at': 'next', '-m': 'next' },
    min: 0,
    max: Infinity,
  },
  worktree: { flags: ['-q', '--detach', '--force'], valued: {}, min: 1, max: 3, worktree: true },
};
/** An editor value that runs nothing: git's own `true`/`:` for a non-interactive commit. */
const NO_EDITOR = /^(true|:)$/;
/** Config keys a repository git touches outside the root may hold. Anything else is outside. */
const REPO_CONFIG_KEYS = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/,
  /^user\.(name|email)$/,
  /^init\.defaultbranch$/,
  /^remote\..+\.fetch$/,
  /^branch\..+\.(remote|merge)$/,
  /^uploadpack\.allowfilter$/,
];
const REPO_CONFIG_URL = /^remote\..+\.url$/;

/** node options before the script; anything else is outside. */
const NODE_FLAGS = new Set([
  ...['-e', '--eval', '-p', '--print', '--experimental-import-meta-resolve', '--no-warnings'],
  ...['--enable-source-maps', '--input-type=module', '--input-type=commonjs', '--'],
]);
const NODE_VALUED = new Set(['--conditions', '-C']);
const NODE_PRELOAD = new Set(['--require', '-r', '--import']);
const NODE_CODE = new Set(['-e', '--eval', '-p', '--print']);

/** grep options: flags, and `-e`/`--include`/`--exclude` that take a value. */
const GREP_FLAGS = new Set(['-r', '-l', '-rl', '-lr', '-n', '-i', '-F', '-E', '-w', '-s', '-q']);
const GREP_VALUED = new Set(['-e']);
const GREP_VALUED_EQ = new Set(['--include', '--exclude']);

// --- entry -----------------------------------------------------------------------------------------

/**
 * What a spawn lists, as `[{ dir, via, unseen? }]`. A spawn outside the grammar returns one root
 * entry naming the rule it broke. `base` is `{ env, configs }` the watch captured at install; where
 * it is absent the reader takes `env` as its own base, which the tests do.
 */
export function subprocessListing({
  command,
  args = [],
  shell = false,
  cwd,
  root: repoRoot,
  env = {},
  opts = {},
  argv0 = null,
  fork = false,
  base = null,
}) {
  const refuse = (why) => [root(`${why}, so counted as listing the repository root`, repoRoot)];
  const baseEnv = base?.env ?? env;

  // 1. Spawn options.
  const allowed = fork ? FORK_OPTIONS : ALLOWED_OPTIONS;
  for (const key of Object.keys(opts)) {
    if (allowed.has(key)) continue;
    if (key === 'env' || key === 'cwd') continue;
    return refuse(`the spawn option \`${key}\` is outside the grammar`);
  }
  if (argv0 !== null && argv0 !== command) return refuse('the spawn sets argv0');

  // A fork runs Node — `execPath`, or this Node — with its `execArgv` (or the parent's), then its
  // module and arguments. A fork naming another program is that program, not Node.
  if (fork) {
    const nodePath = physical(String(command));
    if (nodePath !== (physical(process.execPath) ?? process.execPath))
      return refuse(`\`fork\` runs \`${short(String(command))}\`, which is not this Node`);
    const envRefusal = envOutside('node', env, baseEnv);
    if (envRefusal) return refuse(envRefusal);
    const execArgv = Array.isArray(opts.execArgv)
      ? opts.execArgv.map(String)
      : (base?.execArgv ?? []);
    return nodeListing([...execArgv, ...args.map(String)], cwd, repoRoot, baseEnv);
  }

  // 2. A shell string, or a direct argv.
  let argv;
  if (shell) {
    if (shell !== true) return refuse(`a shell option names \`${shell}\``);
    const binSh = physical('/bin/sh');
    if (!DASH_PATHS.has(binSh ?? '')) return refuse(`\`/bin/sh\` is \`${binSh}\`, not dash`);
    const text = [String(command), ...args.map(String)].join(' ');
    if (!text.split(' ').every((w) => w === '' || PLAIN_WORD.test(w)))
      return refuse('a shell string with a character outside the plain-word grammar');
    argv = text.split(' ').filter(Boolean);
    if (argv.length === 0) return [];
  } else {
    argv = [String(command), ...args.map(String)];
  }

  // 3. Where the program resolves.
  const [head, ...rest] = argv;
  const resolved = resolveProgram(head, cwd, env);
  const helper = reviewedHelper({
    head,
    resolved,
    args: rest,
    env,
    hasFrame: base?.hasFrame ?? true,
  });
  if (helper) return [];
  if (resolved === null) return refuse(`\`${short(head)}\` resolves to no program`);
  const bin = basename(resolved);
  const inSystem = SYSTEM_DIRS.includes(dirname(resolved));
  const isNode = resolved === (physical(process.execPath) ?? process.execPath);
  if (!PROGRAMS.has(bin)) return refuse(`\`${short(head)}\` is not git, grep or node`);
  if (bin === 'node' && !isNode)
    return refuse(`\`${short(head)}\` is a program named node that is not this Node`);
  if ((bin === 'git' || bin === 'grep') && !inSystem)
    return refuse(`\`${bin}\` resolves to ${resolved}, outside the system directories`);

  // 4. The environment against the base.
  const envRefusal = envOutside(bin, env, baseEnv);
  if (envRefusal) return refuse(envRefusal);

  // 5. The program's own grammar.
  if (bin === 'git') return gitListing(rest, cwd, repoRoot, env, base, refuse);
  if (bin === 'grep') return grepListing(rest, cwd, refuse);
  return nodeListing(rest, cwd, repoRoot, baseEnv, refuse);
}

const short = (s) => (s.length > 60 ? `…${s.slice(-59)}` : s);

/** The realpath of the program a name runs: a path where it is one, or the first on `PATH`. */
function resolveProgram(head, cwd, env) {
  if (!isWord(head)) return null;
  if (head.includes('/')) {
    if (!isAbsolute(head) && cwd === null) return null;
    return physical(isAbsolute(head) ? head : `${cwd}/${head}`);
  }
  if (!isWord(env.PATH)) return null;
  for (const dir of env.PATH.split(':')) {
    const candidate = join(dir || '.', head);
    if (existsSync(candidate))
      return physical(isAbsolute(candidate) ? candidate : `${cwd}/${candidate}`);
  }
  return null;
}

/** esbuild's service, the one reviewed helper: its resolved binary, `--service=<v> --ping`, no frame. */
function reviewedHelper({ resolved, args, hasFrame }) {
  if (resolved === null || hasFrame) return false;
  if (basename(resolved) !== 'esbuild' || !resolved.includes('/node_modules/')) return false;
  return args.length === 2 && /^--service=[\d.]+$/.test(args[0]) && args[1] === '--ping';
}

/** Why a spawn's environment puts it outside, or null. `PATH` and startup keys must equal the base. */
function envOutside(bin, env, baseEnv) {
  const strip = (e) => {
    const out = { ...e };
    delete out[LOG_ENV_NAME];
    if (isWord(out.NODE_OPTIONS)) out.NODE_OPTIONS = withoutPreload(out.NODE_OPTIONS);
    return out;
  };
  const cur = strip(env);
  const b = strip(baseEnv);
  // PATH and NODE_OPTIONS must equal the base: a changed PATH resolves a program elsewhere, and a
  // NODE_OPTIONS with its own preload runs before the watch. Every real test keeps both.
  if ((cur.PATH ?? '') !== (b.PATH ?? '')) return 'the spawn changes PATH';
  if ((cur.NODE_OPTIONS ?? '') !== (b.NODE_OPTIONS ?? '')) return 'the spawn changes NODE_OPTIONS';
  // The rest is read off the spawn's own env against the base: a key it ADDS or CHANGES to run code
  // puts it outside, while a key inherited unchanged from the worker (the machine's own environment,
  // trusted) or dropped is safe. This is what lets a test seal its env down, or run under the
  // worker's own EDITOR, while a planted LD_PRELOAD or BASH_FUNC_ is caught.
  const added = (key) => isWord(cur[key]) && cur[key] !== '' && cur[key] !== b[key];
  for (const key of STARTUP_KEYS)
    if (added(key)) return `the spawn sets the startup variable \`${key}\``;
  for (const key of Object.keys(cur))
    if (runsProgram(key) && added(key)) return `the spawn sets the startup variable \`${key}\``;
  for (const key of EDITOR_KEYS)
    if (added(key) && !NO_EDITOR.test(cur[key])) return `the spawn sets \`${key}\` to a program`;
  if (bin === 'git')
    for (const key of GIT_PROGRAM_ENV) if (added(key)) return `the spawn sets \`${key}\` for git`;
  return null;
}

const LOG_ENV_NAME = 'FORGE_WHOLE_TREE_LOG';
const withoutPreload = (opt) =>
  opt
    .split(/\s+/)
    .filter((t) => !t.includes(PRELOAD_MARK) && t !== '--import' && t !== '--require' && t !== '-r')
    .join(' ')
    .trim();

// --- git -------------------------------------------------------------------------------------------

function gitListing(argv, cwd, repoRoot, env, base, refuse) {
  let dir = cwd;
  let i = 0;
  for (; i < argv.length && isWord(argv[i]) && argv[i].startsWith('-'); i++) {
    const a = argv[i];
    if (a === '-C') {
      const val = argv[++i];
      if (!isWord(val)) return refuse('git -C with a non-literal directory');
      dir = dir === null ? null : physical(isAbsolute(val) ? val : `${dir}/${val}`);
    } else if (a === '-c') {
      if (argv[++i] !== 'core.quotePath=false')
        return refuse('git -c with a setting off the grammar');
    } else {
      return refuse(`the git global option \`${a}\` is outside the grammar`);
    }
  }
  const sub = argv[i];
  if (!isWord(sub)) return refuse('git with a subcommand named by a substitution');
  const spec = GIT_SUBCOMMANDS[sub];
  if (!spec) return refuse(`the git subcommand \`${sub}\` is outside the grammar`);
  const tail = argv.slice(i + 1);

  const parsed = parseGit(spec, tail);
  if (parsed.error) return refuse(`\`git ${sub}\`: ${parsed.error}`);

  // Where git runs, and the repository it belongs to.
  const top = dir === null ? null : repoTop(dir);
  const via = `git ${sub}`;
  const found = [];

  // A subcommand that runs in a repository trusts it, or is refused where it cannot be trusted.
  // Where git finds no repository (`top` is null) it errors and enumerates nothing, so the call is
  // read as listing nothing but any repository it names as an operand.
  const runsHere =
    spec.repos !== 'clone' && spec.repos !== 'init' && sub !== 'check-ref-format' && top !== null;
  if (runsHere) {
    if (!withinRoot(repoRoot, top)) {
      const bad = repoTrust(top, repoRoot);
      if (bad) return refuse(`\`${via}\` in a repository ${bad}`);
    }
    const cfgBad = configTrust(env, base);
    if (cfgBad) return refuse(`\`${via}\` reading ${cfgBad}`);
  }

  // `show` prints an object: `REV:path` reads that path in a tree, `REV:` or a bare commit the
  // whole tree. Its `REV:path` is how the real tests read a named file out of a fixture.
  if (sub === 'show' && runsHere) {
    const obj = parsed.operands.find(isWord) ?? '';
    if (!obj.includes(':')) return refuse(`\`git show ${short(obj)}\` prints a whole commit`);
    const path = obj.slice(obj.indexOf(':') + 1);
    // `REV:path` reads that path from the repository top; `REV:` or a climbing path reads the tree.
    const fromCwd = /^\.\.?\//.test(path);
    if (path === '' || path.includes('..') || (fromCwd && dir === null))
      found.push(at(top, `git show ${obj}`));
    else {
      const p = physical(isAbsolute(path) ? path : `${fromCwd ? dir : top}/${path}`);
      found.push(
        p === null ? root(`git show at an unresolvable path`, repoRoot) : at(p, `git show ${obj}`),
      );
    }
  }

  // A tree-reader lists its pathspecs, or the repo top when handed none.
  if (GIT_TREE_READERS.has(sub) && runsHere) {
    const specs = pathspecsOf(sub, parsed, tail);
    if (specs.length === 0) {
      found.push(at(top, via));
    } else {
      for (const spec2 of specs) {
        const placed = pathspecDir(spec2, dir, top, via, repoRoot);
        if (placed === null) return refuse(`\`${via}\` handed the climbing pathspec \`${spec2}\``);
        found.push(placed);
      }
    }
  }

  // Repositories named as operands (clone source/dest, remotes).
  found.push(...repoOperands(sub, spec, parsed, dir, repoRoot));
  return found.filter(Boolean);
}

/** git subcommands that enumerate the work tree or the index; every other reads refs or objects. */
const GIT_TREE_READERS = new Set(['ls-files', 'ls-tree', 'grep', 'diff', 'add', 'rm']);

/** The pathspecs a tree-reader narrows by: its operands, less a leading tree-ish or pattern that
 * comes before `--` for `ls-tree` and `grep`, which name a revision or a search term, not a path. */
function pathspecsOf(sub, parsed, tail) {
  const dash = tail.indexOf('--');
  const before = parsed.operands.filter((o) => dash === -1 || tail.indexOf(o) < dash);
  const after = dash === -1 ? [] : parsed.operands.filter((o) => tail.indexOf(o) > dash);
  if (sub === 'ls-tree') return [...before.slice(1), ...after]; // first before-word is the tree-ish
  if (sub === 'grep') return dash === -1 ? before.slice(1) : after; // a pattern precedes `--`
  return parsed.operands.filter(isWord);
}

/** Where one pathspec starts listing: its `:/`·`:(top)` magic read, an exclusion dropped, a glob
 * placed at its base. `null` where it climbs past a wildcard, since its walk's end is unknown. */
function pathspecDir(spec, base, top, via, repoRoot) {
  if (!isWord(spec)) return at(base ?? repoRoot, via);
  let s = spec;
  let from = base;
  if (s.startsWith(':')) {
    const m = /^:(?:\(([^)]*)\)|([/!^]*))(.*)$/s.exec(s);
    const magic = m[1] === undefined ? [...(m[2] ?? '')] : m[1].split(',');
    if (magic.some((x) => ['!', '^', 'exclude'].includes(x)))
      return at(base ?? top, `${via} (exclusion)`);
    if (magic.some((x) => x === '/' || x === 'top')) from = top;
    s = m[3];
  }
  if (climbsAfterMagic(s)) return null;
  if (from === null) return at(repoRoot, via);
  const g = globBase(s || '.');
  // git normalizes a pathspec's `.`/`..` lexically — it never follows a symlink to resolve a `..`,
  // unlike the kernel a `node:fs` listing goes through. So the spec is placed by lexical resolution
  // against the (physical) cwd: `down/..` cancels textually rather than climbing out of the symlink
  // `down`'s target, matching the set of tracked paths `git ls-files` would enumerate (ISS-1314).
  const baseAbs = physical(from) ?? from;
  const p = isAbsolute(g) ? resolve(g) : resolve(baseAbs, g);
  return at(p, `${via} ${spec}`);
}

function parseGit(spec, tail) {
  const operands = [];
  let understood = true;
  let error = null;
  let sawMessage = false;
  let sawNoEdit = false;
  let dashdash = false;
  for (let k = 0; k < tail.length; k++) {
    const a = tail[k];
    if (dashdash || !isWord(a) || !a.startsWith('-') || a === '-') {
      operands.push(a);
      continue;
    }
    if (a === '--') {
      dashdash = true;
      continue;
    }
    const flag = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (spec.flags.includes(a)) {
      if (['--no-edit', '--no-commit', '--squash', '--ff-only'].includes(a)) sawNoEdit = true;
      continue;
    }
    if (Object.hasOwn(spec.valued, flag)) {
      if (['-m', '-am', '--message'].includes(flag)) sawMessage = true;
      const kind = spec.valued[flag];
      if ((kind === 'next' || kind === 'both') && !a.includes('=')) k++;
      continue;
    }
    understood = false;
  }
  if (!understood) error = `an option or count off the table`;
  else if (operands.length < spec.min || operands.length > spec.max)
    error = `${operands.length} operand(s), outside ${spec.min}..${spec.max === Infinity ? '∞' : spec.max}`;
  else if (spec.needsMessage && !sawMessage) error = 'no message, so an editor would open';
  else if (spec.needsMessageOrNoEdit && !sawMessage && !sawNoEdit)
    error = 'no message or --no-edit, so an editor would open';
  return { operands, error };
}

/** Repositories a subcommand names as operands: clone's source/dest, a remote's URL. */
function repoOperands(sub, spec, parsed, dir, repoRoot) {
  const via = `git ${sub}`;
  const words = parsed.operands.filter(isWord);
  const entries = [];
  const local = (word) => {
    if (word === undefined) return;
    // A remote URL (undefined) reads over the network and lists nothing of a local tree; only a
    // local repository (a path or a remote name resolving to one) is read here.
    const t = localRepoTop(word, dir, repoRoot);
    if (t === null || t === undefined) return;
    entries.push(at(t, `${via} of a local repository`));
  };
  const targetDir = (word, label) => {
    if (!isWord(word) || dir === null) return;
    const p = physical(isAbsolute(word) ? word : `${dir}/${word}`);
    if (p !== null && isDir(p)) entries.push(at(p, `${via} ${label}`));
  };
  if (spec.repos === 'clone') {
    local(words[0]);
    targetDir(words[1], 'destination');
  } else if (spec.repos === 'init') {
    targetDir(words[0], 'target');
  } else if (spec.repos === 'remote') {
    local(words[0]);
  } else if (spec.repos === 'remote-sub') {
    if (['add', 'set-url'].includes(words[0])) local(words.at(-1));
    else if (words[0] === 'set-head' && parsed.operands.includes('-a')) local(words[1]);
  }
  return entries;
}

/** A repository argument on this machine as its top: a path or `file://` URL, or a remote name whose
 * configured URL is a local path. `null` where it names nothing local; `undefined` for a remote URL. */
function localRepoTop(word, dir, repoRoot) {
  if (!isWord(word) || dir === null) return null;
  // A bare name (no slash, no scheme) is a remote name, not a path: resolve it through the config.
  if (!word.includes('/') && !word.includes(':') && !existsSync(`${dir}/${word}`)) {
    const url = remoteUrl(dir, word);
    if (url === undefined) return null; // no such remote configured here; git errors, lists nothing
    return localRepoTop(url, dir, repoRoot);
  }
  let path = word;
  if (/^file:\/\//i.test(word)) path = word.replace(/^file:\/\//i, '');
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(word) || /^[^/]+:/.test(word)) return undefined;
  const abs = physical(isAbsolute(path) ? path : `${dir}/${path}`);
  if (abs === null) return null;
  return repoTop(abs) ?? abs;
}

/** The URL configured for a remote in the repository git runs in, or undefined where there is none. */
function remoteUrl(dir, name) {
  const top = repoTop(dir);
  if (top === null) return undefined;
  for (const { key, value } of configKeys(join(gitDirOfTop(top), 'config')))
    if (key === `remote.${name.toLowerCase()}.url`) return value;
  return undefined;
}

/** The top of the repository holding `dir`, or null when git would find none. */
function repoTop(dir) {
  for (let d = dir; ; d = dirname(d)) {
    const gitPath = join(d, '.git');
    if (existsSync(gitPath)) return d;
    if (isBareRepo(d)) return d;
    if (dirname(d) === d) return null;
  }
}
function isBareRepo(d) {
  try {
    return (
      existsSync(join(d, 'HEAD')) && existsSync(join(d, 'objects')) && existsSync(join(d, 'refs'))
    );
  } catch {
    return false;
  }
}

/** The git directory for a top: `.git` dir, the pointer a `.git` file names, or the bare top. */
function gitDirOfTop(top) {
  const gitPath = join(top, '.git');
  if (!existsSync(gitPath)) return top;
  try {
    const st = lstatSync(gitPath);
    if (st.isDirectory()) return gitPath;
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitPath, 'utf8'));
    if (!pointer) return gitPath;
    const wt = resolve(top, pointer[1].trim());
    const common = join(wt, 'commondir');
    return existsSync(common) ? resolve(wt, readFileSync(common, 'utf8').trim()) : wt;
  } catch {
    return gitPath;
  }
}

/** Why a repository outside the root is not trusted: an alternate, a real hook, or a bad config key. */
function repoTrust(top, repoRoot) {
  if (withinRoot(repoRoot, top)) return null;
  const gitDir = gitDirOfTop(top);
  try {
    if (existsSync(join(gitDir, 'objects', 'info', 'alternates')))
      return 'that names an object alternate';
  } catch {}
  try {
    const hooks = join(gitDir, 'hooks');
    if (existsSync(hooks))
      for (const h of readdirSync(hooks))
        if (!h.endsWith('.sample')) return `whose hook \`${h}\` is set`;
  } catch {}
  for (const file of [join(gitDir, 'config'), join(gitDir, 'config.worktree')]) {
    const bad = badConfigKey(file);
    if (bad) return `whose config sets \`${bad}\``;
  }
  return null;
}

/** The first key in a repository config file that is not on the allowlist, or null. */
function badConfigKey(file) {
  for (const { key, value } of configKeys(file)) {
    if (REPO_CONFIG_URL.test(key)) {
      if (!isLocalPath(value)) return `${key} to a non-path URL`;
      continue;
    }
    if (!REPO_CONFIG_KEYS.some((re) => re.test(key))) return key;
  }
  return null;
}
const isLocalPath = (v) =>
  isWord(v) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v.replace(/^file:\/\//i, '')) && !/^[^/]+:/.test(v);

/** Why the config git reads under this call is not trusted, or null. Base files must be unchanged. */
function configTrust(env, base) {
  const files = gitConfigFiles(env);
  const baseFiles = base?.configs ?? null;
  for (const file of files) {
    if (baseFiles && Object.hasOwn(baseFiles, file)) {
      let now = null;
      try {
        now = readFileSync(file, 'utf8');
      } catch {}
      if (now !== baseFiles[file]) return `a changed \`${file}\``;
      continue;
    }
    const bad = badConfigKey(file);
    if (bad) return `\`${file}\` which sets \`${bad}\``;
  }
  return null;
}

/** The system and global config files git reads under `env`, in order, that exist. */
export function gitConfigFiles(env) {
  const files = [];
  if (!truthy(env.GIT_CONFIG_NOSYSTEM)) files.push('/etc/gitconfig');
  if (isWord(env.GIT_CONFIG_GLOBAL)) {
    if (env.GIT_CONFIG_GLOBAL !== '/dev/null') files.push(env.GIT_CONFIG_GLOBAL);
  } else {
    const xdg = isWord(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : isWord(env.HOME)
        ? `${env.HOME}/.config`
        : null;
    if (xdg) files.push(`${xdg}/git/config`);
    if (isWord(env.HOME)) files.push(`${env.HOME}/.gitconfig`);
  }
  return files.filter((f) => {
    try {
      return existsSync(f);
    } catch {
      return false;
    }
  });
}
const truthy = (v) => isWord(v) && !/^(0|false|no|)$/i.test(v);

/** Every `section.sub.key=value` a config file holds, includes read as far as three deep. */
function configKeys(file, depth = 0) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const keys = [];
  let section = '';
  for (const line of text.split('\n')) {
    const header = /^\s*\[\s*([^\]\s"]+)(?:\s+"([^"]*)")?\s*\]/.exec(line);
    if (header) {
      const name = header[1].toLowerCase();
      section = header[2] === undefined ? name : `${name}.${header[2]}`;
      continue;
    }
    const entry = /^\s*([A-Za-z][\w-]*)\s*(?:=\s*(.*?)\s*)?$/.exec(line);
    if (!entry || !section) continue;
    const key = `${section}.${entry[1].toLowerCase()}`;
    const value = (entry[2] ?? 'true').replace(/^"(.*)"$/, '$1');
    keys.push({ key, value });
    if (depth < 3 && /^(include|includeif\..+)\.path$/.test(key))
      keys.push(
        ...configKeys(
          resolve(dirname(file), value.replace(/^~(?=\/)/, process.env.HOME ?? '~')),
          depth + 1,
        ),
      );
  }
  return keys;
}

// --- grep ------------------------------------------------------------------------------------------

function grepListing(argv, cwd, refuse) {
  const paths = [];
  let recursive = false;
  let sawPathAfterOptions = false;
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (!isWord(a)) return refuse('grep handed a non-literal argument');
    if (a.startsWith('-') && a !== '-') {
      if (GREP_FLAGS.has(a)) {
        if (/r/.test(a)) recursive = true;
        continue;
      }
      const eq = a.indexOf('=');
      const flag = eq === -1 ? a : a.slice(0, eq);
      if (GREP_VALUED.has(a)) {
        k++;
        continue;
      }
      if (GREP_VALUED_EQ.has(flag) && eq !== -1) continue;
      return refuse(`the grep option \`${a}\` is outside the grammar`);
    }
    // First non-option is the pattern; the rest are paths. Both are listed if a directory.
    if (!sawPathAfterOptions) {
      sawPathAfterOptions = true;
      paths.push(a); // the pattern word may itself name a directory (rare) — placed like a path
    } else paths.push(a);
  }
  const found = [];
  for (const p of paths) {
    if (cwd === null) continue;
    const dir = physical(isAbsolute(p) ? p : `${cwd}/${globBase(p)}`);
    if (dir !== null && isDir(dir)) found.push(at(dir, 'grep'));
  }
  if (recursive && !paths.slice(1).some((p) => isWord(p))) {
    if (cwd === null) return refuse('`grep -r` from a directory the guard cannot resolve');
    found.push(at(cwd, 'grep -r'));
  }
  return found;
}

// --- node ------------------------------------------------------------------------------------------

function nodeListing(argv, cwd, repoRoot, baseEnv, refuse = null) {
  const deny =
    refuse ?? ((why) => [root(`${why}, so counted as listing the repository root`, repoRoot)]);
  const baseArgv = base_execArgvTokens(baseEnv);
  let k = 0;
  for (; k < argv.length; k++) {
    const a = argv[k];
    if (!isWord(a)) return deny('node handed a non-literal argument');
    if (a === '--') {
      k++;
      break;
    }
    if (NODE_CODE.has(a)) {
      k++;
      break;
    } // -e/-p: next word is the code, the rest are argv
    if (NODE_FLAGS.has(a) || a.startsWith('--input-type=')) continue;
    if (NODE_VALUED.has(a)) {
      k++;
      continue;
    }
    if (NODE_PRELOAD.has(a)) {
      const mod = argv[k + 1];
      if (!isWord(mod) || !baseArgv.has(startupModuleKey(mod)))
        return deny('node given a startup module the worker was not started with');
      k++;
      continue;
    }
    if (!a.startsWith('-')) break; // the script
    return deny(`the node option \`${a}\` is outside the grammar`);
  }
  // Everything from here is the script and its arguments: each that names a directory is listed.
  const found = [];
  for (const w of argv.slice(k)) {
    if (!isWord(w) || cwd === null) continue;
    const p = physical(isAbsolute(w) ? w : `${cwd}/${w}`);
    if (p !== null && isDir(p)) found.push(at(p, 'node'));
  }
  return found;
}

/** Startup modules the vitest worker itself carries in its base execArgv (by basename). */
function base_execArgvTokens(baseEnv) {
  const set = new Set();
  const tokens = isWord(baseEnv.__WT_BASE_EXECARGV) ? baseEnv.__WT_BASE_EXECARGV.split('\n') : [];
  for (const t of tokens) set.add(startupModuleKey(t));
  return set;
}
const startupModuleKey = (mod) => basename(String(mod));

/** Whether a path is a directory, following a symlink. `p` is already a realpath from `physical`. */
function isDir(p) {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

// --- --print-grammar -------------------------------------------------------------------------------

/** The whole accepted grammar, from the tables above, as text. */
export function printGrammar() {
  const L = [];
  L.push('whole-tree spawn grammar (ISS-1314). A spawn is admitted only when every rule holds;');
  L.push('anything else is counted as listing the repository root.');
  L.push('');
  L.push(
    `Spawn options (non-fork): ${[...new Set([...ALLOWED_OPTIONS, 'cwd', 'env'])].sort().join(', ')}`,
  );
  L.push(`Spawn options (fork): ${[...FORK_OPTIONS, 'env'].sort().join(', ')}`);
  L.push('argv0, shell, uid, gid and any other option: outside.');
  L.push('');
  L.push('Shell string: only exec/execSync, through /bin/sh when it is dash, plain words matching');
  L.push(`  ${PLAIN_WORD}`);
  L.push('');
  L.push(
    `Programs: ${[...PROGRAMS].join(', ')}. git and grep from ${SYSTEM_DIRS.join(', ')}; node = this Node.`,
  );
  L.push('');
  L.push('PATH and NODE_OPTIONS must equal the worker base. The spawn may not SET a startup');
  L.push(`  variable (${STARTUP_KEYS.join(', ')}, LD_*, DYLD_*, BASH_FUNC_*), nor an editor`);
  L.push(`  (${EDITOR_KEYS.join(', ')}) to anything but true or :, nor for git a program key`);
  L.push(`  (${GIT_PROGRAM_ENV.join(', ')}). Dropping any key is safe.`);
  L.push('');
  L.push('git global options: -C <dir> (repeats), -c core.quotePath=false. Subcommands:');
  for (const [sub, s] of Object.entries(GIT_SUBCOMMANDS)) {
    const flags = s.flags.join(' ') || '—';
    const valued =
      Object.entries(s.valued)
        .map(([f, k]) => `${f}(${k})`)
        .join(' ') || '—';
    L.push(
      `  ${sub.padEnd(16)} flags: ${flags}  valued: ${valued}  operands: ${s.min}..${s.max === Infinity ? '∞' : s.max}`,
    );
  }
  L.push('');
  L.push(`grep flags: ${[...GREP_FLAGS].join(' ')}; valued: -e, --include=, --exclude=.`);
  L.push('');
  L.push(`node options before the script: ${[...NODE_FLAGS].join(' ')};`);
  L.push(
    `  valued: ${[...NODE_VALUED].join(' ')}; startup ${[...NODE_PRELOAD].join(' ')} only with a base module.`,
  );
  L.push('  A worker execArgv holding a startup module is the root.');
  L.push('');
  L.push(
    'Reviewed helper: esbuild under node_modules, argv --service=<v> --ping, no repository frame.',
  );
  return L.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === '--print-grammar') {
  process.stdout.write(`${printGrammar()}\n`);
}
