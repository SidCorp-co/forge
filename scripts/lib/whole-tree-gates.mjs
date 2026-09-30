import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { types } from 'node:util';
import { climbsAfterMagic, globBase, physical } from './whole-tree-shell.mjs';

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
  'cp',
  'cpSync',
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

/** Node takes a URL by its shape, so one built in another realm (a jsdom file's `URL`) is one. */
const isUrl = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.href === 'string' &&
  typeof value.protocol === 'string';

/** The path Node reads off a path argument, or `null` where Node would take none. */
export function pathOf(value) {
  if (typeof value === 'string') return value;
  if (isUrl(value)) return value.protocol === 'file:' ? fileURLToPath(value.href) : null;
  if (types.isUint8Array(value)) return Buffer.from(value).toString();
  return null;
}

/** Where the kernel takes a path argument: the directory a listing of it really lists. */
function toPath(value, cwd) {
  const path = pathOf(value);
  if (path === null) return null;
  return physical(isAbsolute(path) ? path : `${cwd}/${path}`);
}

/** A spawn's directory, off its `cwd` as Node reads it: none is `from`, and one not a path throws. */
export function spawnCwd(cwd, from) {
  if (cwd === undefined || cwd === null || cwd === '') return from;
  const path = pathOf(cwd);
  if (path === null) throw new TypeError(`a spawn cwd the guard cannot place: ${String(cwd)}`);
  return resolve(from, path);
}

/** The directories one `node:fs` listing call lists, placed where the kernel resolves them. An
 * argument that is no path, and a glob climbing after a wildcard, is `null`, which the watch counts
 * as the root. `cp` and `cpSync` list the tree they copy. */
export function fsListing(name, args, cwd) {
  if (name === 'glob' || name === 'globSync') {
    const opts = args[1] && typeof args[1] === 'object' ? args[1] : {};
    const base = toPath(opts.cwd ?? '.', cwd);
    const patterns = [].concat(args[0]);
    return patterns.map((p) => {
      if (typeof p !== 'string' || base === null || climbsAfterMagic(p)) return null;
      return isAbsolute(p) ? physical(globBase(p)) : physical(`${base}/${globBase(p)}`);
    });
  }
  if (isUrl(args[0]) && args[0].protocol !== 'file:') return [];
  return [toPath(args[0], cwd)];
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

/** The root and `test.setupFiles` vitest resolves for the config at `path`, run from its directory:
 * a Vite `root`, which the config's own `test.root` replaces, where the CLI's `root` overrides it. */
export async function vitestSetup(path, vitestNode) {
  const { resolveConfig } = await import(pathToFileURL(vitestNode).href);
  const config = await resolveConfig({ config: path, watch: false }, { root: dirname(path) });
  return {
    root: config.root,
    setupFiles: [config.test?.setupFiles ?? []].flat().map((f) => resolve(config.root, f)),
  };
}

/** Every vitest config has to install the guard, named from the `root` vitest resolved it at, and
 * a config it could not load (`error`) is refused, not trusted. */
export function judgeConfigs(configs, root) {
  const guard = resolve(root, GUARD_PATH);
  const refused = [];
  for (const { path, root: configRoot, setupFiles, error } of configs) {
    const expected = error ? null : relative(configRoot, guard);
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

/** vite 6's own match for a glob import, which it runs on code with its literals stripped. */
export const GLOB_CALL_RE = /\bimport\.meta\.glob(?:<\w+>)?\s*\(/;

/** The directory vite resolves a `/` or `**` glob from: the nearest package above the file. */
function packageOf(dir, root) {
  for (let d = dir; d === root || d.startsWith(`${root}${sep}`); d = dirname(d)) {
    if (existsSync(join(d, 'package.json'))) return d;
    if (d === root) break;
  }
  return root;
}

/** Where one glob pattern starts listing, resolved as vite 6's `toAbsoluteGlob` resolves it;
 * `null` for one it hands to a resolver (an alias, a `#` import), which nothing here can follow. */
function globDir(pattern, file, root) {
  if (pattern.startsWith('/'))
    return resolve(packageOf(dirname(file), root), globBase(pattern.slice(1)));
  if (pattern.startsWith('./') || pattern.startsWith('../'))
    return resolve(dirname(file), globBase(pattern));
  if (pattern.startsWith('**')) return packageOf(dirname(file), root);
  return null;
}

/**
 * Every `import.meta.glob` call in `source` as `{ dir, via, at }`: vite expands it before the test
 * runs, in vitest's own process, where no watch sees it, and it refuses any pattern that is not a
 * literal, so reading the literals is all vite can expand. A pattern that is not a literal, or that
 * vite would hand a resolver, counts as the root. `ts` is the TypeScript compiler the package
 * declares, read only when the text holds a match.
 */
export function globListings({ source, file, root, ts }) {
  if (!GLOB_CALL_RE.test(source)) return [];
  const kind = /\.[jt]sx$/.test(file)
    ? ts.ScriptKind.TSX
    : /\.[cm]?js$/.test(file)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const shown = relative(root, file);
  const found = [];
  const literal = (n) =>
    ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null;
  const visit = (node) => {
    const callee = ts.isCallExpression(node) ? node.expression : null;
    if (
      callee &&
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'glob' &&
      ts.isMetaProperty(callee.expression) &&
      callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    ) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const arg = node.arguments[0];
      const items = arg && ts.isArrayLiteralExpression(arg) ? [...arg.elements] : [arg];
      for (const item of items) {
        const pattern = item ? literal(item) : null;
        if (pattern?.startsWith('!')) continue;
        const climbs = pattern !== null && climbsAfterMagic(pattern);
        const dir = pattern === null || climbs ? null : globDir(pattern, file, root);
        const text = pattern === null ? (item?.getText(sf) ?? '').slice(0, 60) : `'${pattern}'`;
        const call = `import.meta.glob(${text})`;
        const at = `${shown}:${line}`;
        const why = climbs
          ? "a '..' after a wildcard, which ends wherever the matches lead"
          : 'a pattern the guard cannot resolve';
        found.push(
          dir === null
            ? {
                dir: root,
                via: `${call} (${why}, so counted as the root)`,
                at,
                call,
                line,
                resolved: false,
              }
            : { dir, via: call, at, call, line, resolved: true },
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Which tracked source files expand a glob covering the root, each refused but a declared test:
 * a module cannot carry the declaration, because it would not travel with an import of the module.
 */
export function judgeGlobs({ files, root, ts }) {
  const refused = [];
  for (const { path, source } of files) {
    if (!GLOB_CALL_RE.test(source)) continue;
    const covering = globListings({ source, file: resolve(root, path), root, ts }).filter((g) =>
      coversRoot(root, g.dir),
    );
    if (covering.length === 0) continue;
    const isTest = TEST_FILE_RE.test(path);
    if (isTest && declaresWholeTree(source)) continue;
    for (const g of covering) {
      const from = g.resolved
        ? 'from the repository root'
        : "with a pattern the guard cannot resolve (an alias, a `#` import, not a literal, or a '..' after a wildcard), which counts as the root";
      refused.push({
        path,
        kind: 'glob',
        why: isTest
          ? `line ${g.line} expands ${g.call} ${from} before the test runs, so its input is the whole tree — add a line \`// @gate-input whole-tree\` (or \` * @gate-input whole-tree\` in its opening docblock) so it runs on every change`
          : `line ${g.line} expands ${g.call} ${from}, and a declaration cannot travel with an import of a module — move the glob into a test that declares \`@gate-input whole-tree\`, or narrow the pattern below the root`,
      });
    }
  }
  return refused;
}
