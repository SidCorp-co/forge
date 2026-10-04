// What a `git` subprocess a test spawns would read: the subcommand grammar, the pathspecs and
// repository operands it names, and whether the repo and config it runs under can be trusted.

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { GIT_SUBCOMMANDS, GIT_TREE_READERS } from './whole-tree-git-grammar.mjs';
import {
  at,
  climbsAfterMagic,
  globBase,
  isDir,
  isWord,
  physical,
  root,
  short,
  withinRoot,
} from './whole-tree-paths.mjs';

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

// --- git -------------------------------------------------------------------------------------------

export function gitListing(argv, cwd, repoRoot, env, base, refuse) {
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
