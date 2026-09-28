import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DECLARATION_VALUES = ['whole-tree'];

/** A declaration line: `@gate-input <value>`, opening a `//` comment or a line of a block comment. */
const DECLARATION_RE = /^[ \t]*(?:\/\/|\/\*\*?|\*)[ \t]*@gate-input\b[ \t]*([^\s*]*)/gm;

export const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;

export const SOURCE_FILE_RE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|rs)$/;

/** The `node:fs` calls that list a directory, which is what makes a read a walk. */
export const FS_LISTING_CALLS = [
  'readdir',
  'readdirSync',
  'opendir',
  'opendirSync',
  'glob',
  'globSync',
];

/** Every declaration the source carries, in order, with the 1-based line each sits on. */
export function declarationsIn(source) {
  const found = [];
  for (const m of source.matchAll(DECLARATION_RE)) {
    const line = source.slice(0, m.index).split('\n').length;
    found.push({ value: m[1], line });
  }
  return found;
}

/** True when the source carries a valid whole-tree declaration. */
export function declaresWholeTree(source) {
  return declarationsIn(source).some((d) => DECLARATION_VALUES.includes(d.value));
}

/** True when listing `dir` covers `root`: the root itself or any directory above it. */
export function coversRoot(root, dir) {
  if (dir === root) return true;
  const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  return root.startsWith(prefix);
}

function toPath(value, cwd) {
  if (typeof value === 'string') return resolve(cwd, value);
  if (value instanceof URL)
    return value.protocol === 'file:' ? resolve(fileURLToPath(value)) : null;
  if (Buffer.isBuffer(value)) return resolve(cwd, value.toString());
  return null;
}

/** The directory a glob pattern starts listing from: its segments before the first magic one. */
function globBase(pattern) {
  const kept = [];
  for (const seg of pattern.split(/[\\/]/)) {
    if (/[*?[\]{}()!+@]/.test(seg)) break;
    kept.push(seg);
  }
  return kept.join('/') || '.';
}

/**
 * The absolute directories one `node:fs` listing call lists, read off the arguments it was really
 * called with: whatever spelling built the path, this is where it landed.
 */
export function fsListing(name, args, cwd) {
  if (name === 'glob' || name === 'globSync') {
    const opts = args[1] && typeof args[1] === 'object' ? args[1] : {};
    const base = toPath(opts.cwd ?? '.', cwd) ?? cwd;
    const patterns = [].concat(args[0]).filter((p) => typeof p === 'string');
    return patterns.map((p) => (isAbsolute(p) ? resolve(globBase(p)) : resolve(base, globBase(p))));
  }
  const dir = toPath(args[0], cwd);
  return dir ? [dir] : [];
}

/** A shell string cut into simple commands, each an argv, quotes dropped. Rough by design. */
function shellCommands(text) {
  return text
    .split(/&&|\|\||[;|\n]/)
    .map((part) =>
      (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^['"]|['"]$/g, '')),
    )
    .filter((argv) => argv.length > 0);
}

const positionals = (argv) => argv.filter((a) => !a.startsWith('-'));

/** Programs whose own listings the watch sees from inside, since each runs Node with the preload. */
const NODE_PROGRAMS = new Set(['node', 'pnpm', 'npm', 'npx', 'yarn', 'corepack', 'tsx', 'vitest']);

/** Programs that read the files they are named and never a directory's entries. */
const READS_NO_DIRECTORY = new Set([
  ...['echo', 'printf', 'true', 'false', 'test', '[', 'sleep', 'which', 'type'],
  ...['cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'tr', 'cut', 'sed', 'awk', 'diff', 'cmp'],
  ...['grep', 'mkdir', 'rm', 'rmdir', 'cp', 'mv', 'touch', 'chmod', 'ln', 'readlink', 'realpath'],
  ...['basename', 'dirname', 'pwd', 'date', 'id', 'whoami', 'uname', 'kill', 'tee'],
]);

/** Programs that run the command after their own options, which is then what is read. */
const LAUNCHERS = new Set([
  'env',
  'xargs',
  'command',
  'exec',
  'nice',
  'nohup',
  'time',
  'timeout',
  'stdbuf',
  'sudo',
]);

/** A launcher's command: its argv after options, assignments and a `timeout` duration. */
function launched(bin, rest) {
  let i = 0;
  while (i < rest.length && (rest[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[i])))
    i++;
  if (bin === 'timeout' && i < rest.length) i++;
  return rest.slice(i);
}

/** `find`'s starting points: after its leading `-H`/`-L`/`-P`/`-O<n>`/`-D <opts>`/`--`, up to
 * the first predicate. */
function findStarts(rest) {
  let i = 0;
  while (i < rest.length && /^(-[HLP]|-O\d*|-D|--)$/.test(rest[i])) i += rest[i] === '-D' ? 2 : 1;
  const tail = rest.slice(i);
  const stop = tail.findIndex((a) => /^[-(!]/.test(a));
  return tail.slice(0, stop === -1 ? tail.length : stop);
}

/**
 * What one argv lists, given the directory it runs in, as `{ dir, via }`. A program that is not a
 * known lister, not Node, and not one of the readers above cannot be seen into, and may walk from
 * anywhere, so it counts as listing the root: the guard fails closed on what it cannot read.
 */
function argvListing(argv, cwd, root) {
  const bin = basename(argv[0] ?? '');
  const rest = argv.slice(1);
  const at = (via, paths) =>
    (paths.length > 0 ? paths : ['.']).map((p) => ({ dir: resolve(cwd, p), via }));
  if (bin === 'git') {
    let dir = cwd;
    let i = 0;
    while (i < rest.length && rest[i].startsWith('-')) {
      if (rest[i] === '-C') dir = resolve(dir, rest[++i] ?? '.');
      else if (rest[i] === '-c') i++;
      i++;
    }
    const sub = rest[i];
    if (!['ls-files', 'ls-tree', 'grep'].includes(sub)) return [];
    const tail = rest.slice(i + 1);
    const top = tail.some(
      (a) => a === '--full-tree' || a.startsWith(':/') || a.startsWith(':(top)'),
    );
    return [{ dir: top ? root : dir, via: `git ${sub}` }];
  }
  if (['find', 'ls', 'tree', 'du'].includes(bin)) {
    return at(bin, bin === 'find' ? findStarts(rest) : positionals(rest));
  }
  if (LAUNCHERS.has(bin)) {
    const inner = launched(bin, rest);
    return inner.length > 0 ? argvListing(inner, cwd, root) : [];
  }
  const recursiveGrep =
    bin === 'grep' && rest.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive');
  if (bin === 'rg' || bin === 'fd' || recursiveGrep) {
    const pos = positionals(rest);
    return at(bin, bin === 'rg' && rest.includes('--files') ? pos : pos.slice(1));
  }
  if (NODE_PROGRAMS.has(bin) || READS_NO_DIRECTORY.has(bin) || bin === 'cd' || bin === '')
    return [];
  if (!reachesRoot(argv, cwd, root)) return [];
  return [
    {
      dir: root,
      via: `\`${argv[0].slice(0, 60)}\` (a program the guard cannot see into, so counted as listing the root)`,
      unseen: true,
    },
  ];
}

/** A `..` segment anywhere in a text: a path somebody meant to climb with. */
const CLIMB_RE = /(^|[\\/'"`\s=(])\.\.([\\/'"`\s)]|$)/;

/**
 * Whether a program the watch cannot see into may reach the root: it runs at or above it, or
 * anything it is handed (a script file's text included) resolves there, climbs with `..`, or
 * names the root.
 */
function reachesRoot(rest, cwd, root) {
  if (coversRoot(root, cwd)) return true;
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(`${escaped}(?![\\\\/]?[\\w.-])`);
  const reaches = (text) => CLIMB_RE.test(text) || named.test(text);
  return rest.some((arg) => {
    if (reaches(arg) || coversRoot(root, resolve(cwd, arg))) return true;
    const text = scriptText(resolve(cwd, arg));
    return text !== null && reaches(text);
  });
}

function scriptText(path) {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size < 262_144 ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * The directories a child process lists, as `{ dir, via }`: `git ls-files`/`ls-tree`/`grep`,
 * `find`, `ls`, `tree`, `du`, `rg`, `fd` and a recursive `grep` by their arguments, and any other
 * program `argvListing` cannot see into as the root, whether run directly or through a shell
 * string, where a `cd` moves the directory the rest run in.
 */
export function subprocessListing({ command, args = [], shell = false, cwd, root }) {
  const viaShell =
    shell
      ? [command, ...args].join(' ')
      : ['sh', 'bash', 'zsh'].includes(basename(command)) && args[0] === '-c'
        ? args[1]
        : null;
  if (viaShell === null) return argvListing([command, ...args], cwd, root);
  const found = [];
  let dir = cwd;
  for (const argv of shellCommands(String(viaShell))) {
    if (argv[0] === 'cd') dir = resolve(dir, argv[1] ?? root);
    else found.push(...argvListing(argv, dir, root));
  }
  return found;
}

/**
 * What a test's run owes when it listed a directory covering the repository root: nothing when its
 * source declares a whole-tree input, and otherwise a refusal naming the file, each listing, where
 * it was called from, and the line to add. `hits` are `{ dir, via, at }`, `dir` absolute.
 */
export function guardVerdict({ file, source, hits, root }) {
  const covering = hits.filter((h) => coversRoot(root, h.dir));
  if (covering.length === 0 || declaresWholeTree(source)) return null;
  const shown = covering.slice(0, 3).map((h) => {
    const where = h.dir === root ? 'the repository root' : `${h.dir}, above the repository root`;
    return `${h.via} listed ${where}${h.at ? ` (called at ${h.at})` : ''}`;
  });
  const more = covering.length > 3 ? `, and ${covering.length - 3} more` : '';
  return (
    `whole-tree-gates: ${file} ${shown.join('; ')}${more}, so its input is the whole tree and not ` +
    'the paths its job is selected by, and a change outside them skips it — add a line ' +
    '`// @gate-input whole-tree` (or ` * @gate-input whole-tree` in its opening docblock) so it runs on every change'
  );
}

/** Which of `[{ path, source }]` declare a whole-tree input, and each refused, with its remedy. */
export function judgeDeclarations({ files }) {
  const declared = [];
  const refused = [];
  let tests = 0;
  for (const { path, source } of files) {
    const isTest = TEST_FILE_RE.test(path);
    if (isTest) tests++;
    const found = declarationsIn(source);
    if (found.length === 0) continue;
    const bad = found.filter((d) => !DECLARATION_VALUES.includes(d.value));
    if (bad.length > 0) {
      for (const d of bad) {
        refused.push({
          path,
          why: `line ${d.line} declares \`@gate-input ${d.value || '(nothing)'}\`, and the only valid shape is \`@gate-input ${DECLARATION_VALUES.join(' | ')}\``,
        });
      }
      continue;
    }
    if (!isTest) {
      refused.push({
        path,
        why: `line ${found[0].line} declares a whole-tree input in a file that is not a JavaScript test file, which no vitest configuration can run — move the test into a \`*.test.*\` file`,
      });
      continue;
    }
    declared.push(path);
  }
  return { tests, declared: declared.sort(), refused };
}

export const GUARD_PATH = 'scripts/lib/whole-tree-guard.mjs';

/** Every vitest config has to install the guard: `setupFiles` is the absolute `test.setupFiles`
 * vitest itself resolved, and a config it could not load (`error`) is refused, not trusted. */
export function judgeConfigs(configs, root) {
  const guard = resolve(root, GUARD_PATH);
  const refused = [];
  for (const { path, setupFiles, error } of configs) {
    const expected = relative(dirname(path), GUARD_PATH);
    if (error) {
      refused.push({
        path,
        why: `could not be loaded by vitest, so whether it installs the guard is unknown: ${error}`,
      });
    } else if (!setupFiles.includes(guard)) {
      refused.push({
        path,
        why: `does not install the guard that refuses an undeclared root walk — add '${expected}' to its \`test.setupFiles\``,
      });
    }
  }
  return refused;
}

/** The colour codes vitest writes into a message, built from ESC so no control character is typed. */
const ANSI_COLOUR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * vitest's message for a suite that failed before any case ran, kept whole enough to name the
 * error: a header ending in a colon (`Transform failed with 1 error:`) carries on to the lines it
 * introduces, so the refusal never ends on the colon.
 */
export function suiteMessage(message) {
  const lines = String(message ?? '')
    .replace(ANSI_COLOUR_RE, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const kept = [];
  for (const line of lines) {
    kept.push(line);
    if (!line.endsWith(':') || kept.length >= 4) break;
  }
  return kept.join(' ') || null;
}

/**
 * What a run of the declared files proves: every one collected by some configuration, and every
 * one executing at least one case. `collected` maps a configuration to the declared files it
 * collects; `executed` maps a file to the number of cases that passed or failed in it;
 * `suiteErrors` maps a file whose suite failed with no case passing or failing (an import that
 * does not resolve, a throw at load, a hook that throws) to vitest's message for it.
 */
export function judgeRun({ declared, collected, executed, suiteErrors = {} }) {
  const reached = new Set(Object.values(collected).flat());
  const refused = [];
  for (const path of declared) {
    if (!reached.has(path)) {
      refused.push({
        path,
        why: 'no vitest configuration collects it, so declaring it runs nothing — bring it into a config’s include list',
      });
    } else if (path in suiteErrors && !(executed[path] > 0)) {
      refused.push({
        path,
        why: `failed before any of its cases ran: ${suiteErrors[path]} — fix what it imports, evaluates at load or throws in a hook; the declaration stays`,
      });
    } else if (!(executed[path] > 0)) {
      refused.push({
        path,
        why: 'the run executed no case in it, so a green here would assert nothing — un-skip it or drop the declaration',
      });
    }
  }
  return { refused };
}

/** The declarations half's exit: 1 on a refusal, 2 on an empty scope, 0 otherwise. */
export function declarationExit({ declared, refused }) {
  if (refused.length > 0) return 1;
  return declared.length === 0 ? 2 : 0;
}
