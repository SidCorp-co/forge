// What a program a test spawns lists, read off the argv it was really handed or the shell string it
// runs (ISS-1314). The watch cannot see inside a program that is not Node, so this is a reading of
// what the arguments can make the program list. It fails closed: a word it cannot evaluate, a git
// subcommand or setting it does not know, and a program it does not know each count as listing the
// repository root. A reading of spellings that passed whatever it had not listed failed three times.

import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve, sep } from 'node:path';

/** A word the reader cannot evaluate: a substitution, or a variable the environment does not set. */
export const UNKNOWN = Symbol('unevaluable');

/** The file every watched Node process preloads; a NODE_OPTIONS still naming it keeps the watch. */
export const PRELOAD_MARK = 'whole-tree-child.mjs';

/** The directory a glob pattern starts listing from: its segments before the first magic one. */
export function globBase(pattern) {
  const kept = [];
  for (const seg of pattern.split(/[\\/]/)) {
    if (/[*?[\]{}()!+@]/.test(seg)) break;
    kept.push(seg);
  }
  const base = kept.join('/');
  if (base) return base;
  return pattern.startsWith('/') ? '/' : '.';
}

/** `base` joined with `word`, or null where either cannot be evaluated. */
function at(base, word) {
  if (base === null || word === UNKNOWN || word === undefined) return null;
  return resolve(base, word);
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
 * are left to the reader of each command.
 */
function scan(src) {
  const s = src.replace(/\\\r?\n/g, '');
  const cmds = [];
  const heredocs = [];
  let words = [];
  let word = null;
  let dropNext = false;
  const part = (p) => {
    word ??= [];
    word.push(p);
  };
  const endWord = () => {
    if (word && dropNext) dropNext = false;
    else if (word) words.push(word);
    word = null;
  };
  const endCmd = () => {
    endWord();
    if (words.length > 0) cmds.push(words);
    words = [];
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
      part(p);
      i = next;
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
      } else dropNext = true;
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
      part(lit(c));
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

/** One word's values: one string, one UNKNOWN, or the positional parameters `$@` stands for. */
function evaluate(word, ctx) {
  const parts = word.filter((p) => p.t !== 'lit' || p.v !== '');
  if (parts.length === 1 && parts[0].t === 'param' && parts[0].name === '@') return ctx.params;
  let out = '';
  for (const p of word) {
    if (p.t === 'lit') out += p.v;
    else if (p.t === 'tilde' && isWord(ctx.vars.HOME)) out += ctx.vars.HOME;
    else if (p.t === 'param') {
      const v = param(p.name, ctx);
      if (v === UNKNOWN || v.some((x) => !isWord(x))) return [UNKNOWN];
      out += v.join(' ');
    } else return [UNKNOWN];
  }
  return [out];
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
  const [value] = evaluate([lit(text.slice(m[0].length)), ...word.slice(k)], ctx);
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
  ...['echo', 'printf', 'test', '[', 'type', 'getopts', 'jobs', 'disown', 'let'],
]);

/**
 * Everything a shell string lists, run command by command in the order the shell runs them: a `cd`
 * moves the directory the rest run in, an assignment sets what a later `$NAME` reads, and `shift`
 * and `set --` move the positional parameters.
 */
export function shellListing(text, { cwd, root, env = {}, name, params = [] }) {
  const ctx = { dir: cwd, vars: { ...env }, name, params: [...params] };
  const found = [];
  for (const words of scan(text)) {
    const own = {};
    let k = 0;
    for (; k < words.length; k++) {
      const a = assignment(words[k], ctx);
      if (!a) break;
      own[a.name] = a.value;
    }
    const argv = words.slice(k).flatMap((w) => evaluate(w, ctx));
    if (argv.length === 0) Object.assign(ctx.vars, own);
    while (argv.length > 0 && OPENERS.has(argv[0])) argv.shift();
    const head = argv[0];
    if (head === undefined || CLOSERS.has(head) || NO_PROGRAM.has(head) || INERT.has(head))
      continue;
    if (head === 'cd' || head === 'pushd') {
      const target = argv.slice(1).find((w) => !isOption(w)) ?? ctx.vars.HOME ?? UNKNOWN;
      const glob = isWord(target) && (target === '-' || /[*?[]/.test(target));
      ctx.dir = glob ? null : at(ctx.dir, target);
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

/** Programs that read the files they are named, run no other program and never list a directory. */
const READS_NO_DIRECTORY = new Set([
  ...['echo', 'printf', 'true', 'false', 'test', '[', 'sleep', 'which', 'type', 'seq', 'yes'],
  ...['cat', 'head', 'tail', 'wc', 'uniq', 'tr', 'cut', 'cmp', 'tee', 'base64', 'expr', 'nproc'],
  ...['mkdir', 'rmdir', 'mv', 'touch', 'ln', 'readlink', 'realpath', 'basename', 'dirname'],
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
    long: ['--regexp', '--file', '--label', '--binary-files', '--max-count', '--context'],
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

const recursive = (args) =>
  args.some(
    (a) => isWord(a) && (/^-[a-zA-Z]*[rRa]/.test(a) || ['--recursive', '--archive'].includes(a)),
  );

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

function listingOf(argv, cwd, root, env, blind) {
  const [head, ...rest] = argv;
  if (head === undefined) return [];
  if (!isWord(head)) return [unread('a program named by a substitution', root)];
  const bin = basename(head);
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

/** Subcommands that never enumerate the work tree, the index or a tree's paths. */
const GIT_NO_LISTING = new Set([
  ...['rev-parse', 'config', 'init', 'clone', 'fetch', 'push', 'pull', 'remote', 'symbolic-ref'],
  ...['update-ref', 'show-ref', 'for-each-ref', 'cat-file', 'hash-object', 'commit-tree', 'mktree'],
  ...['mktag', 'rev-list', 'merge-base', 'branch', 'tag', 'log', 'show', 'describe', 'var'],
  ...['version', 'help', 'reflog', 'notes', 'worktree', 'checkout', 'switch', 'restore', 'reset'],
  ...['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'apply', 'format-patch', 'gc'],
  ...['fsck', 'count-objects', 'verify-pack', 'pack-objects', 'unpack-objects', 'bundle'],
  ...['ls-remote', 'check-ref-format', 'name-rev', 'shortlog', 'blame', 'cherry', 'read-tree'],
  ...['write-tree', 'update-index', 'diff-tree', 'range-diff', 'maintenance', 'prune', 'repack'],
  ...['check-ignore', 'check-attr', 'mv', 'fast-import', 'fast-export', 'index-pack', 'replace'],
  ...['update-server-info', 'upload-pack', 'receive-pack', 'send-pack', 'fetch-pack'],
  ...['stripspace', 'interpret-trailers', 'mailinfo', 'mailsplit', 'patch-id', 'verify-commit'],
  'verify-tag',
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
/** Subcommands that list the whole work tree unless handed pathspecs after `--`. */
const GIT_WHOLE = new Set(['status', 'diff', 'diff-files', 'diff-index', 'stash', 'archive']);
/** `-c` settings that change what git prints or records and never run a program. */
const SAFE_CONFIG =
  /^(user|author|committer|init|advice|color|column|i18n|log|safe|format|pull|merge|rebase|fetch|transfer|gc|receive|pack|protocol|http)\.[\w.-]+=|^core\.(autocrlf|safecrlf|quotepath|filemode|ignorecase|precomposeunicode|longpaths|abbrev|logallrefupdates|bare|compression|symlinks)=|^(commit|tag)\.gpgsign=/i;

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
      if (!isWord(probe) || !SAFE_CONFIG.test(probe))
        return [unread(`\`git ${a} ${isWord(setting) ? setting : '…'}\``, root)];
    } else if (a.startsWith('--git-dir')) gitDir = optionValue(a);
    else if (a.startsWith('--work-tree')) workTree = at(dir, optionValue(a));
    else if (/^--(namespace|super-prefix|exec-path|attr-source)$/.test(a)) i++;
  }
  const sub = rest[i];
  if (sub === undefined) return [];
  if (!isWord(sub)) return [unread('`git` running a subcommand named by a substitution', root)];
  const tail = rest.slice(i + 1);
  let top = topOf(dir, root);
  if (gitDir !== undefined) top = dir;
  if (workTree !== undefined) top = workTree;
  const via = `git ${sub}`;
  if (GIT_NO_LISTING.has(sub)) {
    const all = tail.some((a) => isWord(a) && (a === '--all' || /^-[a-zA-Z]*a/.test(a)));
    return sub === 'commit' && all ? [place(top, 'git commit -a', root)] : [];
  }
  if (tail.some((a) => isWord(a) && a.startsWith('--pathspec-from-file')))
    return [unread(`\`${via} --pathspec-from-file\``, root)];
  if (Object.hasOwn(GIT_FROM_HERE, sub)) {
    const specs = gitPathspecs(sub, tail, GIT_FROM_HERE[sub], dir);
    const base = sub === 'ls-tree' && tail.includes('--full-tree') ? top : dir;
    if (specs.length > 0) return specs.flatMap((s) => pathspecDir(s, base, top, via, root));
    if (sub !== 'add') return [place(base, via, root)];
    const all = tail.some((a) => ['-A', '--all', '-u', '--update'].includes(a));
    return all ? [place(top, via, root)] : [];
  }
  if (GIT_WHOLE.has(sub)) {
    const dash = tail.indexOf('--');
    const specs = dash === -1 ? [] : tail.slice(dash + 1);
    if (specs.length === 0) return [place(top, via, root)];
    return specs.flatMap((s) => pathspecDir(s, dir, top, via, root));
  }
  return [unread(`\`${via}\``, root)];
}

/** The work tree a directory inside this repository belongs to: the root, as far as this reads. */
function topOf(dir, root) {
  if (dir === null) return null;
  return dir === root || dir.startsWith(`${root}${sep}`) ? root : dir;
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
        existsSync(resolve(dir, globBase(word))),
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
  if (from === null) return [place(null, via, root)];
  return [
    place(isAbsolute(s) ? resolve(globBase(s)) : resolve(from, globBase(s || '.')), via, root),
  ];
}
