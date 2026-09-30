// What a program a test spawns lists, read off the argv it was really handed or the shell string it
// runs (ISS-1314). The watch cannot see inside a program that is not Node, so this is a reading of
// what the arguments can make the program list. It fails closed: a word it cannot evaluate, a git
// subcommand or setting it does not know, and a program it does not know each count as listing the
// repository root. A reading of spellings that passed whatever it had not listed failed three times.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** A word the reader cannot evaluate: a substitution, or a variable the environment does not set. */
export const UNKNOWN = Symbol('unevaluable');

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
 * path that does not exist keeps its lexical placement, since nothing can list it; one the kernel
 * cannot resolve for any other reason (a symlink loop, a directory it may not search) is `null`,
 * which every caller counts as the root.
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
 * written and by its realpath, and either reading inside counts. A spelling of the root the
 * kernel resolves — a symlink to it, `/proc/<pid>/cwd/..` — is therefore the root, whatever the
 * string; a directory that cannot be canonicalized is too.
 */
export function withinRoot(root, dir) {
  const dirs = [dir, physical(dir)];
  if (dirs.includes(null)) return true;
  const roots = [...new Set([root, physical(root) ?? root])];
  return dirs.some((d) => roots.some((r) => d === r || d.startsWith(`${r}${sep}`)));
}

/** `base` joined with `word` where the kernel would take it, or null where either is unevaluable. */
function at(base, word) {
  if (base === null || word === UNKNOWN || word === undefined) return null;
  return physical(isAbsolute(word) ? word : `${base}/${word}`);
}

const isWord = (w) => typeof w === 'string';
const isOption = (w) => isWord(w) && w.startsWith('-') && w !== '-';
const lit = (v) => ({ t: 'lit', v });
const closing = (s, quote, from) =>
  s.indexOf(quote, from) === -1 ? s.length : s.indexOf(quote, from);

// --- a shell string, cut into commands -----------------------------------------------------------

/** The index of the `close` matching an opener just before `from`, skipping quoted text. */
function matching(s, from, open, close) {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === "'") i = closing(s, "'", i + 1);
    else if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++;
    } else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return s.length;
}

/** Every command a `$(...)` or backtick inside `text` runs, where nothing else in it runs. */
function substitutionsIn(text, into) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '$' && text[i + 1] === '(' && text[i + 2] !== '(') {
      const end = matching(text, i + 2, '(', ')');
      into.push(...scan(text.slice(i + 2, end)));
      i = end;
    } else if (text[i] === '`') {
      const end = closing(text, '`', i + 1);
      into.push(...scan(text.slice(i + 1, end)));
      i = end;
    }
  }
}

/**
 * One `$` or backtick expansion at `s[i]`: the part it makes, and where reading carries on. A
 * substitution's own commands run first, so they go onto `cmds` ahead of the command holding it.
 */
function expansion(s, i, cmds) {
  if (s[i] === '`') {
    const end = closing(s, '`', i + 1);
    cmds.push(...scan(s.slice(i + 1, end)));
    return [{ t: 'unknown' }, end + 1];
  }
  const next = s[i + 1];
  if (next === '(' && s[i + 2] === '(') return [{ t: 'unknown' }, matching(s, i + 3, '(', ')') + 2];
  if (next === '(') {
    const end = matching(s, i + 2, '(', ')');
    cmds.push(...scan(s.slice(i + 2, end)));
    return [{ t: 'unknown' }, end + 1];
  }
  if (next === '{') {
    const end = matching(s, i + 2, '{', '}');
    const inner = s.slice(i + 2, end);
    substitutionsIn(inner, cmds);
    const plain = /^([A-Za-z_]\w*|\d+|[@*#])$/.exec(inner);
    return [plain ? { t: 'param', name: plain[1] } : { t: 'unknown' }, end + 1];
  }
  if (next === "'") return [{ t: 'unknown' }, closing(s, "'", i + 2) + 1];
  const name = /^([A-Za-z_]\w*|\d|[@*#?$!-])/.exec(s.slice(i + 1));
  if (name) return [{ t: 'param', name: name[1] }, i + 1 + name[1].length];
  return [lit('$'), i + 1];
}

/**
 * A shell string cut into simple commands, each a list of words, each word a list of parts. Quotes,
 * escapes, substitutions, redirections, comments and here-documents are read here; control words
 * are left to the reader of each command. A part the shell sees unquoted is `bare`, since only
 * those take part in pathname and brace expansion, and a command's redirection targets are kept
 * apart on `redirects`, since the shell expands them too.
 */
function scan(src) {
  const s = src.replace(/\\\r?\n/g, '');
  const cmds = [];
  const heredocs = [];
  let words = [];
  let redirects = [];
  let word = null;
  let redirectNext = false;
  const part = (p) => {
    word ??= [];
    word.push(p);
  };
  const bare = (v) => part({ t: 'lit', v, bare: true });
  const endWord = () => {
    if (word && redirectNext) {
      redirects.push(word);
      redirectNext = false;
    } else if (word) words.push(word);
    word = null;
  };
  const endCmd = () => {
    endWord();
    if (words.length > 0 || redirects.length > 0) cmds.push(Object.assign(words, { redirects }));
    words = [];
    redirects = [];
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      part(lit(s[i + 1] ?? ''));
      i += 2;
    } else if (c === "'") {
      const end = closing(s, "'", i + 1);
      part(lit(s.slice(i + 1, end)));
      i = end + 1;
    } else if (c === '"') {
      part(lit(''));
      for (i++; i < s.length && s[i] !== '"'; ) {
        if (s[i] === '\\') {
          part(lit(s[i + 1] ?? ''));
          i += 2;
        } else if (s[i] === '$' || s[i] === '`') {
          const [p, next] = expansion(s, i, cmds);
          part(p);
          i = next;
        } else part(lit(s[i++]));
      }
      i++;
    } else if (c === '$' || c === '`') {
      const [p, next] = expansion(s, i, cmds);
      part({ ...p, bare: true });
      i = next;
    } else if (c === '(' && /^[@+!?*]$/.test(word?.at(-1)?.bare ? word.at(-1).v : '')) {
      // An extglob, `@(a|b)` and its like: one pattern word, not a subshell.
      const end = matching(s, i + 1, '(', ')');
      part({ t: 'lit', v: s.slice(i, end + 1), bare: true, extglob: true });
      i = end + 1;
    } else if (c === '#' && word === null) {
      i = closing(s, '\n', i);
    } else if (c === '\n') {
      endCmd();
      i = hereDocuments(s, i + 1, heredocs.splice(0), cmds);
    } else if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      endWord();
      let j = i + 2;
      const strip = s[j] === '-';
      if (strip) j++;
      while (s[j] === ' ' || s[j] === '\t') j++;
      const m = /^(['"]?)([^\s'";&|<>()]+)\1/.exec(s.slice(j));
      heredocs.push({ delim: m ? m[2] : '', strip, quoted: Boolean(m?.[1]) });
      i = j + (m ? m[0].length : 0);
    } else if (c === '<' || c === '>') {
      if (word?.every((p) => p.t === 'lit' && /^\d*$/.test(p.v))) word = null;
      endWord();
      i++;
      while (s[i] === '<' || s[i] === '>' || s[i] === '|') i++;
      if (s[i] === '&') {
        i++;
        while (/[\d-]/.test(s[i] ?? '')) i++;
      } else redirectNext = true;
    } else if (';&|()'.includes(c)) {
      endCmd();
      i++;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
    } else if (c === '~' && word === null) {
      part({ t: 'tilde' });
      i++;
    } else {
      bare(c);
      i++;
    }
  }
  endCmd();
  return cmds;
}

/** Skips each pending here-document's body, reading the substitutions an unquoted one expands. */
function hereDocuments(s, from, docs, cmds) {
  let i = from;
  for (const doc of docs) {
    let end = i;
    while (end < s.length) {
      const eol = closing(s, '\n', end);
      const line = s.slice(end, eol);
      const next = eol + 1;
      if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) {
        if (!doc.quoted) substitutionsIn(s.slice(i, end), cmds);
        end = next;
        break;
      }
      end = next;
    }
    i = end;
  }
  return i;
}

const GLOB_CHAR = /[*?[]/;
/** A pattern in the text the shell sees unquoted: `*`, `?`, or a bracket with a close. */
const PATTERN = /[*?]|\[[^\]]+\]/;
/** An unquoted brace expansion, `{a,b}` or `{1..3}`, in a word's unquoted text. */
const BRACE = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;

/**
 * One word's values: one string, one UNKNOWN, or the positional parameters `$@` stands for. A word
 * the shell expands as a pathname pattern is a listing the shell makes itself, whatever program
 * the words go to, so each is recorded on `ctx.expansions`; `assigned` marks an assignment's value,
 * which the shell does not expand. A brace expansion, or a glob climbing after a wildcard, makes
 * words nothing here can name, so it is UNKNOWN.
 */
function evaluate(word, ctx, assigned = false) {
  const parts = word.filter((p) => p.t !== 'lit' || p.v !== '');
  if (parts.length === 1 && parts[0].t === 'param' && parts[0].name === '@') {
    if (!parts[0].bare || assigned) return ctx.params;
    return ctx.params.map((v) => (isWord(v) && PATTERN.test(v) ? expanded(v, false, ctx) : v));
  }
  let out = '';
  // The text brace expansion reads, and the text pathname expansion reads: what the shell sees
  // unquoted, each quoted character held by a NUL so it matches nothing.
  let unquoted = '';
  let globbed = '';
  for (const p of word) {
    if (p.t === 'lit') {
      out += p.v;
      const held = p.bare ? p.v : '\0'.repeat(p.v.length);
      unquoted += held;
      globbed += p.extglob ? '*' : held;
    } else if (p.t === 'tilde' && isWord(ctx.vars.HOME)) {
      out += ctx.vars.HOME;
      unquoted += '\0';
      globbed += '\0';
    } else if (p.t === 'param') {
      const v = param(p.name, ctx);
      if (v === UNKNOWN || v.some((x) => !isWord(x))) return [UNKNOWN];
      out += v.join(' ');
      unquoted += '\0';
      globbed += p.bare ? v.join(' ') : '\0';
    } else return [UNKNOWN];
  }
  if (assigned) return [out];
  const glob = PATTERN.test(globbed);
  const brace = BRACE.test(unquoted);
  if (!glob && !brace) return [out];
  return [expanded(out, brace, ctx)];
}

/** The shell's expansion of a pattern word: recorded as a listing, and the word it leaves. */
function expanded(pattern, brace, ctx) {
  const unknown = brace || climbsAfterMagic(pattern);
  ctx.expansions.push({ pattern, unknown });
  return unknown ? UNKNOWN : pattern;
}

function param(name, ctx) {
  if (name === '0') return [ctx.name ?? 'sh'];
  if (/^\d+$/.test(name)) return [ctx.params[Number(name) - 1] ?? ''];
  if (name === '@' || name === '*') return ctx.params;
  if (name === '#') return [String(ctx.params.length)];
  if (/^[A-Za-z_]\w*$/.test(name) && Object.hasOwn(ctx.vars, name)) return [ctx.vars[name]];
  return UNKNOWN;
}

/** A word written `NAME=value` before a command, read before its value is evaluated. */
function assignment(word, ctx) {
  let text = '';
  let k = 0;
  while (k < word.length && word[k].t === 'lit' && !text.includes('=')) text += word[k++].v;
  const m = /^([A-Za-z_]\w*)=/.exec(text);
  if (!m) return null;
  const [value] = evaluate([lit(text.slice(m[0].length)), ...word.slice(k)], ctx, true);
  return { name: m[1], value };
}

/** Words that open or close a compound command and run no program themselves. */
const OPENERS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time']);
const CLOSERS = new Set(['fi', 'done', 'esac', '}', 'in']);
/** Compound commands whose own words run nothing, their substitutions already read. */
const NO_PROGRAM = new Set(['for', 'case', 'select', 'function', '[[', ']]']);
/** Builtins that list nothing and run nothing. */
const INERT = new Set([
  ...['exit', 'return', 'true', 'false', ':', 'local', 'readonly', 'declare', 'typeset', 'unset'],
  ...['read', 'wait', 'trap', 'ulimit', 'umask', 'break', 'continue', 'hash', 'alias', 'unalias'],
  ...['echo', 'printf', 'test', '[', 'type', 'getopts', 'jobs', 'disown', 'let', 'shopt'],
]);

/**
 * Everything a shell string lists, run command by command in the order the shell runs them: a `cd`
 * moves the directory the rest run in, an assignment sets what a later `$NAME` reads, and `shift`
 * and `set --` move the positional parameters. A pattern the shell expands lists the directory it
 * starts from, in the directory the command runs in, before the program sees a word of it.
 */
export function shellListing(text, { cwd, root, env = {}, name, params = [] }) {
  const ctx = { dir: cwd, vars: { ...env }, name, params: [...params], expansions: [] };
  const found = [];
  for (const words of scan(text)) {
    ctx.expansions = [];
    const own = {};
    let k = 0;
    for (; k < words.length; k++) {
      const a = assignment(words[k], ctx);
      if (!a) break;
      own[a.name] = a.value;
    }
    const argv = words.slice(k).flatMap((w) => evaluate(w, ctx));
    for (const w of words.redirects) evaluate(w, ctx);
    for (const { pattern, unknown } of ctx.expansions) {
      const via = `the shell's expansion of \`${pattern}\``;
      found.push(place(unknown ? null : at(ctx.dir, globBase(pattern)), via, root));
    }
    if (argv.length === 0) Object.assign(ctx.vars, own);
    while (argv.length > 0 && OPENERS.has(argv[0])) argv.shift();
    const head = argv[0];
    if (head === undefined || CLOSERS.has(head) || NO_PROGRAM.has(head) || INERT.has(head))
      continue;
    if (head === 'cd' || head === 'pushd') {
      // `cd` is logical: a `..` leaves the symlink it came through, and only then is it resolved.
      const target = argv.slice(1).find((w) => !isOption(w)) ?? ctx.vars.HOME ?? UNKNOWN;
      const glob = !isWord(target) || target === '-' || GLOB_CHAR.test(target);
      ctx.dir = glob || ctx.dir === null ? null : physical(resolve(ctx.dir, target));
    } else if (head === 'popd') ctx.dir = null;
    else if (head === 'shift') ctx.params.splice(0, Number(argv[1] ?? 1) || 1);
    else if (head === 'set') {
      const dash = argv.indexOf('--');
      if (dash !== -1) ctx.params = argv.slice(dash + 1);
    } else if (head === 'export') {
      for (const w of argv.slice(1)) {
        const m = isWord(w) ? /^([A-Za-z_]\w*)=(.*)$/s.exec(w) : null;
        if (m) ctx.vars[m[1]] = m[2];
      }
    } else if (head === 'eval' || head === 'source' || head === '.') {
      found.push(unread(`\`${head}\``, root));
    } else {
      const blind =
        Object.hasOwn(own, 'NODE_OPTIONS') && !`${own.NODE_OPTIONS}`.includes(PRELOAD_MARK);
      found.push(...programListing(argv, ctx.dir, root, { ...ctx.vars, ...own }, blind));
    }
  }
  return found;
}

// --- one program, by its argv --------------------------------------------------------------------

function unread(what, root) {
  return {
    dir: root,
    via: `${what} (a program the guard cannot see into, so counted as listing the root)`,
    unseen: true,
  };
}

function place(dir, via, root) {
  if (dir !== null) return { dir, via };
  return {
    dir: root,
    via: `${via} (at a directory or word the guard cannot evaluate, so counted as the root)`,
  };
}

/** Programs that run Node, which the preload watches from inside. */
const NODE_PROGRAMS = new Set(['node', 'nodejs', 'pnpm', 'npm', 'npx', 'yarn', 'corepack']);
/** Node programs a package manager runs by name: the same preload watches them. */
const NODE_BINS = new Set(['tsx', 'vitest', 'tsc', 'eslint', 'prettier', 'next', 'drizzle-kit']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/**
 * Programs that read the files they are named, run no other program and never list a directory.
 * `ln` is not one: a link it makes reroutes a later listing through it.
 */
const READS_NO_DIRECTORY = new Set([
  ...['echo', 'printf', 'true', 'false', 'test', '[', 'sleep', 'which', 'type', 'seq', 'yes'],
  ...['cat', 'head', 'tail', 'wc', 'uniq', 'tr', 'cut', 'cmp', 'tee', 'base64', 'expr', 'nproc'],
  ...['mkdir', 'rmdir', 'mv', 'touch', 'readlink', 'realpath', 'basename', 'dirname'],
  ...['pwd', 'date', 'id', 'whoami', 'uname', 'hostname', 'kill', 'pkill', 'pgrep', 'ps'],
  ...['sha256sum', 'sha1sum', 'md5sum', 'shasum', 'mktemp', 'stat', 'file', 'getconf'],
]);
/** Programs that list the directories they are handed only when told to recurse. */
const RECURSE_WHEN_TOLD = new Set([
  'grep',
  'egrep',
  'fgrep',
  'cp',
  'rm',
  'chmod',
  'chown',
  'chgrp',
  'diff',
]);
/** Listers: each reads what it is handed, or where it runs when handed nothing. */
const LISTERS = new Set(['ls', 'tree', 'du', 'rg', 'fd', 'fdfind', 'exa', 'eza']);
/**
 * Searchers that take a pattern before their paths: the short letters each takes a value after
 * (`e` and `f` being the pattern), the letters that take none, and the long options of each kind.
 */
const SEARCHERS = {
  grep: {
    values: 'efABCmdD',
    switches: 'abcEFGHhiLlnoPqRrsTUuVvwxyZzI',
    long: [
      '--regexp',
      '--file',
      '--label',
      '--binary-files',
      '--max-count',
      '--context',
      '--directories',
    ],
  },
  rg: {
    values: 'efgtTABCmjMErd',
    switches: 'abcFHhiIlLnNopqsSuUvwxz0P.',
    long: [
      ...['--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--type-add'],
      ...['--threads', '--encoding', '--max-depth', '--sort', '--sortr', '--max-filesize'],
      ...['--ignore-file', '--engine', '--max-count', '--context', '--replace'],
    ],
  },
};
SEARCHERS.egrep = SEARCHERS.grep;
SEARCHERS.fgrep = SEARCHERS.grep;
/** Long options of theirs that take no value. */
const SEARCH_SWITCHES = new Set([
  ...['--files', '--type-list', '--recursive', '--line-number', '--count', '--files-with-matches'],
  ...['--files-without-match', '--ignore-case', '--hidden', '--no-ignore', '--fixed-strings'],
  ...['--word-regexp', '--invert-match', '--null', '--json', '--quiet', '--no-heading', '--follow'],
  ...['--with-filename', '--no-filename', '--multiline', '--only-matching', '--smart-case'],
  ...['--case-sensitive', '--text', '--no-messages', '--extended-regexp', '--perl-regexp'],
]);

/**
 * A searcher's options read one by one: which word after them is the pattern, and whether every
 * option was one it knows. An option it does not know may take the next word as its value.
 */
function searchWords(spec, rest) {
  const words = [];
  let patternGiven = false;
  let understood = true;
  let ended = false;
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k];
    if (ended || !isOption(a) || /^-\d+$/.test(a)) {
      if (!/^-\d+$/.test(a) || ended) words.push(a);
      continue;
    }
    if (a === '--') ended = true;
    else if (a.startsWith('--')) {
      const flag = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      if (['--regexp', '--file', '--files', '--type-list'].includes(flag)) patternGiven = true;
      if (spec.long.includes(flag)) {
        if (!a.includes('=')) k++;
      } else if (!SEARCH_SWITCHES.has(flag)) understood = false;
    } else {
      for (let j = 1; j < a.length; j++) {
        const letter = a[j];
        if (spec.values.includes(letter)) {
          if (letter === 'e' || letter === 'f') patternGiven = true;
          if (j === a.length - 1) k++;
          break;
        }
        if (!spec.switches.includes(letter)) understood = false;
      }
    }
  }
  return { words, patternGiven, understood };
}

/**
 * What a searcher reads: its paths once its pattern and option values are set aside, or where it
 * runs when none remains. Where any option is one it does not know, every word counts as a path and
 * where it runs counts too. `rg --pre` runs a program, which counts as the root.
 */
function searchListing(bin, rest, cwd, root) {
  if (rest.some((a) => isWord(a) && (a === '--pre' || a.startsWith('--pre='))))
    return [unread(`\`${bin} --pre\``, root)];
  const { words, patternGiven, understood } = searchWords(SEARCHERS[bin], rest);
  const paths = understood && !patternGiven ? words.slice(1) : words;
  const dirs = paths.length === 0 || !understood ? [...paths, '.'] : paths;
  return dirs.map((p) => place(at(cwd, isWord(p) ? globBase(p) : p), bin, root));
}

/** Told to recurse: `-r` and its like, or grep's `-d`/`--directories` in any mode but `read` or `skip`. */
const recursive = (args) =>
  args.some((a, k) => {
    if (!isWord(a)) return false;
    if (/^-[a-zA-Z]*[rRa]/.test(a)) return true;
    if (['--recursive', '--archive', '--dereference-recursive'].includes(a)) return true;
    const mode = a === '-d' ? args[k + 1] : /^(-d|--directories=)(.*)$/.exec(a)?.[2];
    return mode !== undefined && !['read', 'skip'].includes(mode);
  });

/** Each launcher, and the options it takes a separate value after. */
const LAUNCHERS = {
  env: ['-u', '--unset', '-C', '--chdir'],
  xargs: ['-n', '-L', '-P', '-d', '-a', '-E', '-s', '-I', '--max-args', '--max-procs'],
  command: [],
  exec: ['-a'],
  nice: ['-n', '--adjustment'],
  nohup: [],
  time: ['-f', '-o', '--format', '--output'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  stdbuf: ['-i', '-o', '-e'],
  sudo: ['-u', '-g', '-C', '-h', '-p', '-U', '-r', '-t'],
  setsid: [],
};

/**
 * What one argv lists, given the directory it runs in (null where that could not be evaluated), as
 * `{ dir, via, unseen? }`. `blind` marks a Node process started where the preload was stripped.
 */
export function programListing(argv, cwd, root, env = {}, blind = false) {
  const [head] = argv;
  // An unread program keeps the executable it was, so the watch can tell a tool's own helper.
  return listingOf(argv, cwd, root, env, blind).map((e) =>
    e.unseen && e.program === undefined ? { ...e, program: isWord(head) ? head : '' } : e,
  );
}

/** Where the system's own programs and the installed packages' live: a name found there is read by it. */
const TRUSTED_PLACE =
  /^\/(usr\/(local\/)?)?s?bin\/|^\/usr\/(lib|libexec)\/|^\/opt\/homebrew\/|\/node_modules\//;

/** The executable a program name runs: a path where it is one, or the first on the call's PATH. */
function executable(head, cwd, env) {
  if (head.includes('/')) return cwd === null && !isAbsolute(head) ? null : at(cwd, head);
  if (!isWord(env.PATH)) return null;
  for (const dir of env.PATH.split(':')) {
    const candidate = join(dir || '.', head);
    if (existsSync(candidate))
      return physical(isAbsolute(candidate) ? candidate : `${cwd}/${candidate}`);
  }
  return null;
}

/**
 * Whether a Node program's executable is Node, which the preload watches: the binary beside the
 * one running this, or a script whose first line runs node. A script named `node` that runs
 * anything else is a program nobody has read.
 */
function runsNode(path) {
  if (dirname(path) === dirname(physical(process.execPath))) return true;
  try {
    const first = readFileSync(path, 'utf8').slice(0, 200).split('\n')[0];
    return /^#!.*\bnode\b/.test(first);
  } catch {
    return false;
  }
}

function listingOf(argv, cwd, root, env, blind) {
  const [head, ...rest] = argv;
  if (head === undefined) return [];
  if (!isWord(head)) return [unread('a program named by a substitution', root)];
  const bin = basename(head);
  // A program is read by its name only where the name is the system's: a `cat` the test put first
  // on PATH, or named by a path of its own, is a program nobody has read.
  const runs = executable(head, cwd, env);
  const node = NODE_PROGRAMS.has(bin) || NODE_BINS.has(bin);
  if (runs !== null && !TRUSTED_PLACE.test(runs) && !(node && runsNode(runs)))
    return [unread(`\`${head}\` at ${runs}, which the test's own PATH or path chose`, root)];
  if (bin === 'git') return gitListing(rest, cwd, root, env);
  if (SHELLS.has(bin)) return shellProgram(bin, rest, cwd, root, env);
  if (Object.hasOwn(LAUNCHERS, bin)) return launched(bin, rest, cwd, root, env, blind);
  if (NODE_PROGRAMS.has(bin) || NODE_BINS.has(bin)) {
    if (blind) return [unread(`\`${bin}\` started without the preload`, root)];
    return jsRunner(bin, rest, cwd, root, env);
  }
  if (bin === 'find') return findListing(rest, cwd, root, env);
  const recurses = RECURSE_WHEN_TOLD.has(bin) && recursive(rest);
  if (Object.hasOwn(SEARCHERS, bin) && (bin === 'rg' || recurses))
    return searchListing(bin, rest, cwd, root);
  if (LISTERS.has(bin) || recurses) {
    const paths = rest.filter((a) => !isOption(a));
    const dirs = paths.length > 0 ? paths : ['.'];
    return dirs.map((p) => place(at(cwd, isWord(p) ? globBase(p) : p), bin, root));
  }
  if (bin === 'sort' && !rest.some((a) => isWord(a) && a.startsWith('--compress-program')))
    return [];
  if (READS_NO_DIRECTORY.has(bin) || RECURSE_WHEN_TOLD.has(bin)) return [];
  return [unread(`\`${head.length > 60 ? `…${head.slice(-59)}` : head}\``, root)];
}

/**
 * What a spawn lists: a shell string when the call runs one, and otherwise its argv. `env` is the
 * environment the program runs under, which is where a shell reads a `$NAME` nobody assigned.
 */
export function subprocessListing({ command, args = [], shell = false, cwd, root, env = {} }) {
  if (shell) return shellListing([command, ...args].join(' '), { cwd, root, env });
  return programListing([String(command), ...args.map(String)], cwd, root, env);
}

/** A package manager's `exec`/`dlx`/`x`, and `npx`, run the program named after them. */
function jsRunner(bin, rest, cwd, root, env) {
  const words = rest.filter((a) => !isOption(a));
  let inner = null;
  if (bin === 'npx') inner = words;
  else if (['pnpm', 'yarn', 'npm'].includes(bin) && ['exec', 'dlx', 'x'].includes(words[0]))
    inner = words.slice(1);
  if (!inner || inner.length === 0) return [];
  const name = isWord(inner[0]) ? basename(inner[0]) : null;
  if (name !== null && (NODE_BINS.has(name) || NODE_PROGRAMS.has(name))) return [];
  return programListing(inner, cwd, root, env);
}

function launched(bin, rest, cwd, root, env, blind) {
  const takesValue = LAUNCHERS[bin];
  const own = { ...env };
  let dir = cwd;
  let stripped = blind;
  let i = 0;
  for (; i < rest.length && isWord(rest[i]); i++) {
    const a = rest[i];
    if (bin === 'env' && /^[A-Za-z_]\w*=/.test(a)) {
      const key = a.slice(0, a.indexOf('='));
      own[key] = a.slice(a.indexOf('=') + 1);
      if (key === 'NODE_OPTIONS' && !own[key].includes(PRELOAD_MARK)) stripped = true;
      continue;
    }
    if (!isOption(a)) break;
    if (a === '--') {
      i++;
      break;
    }
    if (bin === 'env' && ['-i', '--ignore-environment'].includes(a)) stripped = true;
    if (bin === 'env' && (a === '-S' || a.startsWith('--split-string')))
      return [unread('`env -S`', root)];
    const eq = a.indexOf('=');
    const flag = eq === -1 ? a : a.slice(0, eq);
    const value = eq === -1 ? (takesValue.includes(flag) ? rest[++i] : undefined) : a.slice(eq + 1);
    if (bin === 'env' && ['-u', '--unset'].includes(flag) && value === 'NODE_OPTIONS')
      stripped = true;
    if (bin === 'env' && ['-C', '--chdir'].includes(flag)) dir = at(dir, value);
  }
  if (bin === 'env' && rest[i] === '-') {
    stripped = true;
    i++;
  }
  if (bin === 'timeout' && i < rest.length) i++;
  if (bin === 'command' && rest.some((a) => a === '-v' || a === '-V')) return [];
  const inner = rest.slice(i);
  if (inner.length === 0) return [];
  // `xargs` hands its command the words it reads from stdin, which nothing here can evaluate.
  return programListing(bin === 'xargs' ? [...inner, UNKNOWN] : inner, dir, root, own, stripped);
}

/** A shell: a `-c` string is read command by command, and a script file cannot be seen into. */
function shellProgram(bin, rest, cwd, root, env) {
  let i = 0;
  let command = false;
  for (; i < rest.length && isWord(rest[i]) && /^[-+]./.test(rest[i]); i++) {
    const a = rest[i];
    if (a === '--') {
      i++;
      break;
    }
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) command = true;
    if (['-o', '+o', '-O', '+O', '--rcfile', '--init-file'].includes(a)) i++;
  }
  const operands = rest.slice(i);
  if (!command) {
    const script = isWord(operands[0]) ? operands[0] : 'its standard input';
    return [unread(`\`${bin}\` running ${script}`, root)];
  }
  const [text, name, ...params] = operands;
  if (!isWord(text)) return [unread(`\`${bin} -c\` handed a string it cannot evaluate`, root)];
  return shellListing(text, { cwd, root, env, name, params });
}

/** `find`'s starting points, and the program an `-exec` runs, each read where it runs. */
function findListing(rest, cwd, root, env) {
  let i = 0;
  while (i < rest.length && isWord(rest[i]) && /^(-[HLP]|-O\d*|-D|--)$/.test(rest[i]))
    i += rest[i] === '-D' ? 2 : 1;
  const tail = rest.slice(i);
  const stop = tail.findIndex((a) => isWord(a) && /^[-(!]/.test(a));
  const starts = tail.slice(0, stop === -1 ? tail.length : stop);
  const found = (starts.length > 0 ? starts : ['.']).map((p) => place(at(cwd, p), 'find', root));
  for (let k = 0; k < tail.length; k++) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(tail[k])) continue;
    const end = tail.findIndex((a, j) => j > k && (a === ';' || a === '+'));
    const run = tail
      .slice(k + 1, end === -1 ? tail.length : end)
      .map((a) => (a === '{}' ? UNKNOWN : a));
    found.push(...programListing(run, tail[k].endsWith('dir') ? null : cwd, root, env));
  }
  return found;
}

// --- git -----------------------------------------------------------------------------------------

/**
 * Subcommands shown to print nothing of a tree's paths or content and to change no work tree: a
 * ref, an id, a message, a named file. Every subcommand not named in this section counts as the
 * root, so the list is what has been read, never what has not.
 */
const GIT_NO_LISTING = new Set([
  ...['rev-parse', 'init', 'symbolic-ref', 'update-ref', 'show-ref', 'for-each-ref', 'var'],
  ...['hash-object', 'commit-tree', 'mktree', 'mktag', 'merge-base', 'branch', 'tag', 'describe'],
  ...['version', 'help', 'notes', 'name-rev', 'cherry', 'shortlog', 'check-ref-format', 'blame'],
  ...['ls-remote', 'merge-file', 'check-ignore', 'check-attr', 'stripspace', 'interpret-trailers'],
  ...['mailinfo', 'mailsplit', 'patch-id', 'count-objects', 'gc'],
  ...['prune', 'maintenance', 'repack', 'verify-pack', 'index-pack', 'unpack-objects', 'replace'],
  ...['update-server-info', 'receive-pack', 'send-pack', 'fast-import'],
]);
/** Subcommands listing from where git runs, narrowed by pathspecs, mapped to value-taking flags. */
const GIT_FROM_HERE = {
  'ls-files': [
    '-x',
    '-X',
    '--exclude',
    '--exclude-from',
    '--exclude-per-directory',
    '--with-tree',
    '--format',
  ],
  'ls-tree': ['--format'],
  grep: ['-e', '-f', '-A', '-B', '-C', '-m', '--max-depth', '--threads', '--max-count'],
  clean: ['-e', '--exclude'],
  rm: [],
  add: [],
};
/** Subcommands that read or change the work tree, unless handed pathspecs after `--`. */
const GIT_WORK_TREE = new Set([
  ...['status', 'diff', 'diff-files', 'diff-index', 'stash', 'checkout', 'switch', 'restore'],
  ...['reset', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'apply', 'commit', 'read-tree'],
  ...['write-tree', 'update-index', 'mv', 'worktree', 'pull'],
]);
/** Subcommands that print the paths or content of the repository's trees, narrowed after `--`. */
const GIT_TREE_READERS = new Set([
  'diff-tree',
  'whatchanged',
  'format-patch',
  'range-diff',
  'fsck',
]);
/** Subcommands that copy the repository's objects whole, which no pathspec narrows. */
const GIT_STORE_COPIERS = new Set(['fast-export', 'bundle', 'pack-objects', 'push', 'archive']);
/**
 * Options that select, order or format commits and print no path and no content, for `log`,
 * `reflog`, `rev-list` and a quiet `show`; the second set take a value, `=`-joined or as the next
 * word. Anything else — a patch, a stat, `--name-only`, `-S`, `-G`, `-L`, `--objects` — counts.
 */
const COMMIT_ONLY = new Set([
  ...['--oneline', '--abbrev-commit', '--no-abbrev-commit', '--decorate', '--no-decorate'],
  ...['--reverse', '--first-parent', '--merges', '--no-merges', '--all', '--branches', '--tags'],
  ...['--remotes', '--topo-order', '--date-order', '--author-date-order', '--ancestry-path'],
  ...['--no-walk', '--do-walk', '--graph', '--parents', '--children', '--left-right', '--boundary'],
  ...['--cherry-pick', '--cherry-mark', '--cherry', '--left-only', '--right-only', '--not'],
  ...['--simplify-by-decoration', '--full-history', '--dense', '--sparse', '--simplify-merges'],
  ...['--show-pulls', '--no-color', '--color', '-z', '--null', '--count', '-i', '-E', '-F', '-P'],
  ...['--regexp-ignore-case', '--extended-regexp', '--fixed-strings', '--basic-regexp'],
  ...['--perl-regexp', '--all-match', '--invert-grep', '--use-mailmap', '--mailmap'],
  ...['--no-mailmap', '--quiet', '--header', '--timestamp', '--source', '--no-notes'],
  ...['--relative-date', '--walk-reflogs', '-g', '--expand-tabs', '--no-expand-tabs', '-s'],
  ...['--no-patch', '--in-commit-order', '--single-worktree'],
]);
const COMMIT_ONLY_VALUED = new Set([
  ...['-n', '--max-count', '--skip', '--since', '--after', '--until', '--before', '--max-age'],
  ...['--min-age', '--author', '--committer', '--grep', '--grep-reflog', '--format', '--pretty'],
  ...['--date', '--abbrev', '--encoding', '--glob', '--exclude', '--min-parents', '--max-parents'],
  ...['--decorate-refs', '--decorate-refs-exclude', '--since-as-filter', '--notes'],
]);
/** Long options of those that are only ever `=`-joined, so the next word is never their value. */
const JOINED_ONLY = new Set(['--format', '--pretty', '--abbrev', '--notes', '--decorate']);
/** `-c` settings that change what git prints or records and never run a program. */
const SAFE_CONFIG =
  /^(user|author|committer|init|advice|color|column|i18n|log|safe|format|pull|merge|rebase|fetch|transfer|gc|receive|pack|protocol|http)\.[\w.-]+=|^core\.(autocrlf|safecrlf|quotepath|filemode|ignorecase|precomposeunicode|longpaths|abbrev|logallrefupdates|bare|compression|symlinks)=|^uploadpack\.(allow\w+|hiderefs)=|^(commit|tag)\.gpgsign=(false|no|off|0)$/i;
/** Keys under those sections that do run a program, or copy a directory. */
const UNSAFE_CONFIG = /^(merge\..+\.driver|init\.templatedir)=/i;
const safeConfig = (setting) => SAFE_CONFIG.test(setting) && !UNSAFE_CONFIG.test(setting);
/** Variables under which git runs a program of the caller's choosing for any subcommand. */
const GIT_PROGRAM_ENV = ['GIT_EXTERNAL_DIFF'];
/** Variables naming the program a transport other than a local path runs. */
const GIT_TRANSPORT_ENV = ['GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_PROXY_COMMAND'];
/** An editor that runs nothing: what git sets for its own hooks, and what a test sets to mean none. */
const NO_EDITOR = /^(true|:|)$/;

/**
 * Settings under which git runs a program the repository names, each by the kind of work that
 * runs it, and the subcommands doing that work. A test that writes a fixture's `.git/config` or
 * hooks decides these without a word of the argv naming them.
 */
const PROGRAM_SETTINGS = [
  [/^core\.fsmonitor$/i, 'fsmonitor'],
  [/^core\.hookspath$/i, 'hooks'],
  [/^(core\.sshcommand|core\.gitproxy|credential\.(.+\.)?helper)$/i, 'transport'],
  [/^(diff\.external|diff\..+\.(textconv|command))$/i, 'diff'],
  [/^filter\..+\.(clean|smudge|process)$/i, 'filter'],
  [/^merge\..+\.driver$/i, 'merge'],
  [/^(commit|tag)\.gpgsign$/i, 'signing'],
];
const WORK_SUBS = [
  ...['status', 'diff', 'add', 'commit', 'checkout', 'switch', 'reset', 'stash', 'ls-files'],
  ...['update-index', 'restore', 'rm', 'mv', 'clean', 'grep', 'merge', 'rebase', 'pull'],
  ...['cherry-pick', 'revert', 'am', 'apply', 'worktree', 'hash-object'],
];
const RUNS = {
  fsmonitor: new Set(WORK_SUBS),
  filter: new Set([...WORK_SUBS, 'cat-file', 'archive']),
  hooks: new Set([
    ...['commit', 'merge', 'rebase', 'am', 'push', 'checkout', 'switch', 'pull', 'cherry-pick'],
    ...['revert', 'gc', 'worktree', 'receive-pack'],
  ]),
  merge: new Set(['merge', 'rebase', 'cherry-pick', 'revert', 'am', 'pull', 'stash', 'checkout']),
  diff: new Set([
    ...['diff', 'log', 'show', 'diff-tree', 'diff-files', 'diff-index', 'format-patch', 'blame'],
    ...['grep', 'cat-file', 'whatchanged', 'range-diff', 'stash', 'reflog'],
  ]),
  signing: new Set(['commit', 'tag', 'merge', 'rebase', 'cherry-pick', 'revert', 'am']),
};

/**
 * Every setting a config file holds, as lower-cased `section.sub.key` names, with the files its
 * `include.path` and `includeIf.*.path` name read too, as far as three deep. A file that cannot be
 * read holds nothing, as git reads a missing include.
 */
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
      // Section and key names are case-blind to git; a subsection, the remote's name, is not.
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

/**
 * The programs the repository git runs in is set to run, by kind: from its config (and a config
 * file the environment names), and from a hook in its hooks directory. The user's own global
 * config is not read: docs/proposals/a-test-reading-a-named-file-outside-its-package-is-not-selected-by-it.md.
 */
function configuredPrograms(dir, gitDir, env) {
  const g = dir === null ? null : gitDir === undefined ? gitDirOf(dir) : at(dir, gitDir);
  const files = [g === null ? null : join(g, 'config')];
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'])
    if (isWord(env[key]) && env[key] !== '/dev/null') files.push(at(dir ?? '/', env[key]));
  const found = [];
  for (const file of files.filter(Boolean)) {
    for (const { key, value } of configKeys(file)) {
      const kind = PROGRAM_SETTINGS.find(([re]) => re.test(key))?.[1];
      if (kind === 'signing' && /^(false|no|off|0)$/i.test(value)) continue;
      if (kind) found.push({ kind, what: `the setting ${key}` });
    }
  }
  // Probed by name rather than listed: a listing here would be one more the watch records.
  const hook = g === null ? undefined : GIT_HOOKS.find((h) => existsSync(join(g, 'hooks', h)));
  if (hook !== undefined) found.push({ kind: 'hooks', what: `the hook ${hook}` });
  return found;
}

/** Every hook git runs, by the name it looks for in the hooks directory. */
const GIT_HOOKS = [
  ...['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit'],
  ...['prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout'],
  ...['post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive'],
  ...['post-update', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite'],
  ...['sendemail-validate', 'fsmonitor-watchman', 'post-index-change', 'p4-pre-submit'],
];

/** Whether a call opens an editor: a message it was not handed, or an edit it asked for. */
function opensEditor(sub, tail) {
  const has = (re) => tail.some((a) => isWord(a) && re.test(a));
  const message = has(/^(--(message|file|reuse-message|no-edit|fixup)|-[a-zA-Z]*[mFC])/);
  if (sub === 'commit') return !message;
  if (sub === 'tag') return has(/^(-[a-zA-Z]*[asu]|--(annotate|sign|local-user))/) && !message;
  if (sub === 'merge' || sub === 'cherry-pick') return has(/^(-e|--edit)$/);
  if (sub === 'revert') return !has(/^(--no-edit|-n|--no-commit)$/);
  if (sub === 'rebase') return has(/^(-i|--interactive|--edit-todo)$/);
  if (sub === 'notes') return ['add', 'edit', 'append'].includes(tail[0]) && !message;
  if (sub === 'replace') return has(/^--edit$/);
  if (sub === 'am') return has(/^(-i|--interactive)$/);
  return false;
}

/** Whether a call signs or verifies with gpg: asked for on the command line. */
function asksToSign(sub, tail) {
  if (sub === 'verify-commit' || sub === 'verify-tag') return true;
  const has = (re) => tail.some((a) => isWord(a) && re.test(a));
  if (sub === 'tag') return has(/^(-[a-zA-Z]*[suv]|--(sign|local-user|verify))/);
  if (sub === 'log' || sub === 'show') return has(/^--show-signature$/);
  return RUNS.signing.has(sub) && has(/^(-S|--gpg-sign|--verify-signatures)/);
}

/**
 * The program git will run for this call without the argv naming it: a hook, a driver, an editor,
 * a signer or a transport command, from the environment or the repository's own config.
 */
function programRun(sub, tail, entries, dir, gitDir, env) {
  const editorEnv = ['GIT_EDITOR', 'GIT_SEQUENCE_EDITOR'].find(
    (k) => isWord(env[k]) && !NO_EDITOR.test(env[k]),
  );
  const editing = opensEditor(sub, tail);
  if (editing && (editorEnv || !isWord(env.GIT_EDITOR)))
    return editorEnv ?? 'the editor git starts for its message';
  if (asksToSign(sub, tail)) return 'the gpg program it signs with';
  const printsContent =
    entries.length > 0 ||
    sub === 'blame' ||
    tail.some((a) => /^--(textconv|filters|ext-diff)$/.test(a));
  for (const { kind, what } of configuredPrograms(dir, gitDir, env)) {
    if (kind === 'diff' ? RUNS.diff.has(sub) && printsContent : RUNS[kind]?.has(sub)) return what;
  }
  return null;
}

const NETWORK_SUBS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote', 'remote']);

/**
 * The transport program a call reaching another host runs: an ssh or proxy command the
 * environment or the repository's config names. A local path runs none.
 */
function remoteTransport(sub, tail, dir, gitDir, env) {
  if (!NETWORK_SUBS.has(sub)) return null;
  const named =
    GIT_TRANSPORT_ENV.find((k) => isWord(env[k]) && env[k] !== '') ??
    configuredPrograms(dir, gitDir, env).find((p) => p.kind === 'transport')?.what;
  if (named === undefined) return null;
  const words = tail.filter((a) => !isOption(a));
  const word = sub === 'remote' ? words.at(-1) : (words[0] ?? 'origin');
  const url =
    isWord(word) && !word.includes('/') && !word.includes(':') && dir !== null
      ? remoteUrls(dir, gitDir)?.[word]
      : word;
  if (url !== undefined && localRepository(url, dir, '/') !== undefined) return null;
  return named;
}

/**
 * The settings the environment hands git, as `key=value`: `GIT_CONFIG_PARAMETERS`, which git sets
 * for its own children under `-c`, and `GIT_CONFIG_KEY_<n>`. An exec path outside git's own
 * `git-core` directory runs subcommands of the caller's choosing, so it reads as a setting no list
 * holds.
 */
function envConfig(env) {
  const found = [];
  const params = env.GIT_CONFIG_PARAMETERS;
  if (isWord(params)) {
    for (const m of params.matchAll(/'((?:[^']|'\\'')*)'(?:=('(?:[^']|'\\'')*'))?/g))
      found.push(`${m[1]}=${(m[2] ?? '').slice(1, -1)}`);
  }
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  for (let n = 0; n < count; n++)
    found.push(`${env[`GIT_CONFIG_KEY_${n}`] ?? ''}=${env[`GIT_CONFIG_VALUE_${n}`] ?? ''}`);
  if (isWord(env.GIT_EXEC_PATH) && !/\/git-core\/?$/.test(env.GIT_EXEC_PATH))
    found.push(`GIT_EXEC_PATH ${env.GIT_EXEC_PATH}`);
  return found;
}

/** `init` and `clone` copy a template directory they are handed into the new repository. */
function templateListing(tail, dir, via, root) {
  const k = tail.findIndex((a) => isWord(a) && /^--template(=|$)/.test(a));
  if (k === -1) return [];
  const value = tail[k].includes('=') ? tail[k].slice(tail[k].indexOf('=') + 1) : tail[k + 1];
  return [place(at(dir, value), `${via} --template`, root)];
}

/** Settings naming a repository that a later fetch reads from. */
const REPOSITORY_CONFIG = /^(remote\..+\.(url|pushurl)|url\..+\.(insteadof|pushinsteadof))$/i;

/**
 * A subcommand's words once its options are read: the non-option words before `--` (revisions,
 * objects, paths), the words after it, and whether every option is one that prints no path and no
 * content.
 */
function commitWords(tail) {
  const words = [];
  let understood = true;
  const dash = tail.indexOf('--');
  const before = dash === -1 ? tail : tail.slice(0, dash);
  for (let k = 0; k < before.length; k++) {
    const a = before[k];
    if (!isWord(a)) words.push(a);
    else if (!isOption(a)) words.push(a);
    else if (/^-\d+$/.test(a) || /^-n\d+$/.test(a)) continue;
    else {
      const flag = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      if (COMMIT_ONLY_VALUED.has(flag)) {
        if (!a.includes('=') && !JOINED_ONLY.has(flag)) k++;
      } else if (!COMMIT_ONLY.has(flag)) understood = false;
    }
  }
  return { words, specs: dash === -1 ? [] : tail.slice(dash + 1), understood };
}

/** The repository a path names — a work tree, its `.git`, or its object directory — as its top. */
function repositoryAt(dir, path, root) {
  let p = at(dir, path);
  if (p === null) return null;
  if (basename(p) === 'objects') p = dirname(p);
  if (basename(p) === '.git') p = dirname(p);
  return topOf(p, root);
}

/** A repository argument on this machine — a path, or a `file://` URL — as its top, else undefined. */
function localRepository(word, dir, root) {
  if (!isWord(word)) return null;
  if (/^file:\/\//i.test(word)) return repositoryAt(dir, word.replace(/^file:\/\//i, ''), root);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(word) || /^[^/]+:/.test(word)) return undefined;
  return repositoryAt(dir, word, root);
}

/** The `.git` directory holding the config git reads where it runs, found upwards from `dir`. */
function gitDirOf(dir) {
  for (let d = dir; ; d = dirname(d)) {
    const candidate = join(d, '.git');
    if (existsSync(candidate)) {
      try {
        const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(candidate, 'utf8'));
        const worktreeDir = pointer ? resolve(d, pointer[1].trim()) : null;
        if (worktreeDir === null) return candidate;
        const common = join(worktreeDir, 'commondir');
        return existsSync(common)
          ? resolve(worktreeDir, readFileSync(common, 'utf8').trim())
          : worktreeDir;
      } catch {
        return candidate;
      }
    }
    if (dirname(d) === d) return null;
  }
}

/** Each remote's URL, from the config of the repository git runs in; null where there is none. */
function remoteUrls(dir, gitDir) {
  const g = gitDir === undefined ? gitDirOf(dir) : at(dir, gitDir);
  if (g === null || !existsSync(join(g, 'config'))) return null;
  const urls = {};
  for (const { key, value } of configKeys(join(g, 'config'))) {
    const m = /^remote\.(.+)\.url$/.exec(key);
    if (m) urls[m[1]] = value;
  }
  return urls;
}

/** What fetching from `word` lists: the repository it names, where that is on this machine. */
function sourceListing(word, all, dir, gitDir, root, via, byName = true) {
  const named = byName && isWord(word) && !word.includes('/') && !word.includes(':');
  if (dir === null || all || (named && !existsSync(at(dir, word)))) {
    const urls = dir === null ? null : remoteUrls(dir, gitDir);
    const wanted = all ? Object.values(urls ?? {}) : [urls?.[word]];
    if (urls === null || wanted.includes(undefined))
      return [place(null, `${via} from a remote whose URL the guard cannot read`, root)];
    return wanted.flatMap((url) => sourceListing(url, false, dir, gitDir, root, via, false));
  }
  const top = localRepository(word, dir, root);
  return top === undefined ? [] : [place(top, via, root)];
}

/** What one git call lists, from the directory it runs in and every option that moves that. */
function gitListing(rest, cwd, root, env) {
  let dir = cwd;
  let workTree = env.GIT_WORK_TREE === undefined ? undefined : at(cwd, env.GIT_WORK_TREE);
  let gitDir = env.GIT_DIR;
  let i = 0;
  const optionValue = (a) => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : rest[++i]);
  for (; i < rest.length && isOption(rest[i]); i++) {
    const a = rest[i];
    if (a === '-C') dir = at(dir, rest[++i]);
    else if (a === '-c' || a.startsWith('--config-env')) {
      const setting = a === '-c' ? rest[++i] : optionValue(a);
      const probe = isWord(setting) && a !== '-c' ? setting.replace(/=.*/s, '=') : setting;
      if (!isWord(probe) || !safeConfig(probe))
        return [unread(`\`git ${a} ${isWord(setting) ? setting : '…'}\``, root)];
    } else if (a.startsWith('--git-dir')) gitDir = optionValue(a);
    else if (a.startsWith('--work-tree')) workTree = at(dir, optionValue(a));
    else if (/^--(namespace|super-prefix|exec-path|attr-source)$/.test(a)) i++;
  }
  const sub = rest[i];
  if (sub === undefined) return [];
  if (!isWord(sub)) return [unread('`git` running a subcommand named by a substitution', root)];
  const tail = rest.slice(i + 1);
  // The work tree git reads, and the repository whose objects it reads: one place, unless a git
  // directory or an object directory was named apart from where it runs.
  let top = topOf(dir, root);
  if (gitDir !== undefined) top = dir;
  if (workTree !== undefined) top = workTree;
  const stores = [gitDir === undefined ? topOf(dir, root) : repositoryAt(dir, gitDir, root)];
  for (const key of ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
    if (!isWord(env[key])) continue;
    for (const path of env[key].split(':').filter(Boolean))
      stores.push(repositoryAt(dir, path, root));
  }
  const via = `git ${sub}`;
  const programEnv = GIT_PROGRAM_ENV.find((key) => isWord(env[key]) && env[key] !== '');
  if (programEnv) return [unread(`\`${via}\` under ${programEnv}`, root)];
  const configEnv = envConfig(env).find((setting) => !safeConfig(setting));
  if (configEnv !== undefined) return [unread(`\`${via}\` under a setting ${configEnv}`, root)];
  const entries = gitReading({ sub, tail, dir, top, stores, gitDir, root, via });
  const program = programRun(sub, tail, entries, dir, gitDir, env);
  if (program !== null) return [unread(`\`${via}\` running ${program}`, root)];
  const transport = remoteTransport(sub, tail, dir, gitDir, env);
  if (transport !== null) return [unread(`\`${via}\` over ${transport}`, root)];
  return entries;
}

/** What one git subcommand reads, once where it runs and whose objects it reads are known. */
function gitReading({ sub, tail, dir, top, stores, gitDir, root, via }) {
  const inStore = () => inRepository(stores, via, root);
  const narrowed = (specs, base) =>
    specs.length === 0 ? base : specs.flatMap((s) => pathspecDir(s, dir, top, via, root));
  if (tail.some((a) => isWord(a) && /^--(upload-pack|receive-pack|exec)\b/.test(a)))
    return [unread(`\`${via}\` handed a program to run`, root)];
  if (sub === 'verify-commit' || sub === 'verify-tag') return [];
  if (GIT_NO_LISTING.has(sub)) return templateListing(tail, dir, via, root);
  if (sub === 'config') return configListing(tail, dir, root);
  if (sub === 'reflog' && ['expire', 'delete', 'exists'].includes(tail[0])) return [];
  if (sub === 'log' || sub === 'reflog' || sub === 'rev-list') {
    // A path limits the history walk only by reading that path in every tree it walks.
    const { words, specs, understood } = commitWords(sub === 'reflog' ? reflogTail(tail) : tail);
    const onDisk = words.filter((w) => isWord(w) && dir !== null && existsSync(`${dir}/${w}`));
    const paths = [...specs, ...onDisk];
    if (understood) return paths.flatMap((s) => pathspecDir(s, dir, top, via, root));
    return sub === 'rev-list' ? inStore() : narrowed(paths, inStore());
  }
  if (sub === 'show') return showListing(tail, dir, top, stores, root);
  if (sub === 'cat-file') return catFileListing(tail, dir, stores, root);
  if (sub === 'clone' || sub === 'fetch' || sub === 'pull' || sub === 'remote') {
    const reads = repositoryReads(sub, tail, dir, gitDir, root);
    const merged = sub === 'pull' ? [place(top, via, root)] : [];
    return [...reads, ...merged, ...templateListing(tail, dir, via, root)];
  }
  if (GIT_TREE_READERS.has(sub)) return narrowed(commitWords(tail).specs, inStore());
  if (GIT_STORE_COPIERS.has(sub)) {
    if (sub === 'archive' && tail.some((a) => isWord(a) && a.startsWith('--remote')))
      return [unread('`git archive --remote`', root)];
    return inStore();
  }
  if (tail.some((a) => isWord(a) && a.startsWith('--pathspec-from-file')))
    return [unread(`\`${via} --pathspec-from-file\``, root)];
  if (Object.hasOwn(GIT_FROM_HERE, sub)) {
    // A git directory named apart from the work tree has no prefix here to narrow by.
    if (gitDir !== undefined && !stores.includes(top)) return inStore();
    const specs = gitPathspecs(sub, tail, GIT_FROM_HERE[sub], dir);
    const base = sub === 'ls-tree' && tail.includes('--full-tree') ? top : dir;
    if (specs.length > 0) return specs.flatMap((s) => pathspecDir(s, base, top, via, root));
    if (sub !== 'add') return [place(base, via, root)];
    const all = tail.some((a) => ['-A', '--all', '-u', '--update'].includes(a));
    return all ? [place(top, via, root)] : [];
  }
  if (GIT_WORK_TREE.has(sub)) {
    const dash = tail.indexOf('--');
    const specs = dash === -1 ? [] : tail.slice(dash + 1);
    const whole = [...new Set([top, ...stores])].map((d) => place(d, via, root));
    return narrowed(specs, whole);
  }
  return [unread(`\`${via}\``, root)];
}

/** `git reflog show` takes log's options; its other subcommands print no path. */
function reflogTail(tail) {
  return tail[0] === 'show' ? tail.slice(1) : tail;
}

/**
 * `git config`: reading a value lists nothing; setting one that names a repository counts that
 * repository, and setting one outside the settings that run no program counts as the root.
 */
function configListing(tail, dir, root) {
  const words = tail.filter((a) => !isOption(a));
  const reading = tail.some(
    (a) => isWord(a) && /^(--get|--list|-l|--get-all|--get-regexp)/.test(a),
  );
  if (reading || words.length < 2) return [];
  const [key, value] = words;
  if (!isWord(key)) return [unread('`git config` setting a key named by a substitution', root)];
  if (REPOSITORY_CONFIG.test(key)) {
    const top = localRepository(value, dir, root);
    return top === undefined ? [] : [place(top, `git config ${key}`, root)];
  }
  if (safeConfig(`${key}=${isWord(value) ? value : ''}`)) return [];
  return [unread(`\`git config ${key}\``, root)];
}

/**
 * `git show`: an object `REV:path` is that path, `REV:` the repository's top, and a `^{…}` peel the
 * top; a commit is shown with its patch, which reads the repository, unless `-s` or `--no-patch`
 * with options that print no path and no content.
 */
function showListing(tail, dir, top, stores, root) {
  const { words, specs, understood } = commitWords(tail);
  const quiet = understood && tail.some((a) => a === '-s' || a === '--no-patch');
  const found = [];
  let commits = words.length === 0;
  for (const w of words) {
    if (isWord(w) && w.includes(':') && !w.includes('^{'))
      found.push(objectPlace(w, dir, stores[0], 'git show', root));
    else if (!isWord(w) || w.includes('^{')) found.push(...inRepository(stores, 'git show', root));
    else commits = true;
  }
  if (commits && !quiet) {
    const whole = inRepository(stores, 'git show', root);
    const narrow = specs.flatMap((s) => pathspecDir(s, dir, top, 'git show', root));
    found.push(...(specs.length === 0 ? whole : narrow));
  }
  return found;
}

/** A listing of the whole repository whose objects git reads, once per store. */
function inRepository(stores, via, root) {
  return [...new Set(stores)].map((s) => place(s, via, root));
}

/** `git cat-file`: `-t`, `-s` and `-e` print no content; every other form reads each object. */
function catFileListing(tail, dir, stores, root) {
  if (tail.some((a) => isWord(a) && a.startsWith('--batch')))
    return inRepository(stores, 'git cat-file --batch', root);
  if (tail.some((a) => a === '-t' || a === '-s' || a === '-e')) return [];
  const objects = tail.filter((a) => !isOption(a));
  if (isWord(objects[0]) && /^(blob|tree|commit|tag)$/.test(objects[0])) objects.shift();
  return objects.flatMap((o) =>
    isWord(o) && o.includes(':') && !o.includes('^{')
      ? [objectPlace(o, dir, stores[0], 'git cat-file', root)]
      : inRepository(stores, 'git cat-file', root),
  );
}

/** An object named `REV:path`: `path` from the top, or from where git runs when it opens `./`. */
function objectPlace(object, dir, top, via, root) {
  const path = object.slice(object.indexOf(':') + 1);
  if (top === null || (dir === null && /^\.\.?(\/|$)/.test(path))) return place(null, via, root);
  const from = /^\.\.?(\/|$)/.test(path) ? dir : top;
  return place(path === '' ? top : at(from, path), `${via} ${object}`, root);
}

/**
 * The repositories `clone`, `fetch`, `pull` and `remote add`/`set-url` read or register: each
 * one on this machine counts as its top, a named remote by the URL its config holds.
 */
function repositoryReads(sub, tail, dir, gitDir, root) {
  const valued = ['-b', '--branch', '-o', '--origin', '--depth', '-j', '--jobs', '-c', '--config'];
  const words = [];
  const found = [];
  for (let k = 0; k < tail.length; k++) {
    const a = tail[k];
    if (!isOption(a)) words.push(a);
    else if (/^--reference(-if-able)?/.test(a)) {
      const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : tail[++k];
      const top = localRepository(value, dir, root);
      if (top !== undefined) found.push(place(top, `git ${sub} --reference`, root));
    } else if (!a.includes('=') && [...valued, '--separate-git-dir', '--filter'].includes(a)) k++;
  }
  const via = `git ${sub}`;
  if (sub === 'remote') {
    if (!['add', 'set-url'].includes(words[0])) return found;
    const top = localRepository(words.at(-1), dir, root);
    return top === undefined ? found : [...found, place(top, `git remote ${words[0]}`, root)];
  }
  if (sub === 'clone') {
    if (tail.includes('-u')) return [unread('`git clone -u`', root)];
    const top = localRepository(words[0], dir, root);
    return top === undefined ? found : [...found, place(top, via, root)];
  }
  const all = tail.some((a) => a === '--all' || a === '--multiple');
  return [...found, ...sourceListing(words[0] ?? 'origin', all, dir, gitDir, root, via)];
}

/** The work tree a directory inside this repository belongs to: the root, as far as this reads. */
function topOf(dir, root) {
  if (dir === null) return null;
  return withinRoot(root, dir) ? root : dir;
}

/**
 * A git subcommand's pathspecs: every word after its options and their values, less `ls-tree`'s
 * tree-ish and `grep`'s pattern. Before a `--`, a word `grep` or `ls-tree` is handed that names
 * nothing on disk is a revision and not a path, so it narrows nothing.
 */
function gitPathspecs(sub, tail, takesValue, dir) {
  const words = [];
  let afterDash = false;
  let patternGiven = false;
  for (let k = 0; k < tail.length; k++) {
    const a = tail[k];
    if (afterDash || !isOption(a)) words.push({ word: a, afterDash });
    else if (a === '--') afterDash = true;
    else {
      const flag = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      if (['-e', '-f', '--regexp', '--file'].includes(flag)) patternGiven = true;
      if (!a.includes('=') && takesValue.includes(flag)) k++;
    }
  }
  const first = words.findIndex((w) => !w.afterDash);
  const skipFirst = sub === 'ls-tree' || (sub === 'grep' && !patternGiven);
  const revisions = sub === 'ls-tree' || sub === 'grep';
  return words
    .filter((_w, k) => !(skipFirst && k === first))
    .filter(
      ({ word, afterDash: after }) =>
        after ||
        !revisions ||
        !isWord(word) ||
        word.startsWith(':') ||
        dir === null ||
        existsSync(`${dir}/${globBase(word)}`),
    )
    .map((w) => w.word);
}

/** Where one pathspec starts listing, its `:/` and `:(top)` magic read and its exclusions dropped. */
function pathspecDir(spec, base, top, via, root) {
  if (!isWord(spec)) return [place(null, via, root)];
  let s = spec;
  let from = base;
  if (s.startsWith(':')) {
    const m = /^:(?:\(([^)]*)\)|([/!^]*))(.*)$/s.exec(s);
    const magic = m[1] === undefined ? [...(m[2] ?? '')] : m[1].split(',');
    if (magic.some((x) => ['!', '^', 'exclude'].includes(x))) return [];
    if (magic.some((x) => x === '/' || x === 'top')) from = top;
    s = m[3];
  }
  if (from === null || climbsAfterMagic(s)) return [place(null, via, root)];
  // git normalises a pathspec's `..` itself, before any symlink is read, and the kernel reads the
  // symlinks: both readings are where it may list, so each is placed.
  const path = isAbsolute(s) ? globBase(s) : `${from}/${globBase(s || '.')}`;
  const readings = [...new Set([physical(path), resolve(path)])];
  return readings.map((dir) => place(dir, via, root));
}
