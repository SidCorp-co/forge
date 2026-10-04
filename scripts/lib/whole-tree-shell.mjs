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

import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { gitListing } from './whole-tree-git.mjs';
import { GIT_SUBCOMMANDS } from './whole-tree-git-grammar.mjs';
import { at, globBase, isDir, isWord, physical, root, short } from './whole-tree-paths.mjs';

/** The file every watched Node process preloads; a NODE_OPTIONS still naming it keeps the watch. */
export const PRELOAD_MARK = 'whole-tree-child.mjs';

// --- the grammar, as data --------------------------------------------------------------------------

/** Spawn options a call may carry. Anything else — argv0, shell, uid, gid — puts it outside. */
const ALLOWED_OPTIONS = new Set([
  ...['cwd', 'env', 'encoding', 'stdio', 'input', 'timeout', 'maxBuffer', 'killSignal'],
  ...['windowsHide', 'signal', 'detached'],
]);
/** Options only a `fork` may add. */
const FORK_OPTIONS = new Set(['execPath', 'execArgv', 'silent', 'serialization', 'cwd', 'stdio']);

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
/** An editor value that runs nothing: git's own `true`/`:` for a non-interactive commit. */
const NO_EDITOR = /^(true|:)$/;

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
