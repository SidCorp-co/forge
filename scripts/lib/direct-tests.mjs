// The direct tests of a change (REQ-36 BC-7, BC-17; Issue to release r20 `rule-merge`): one
// selection for every package, read by `scripts/test-changed.mjs` before a push and by
// `scripts/merge-check.mjs` before a merge.
//
// A test is direct for a touched file when it IS that file, when one of its own import specifiers
// resolves to it (one hop, never the import graph), or when it declares the file with a
// `@direct-test-of <path>` line. Nothing widens past that: no share of the suite turns a selection
// into the whole suite, and a touched file no test reaches is reported, never covered by running
// more. The declaration is how a missed red widens the selection for its change kind
// (`rule-suite`): the test that caught it declares the path it guards.

import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { gitOut, stripComments } from './gate.mjs';

/**
 * Where each package's tests live and which vitest config collects them. `cwd` is the package the
 * config belongs to; core's unit config also collects observability's and the scripts' tests.
 */
export const VITEST_COLLECTIONS = [
  {
    name: '@forge/core',
    cwd: 'packages/core',
    config: 'vitest.config.ts',
    test: /^packages\/core\/(src|tests\/helpers)\/.+\.test\.ts$/,
  },
  {
    name: '@forge/core integration',
    cwd: 'packages/core',
    config: 'vitest.integration.config.ts',
    test: /^packages\/core\/tests\/integration\/.+\.test\.ts$/,
    integration: true,
  },
  {
    name: 'web-v2',
    cwd: 'packages/web-v2',
    config: 'vitest.config.ts',
    test: /^packages\/web-v2\/src\/.+\.test\.tsx?$/,
  },
  {
    name: '@forge/contracts',
    cwd: 'packages/contracts',
    config: 'vitest.config.ts',
    test: /^packages\/contracts\/src\/.+\.test\.ts$/,
  },
  {
    name: '@forge/observability',
    cwd: 'packages/core',
    config: 'vitest.config.ts',
    test: /^packages\/observability\/src\/.+\.test\.ts$/,
  },
  {
    name: 'scripts',
    cwd: 'packages/core',
    config: 'vitest.config.ts',
    test: /^scripts\/.+\.test\.mjs$/,
  },
];

const RUNNER_ROOT = 'packages/runner/crates/';

/** A touched file of this kind is code, so having no direct test is worth saying. */
const CODE_FILE = /\.(ts|tsx|mjs|js|rs)$/;

/** Every specifier a module names: static imports and re-exports, dynamic imports, vi.mock. */
const SPECIFIERS = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bvi\.(?:mock|doMock|importActual|importMock)\(\s*['"]([^'"]+)['"]/g,
];

/** A comment line of its own: `// @direct-test-of <path>` or ` * @direct-test-of <path>`. */
const DECLARATION = /^[ \t]*(?:\/\/|\*)[ \t]*@direct-test-of[ \t]+(\S+)/gm;

/** The specifiers a source text names, in order, each once. */
export function specifiersOf(text) {
  const code = stripComments(text);
  const found = new Set();
  for (const re of SPECIFIERS) {
    for (const m of code.matchAll(re)) found.add(m[1]);
  }
  return [...found];
}

/** The repo paths a test declares itself direct for: a file, or a directory when it ends in `/`. */
export function declarationsOf(text) {
  return [...text.matchAll(DECLARATION)].map((m) => m[1].replace(/^\.\//, ''));
}

export function declarationCovers(declared, path) {
  return declared.endsWith('/') ? path.startsWith(declared) : path === declared;
}

/** tsconfig `paths` of a package, read leniently: comments and trailing commas are allowed there. */
function tsPaths(root, pkgDir) {
  const file = join(root, pkgDir, 'tsconfig.json');
  if (!existsSync(file)) return [];
  const text = stripComments(readFileSync(file, 'utf8')).replace(/,(\s*[}\]])/g, '$1');
  let paths;
  try {
    paths = JSON.parse(text).compilerOptions?.paths ?? {};
  } catch {
    return [];
  }
  return Object.entries(paths).map(([alias, [target]]) => ({
    alias,
    target: posix.normalize(posix.join(pkgDir, target)),
  }));
}

const EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx'];

/** The tracked or untracked file a bare path names, trying the extensions TypeScript would. */
function resolveFile(known, path) {
  const stem = path.replace(/\.(js|mjs)$/, '');
  for (const candidate of [path, ...EXTENSIONS.map((ext) => `${stem}${ext}`)]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/** The package directory a repo path sits in (`packages/<name>`), or null outside one. */
function packageOf(path) {
  const m = /^packages\/[^/]+/.exec(path);
  return m ? m[0] : null;
}

/**
 * The repo path a specifier in `from` resolves to, or null when it names a package outside the
 * workspace. Relative specifiers and the tsconfig aliases of `from`'s package are followed.
 */
export function resolveSpecifier(from, specifier, { known, aliasesOf }) {
  if (specifier.startsWith('.')) {
    return resolveFile(known, posix.normalize(posix.join(posix.dirname(from), specifier)));
  }
  for (const { alias, target } of aliasesOf(packageOf(from) ?? 'packages/core')) {
    if (alias.endsWith('/*')) {
      const prefix = alias.slice(0, -1);
      if (specifier.startsWith(prefix)) {
        return resolveFile(known, target.replace('*', specifier.slice(prefix.length)));
      }
    } else if (specifier === alias) {
      return resolveFile(known, target);
    }
  }
  return null;
}

/** Every file git knows here, tracked or untracked and not ignored. */
export function knownFiles(root) {
  const tracked = gitOut(['ls-files'], root);
  const untracked = gitOut(['ls-files', '--others', '--exclude-standard'], root);
  if (tracked === null || untracked === null) {
    throw new Error('git ls-files failed, so no test can be indexed');
  }
  return new Set(`${tracked}\n${untracked}`.split('\n').filter(Boolean));
}

/** For each test file of every collection: the repo paths it reaches in one hop, and declares. */
export function indexTests(root, known) {
  const aliasCache = new Map();
  const aliasesOf = (pkgDir) => {
    if (!aliasCache.has(pkgDir)) aliasCache.set(pkgDir, tsPaths(root, pkgDir));
    return aliasCache.get(pkgDir);
  };
  const tests = [];
  for (const path of [...known].sort()) {
    const collection = VITEST_COLLECTIONS.find((c) => c.test.test(path));
    if (!collection || !existsSync(join(root, path))) continue;
    const text = readFileSync(join(root, path), 'utf8');
    const reaches = new Set();
    for (const spec of specifiersOf(text)) {
      const hit = resolveSpecifier(path, spec, { known, aliasesOf });
      if (hit) reaches.add(hit);
    }
    tests.push({ path, collection, reaches, declares: declarationsOf(text) });
  }
  return tests;
}

/**
 * The direct selection for `touched` (repo paths, removed files excluded by the caller): per
 * collection the test files and the touched paths that selected each, and the touched code files
 * no TypeScript test reaches. Runner files are selected by `runnerSelection`.
 */
export function selectDirect(touched, tests) {
  const byCollection = new Map();
  const reached = new Set();
  const isTest = new Set(tests.map((t) => t.path));
  for (const test of tests) {
    // A touched test runs itself; a declaration names the code a test guards, never another test.
    const because = touched.filter(
      (t) =>
        t === test.path ||
        test.reaches.has(t) ||
        (!isTest.has(t) && test.declares.some((d) => declarationCovers(d, t))),
    );
    if (because.length === 0) continue;
    for (const t of because) reached.add(t);
    const entry = byCollection.get(test.collection.name) ?? {
      collection: test.collection,
      files: [],
    };
    entry.files.push({ test: test.path, because });
    byCollection.set(test.collection.name, entry);
  }
  const untested = touched.filter(
    (t) => CODE_FILE.test(t) && !t.startsWith(RUNNER_ROOT) && !reached.has(t),
  );
  return { collections: [...byCollection.values()], untested };
}

/**
 * The runner's touched Rust files, by crate: the module path each source file is (`a::b` for
 * `src/a/b.rs`, `a` for `src/a/mod.rs`, `` for the crate root), and each integration test file
 * touched under `tests/`. Which test names a module owns is read from `cargo test -- --list` by
 * `ownedTests`, because only the compiler knows the inline test modules.
 */
export function runnerSelection(touched) {
  const crates = new Map();
  for (const path of touched) {
    if (!path.startsWith(RUNNER_ROOT) || !path.endsWith('.rs')) continue;
    const [crate, area, ...rest] = path.slice(RUNNER_ROOT.length).split('/');
    const entry = crates.get(crate) ?? { crate, modules: [], testTargets: [], untested: [] };
    if (area === 'src') {
      entry.modules.push({ path, module: modulePathOf(rest) });
    } else if (area === 'tests' && rest.length === 1) {
      entry.testTargets.push({ path, target: rest[0].replace(/\.rs$/, '') });
    } else {
      entry.untested.push(path);
    }
    crates.set(crate, entry);
  }
  return [...crates.values()];
}

/** `['a', 'b.rs']` → `a::b`; `mod.rs` names its directory; `lib.rs`, `main.rs` and bins the root. */
export function modulePathOf(segments) {
  if (segments[0] === 'bin') return '';
  const parts = [...segments];
  const last = parts.pop()?.replace(/\.rs$/, '');
  if (last && last !== 'mod' && !(parts.length === 0 && (last === 'lib' || last === 'main'))) {
    parts.push(last);
  }
  return parts.join('::');
}

/** A module that is a file of tests for its parent: `tests.rs`, or `<name>_tests.rs` beside it. */
const TEST_MODULE = /(^|::)(tests|[a-z0-9_]+_tests)$/;

/**
 * The listed test names a touched module's tests are: names whose nearest enclosing module with a
 * file of its own is that module, or a tests file of it (`a/tests.rs`, `a/cancel_tests.rs`). Inline
 * modules (`mod tests { … }`) have no file, so their tests belong to the file that declares them.
 */
export function ownedTests(listed, module, fileModules) {
  return listed.filter((name) => {
    const segments = name.split('::').slice(0, -1);
    for (let i = segments.length; i >= 0; i--) {
      const candidate = segments.slice(0, i).join('::');
      if (!fileModules.has(candidate)) continue;
      if (candidate === module) return true;
      const parent = segments.slice(0, Math.max(0, i - 1)).join('::');
      return TEST_MODULE.test(candidate) && parent === module;
    }
    return false;
  });
}

/** The module paths that have a file of their own in a crate's `src/`. */
export function fileModulesOf(known, crate) {
  const prefix = `${RUNNER_ROOT}${crate}/src/`;
  const modules = new Set(['']);
  for (const path of known) {
    if (path.startsWith(prefix) && path.endsWith('.rs')) {
      modules.add(modulePathOf(path.slice(prefix.length).split('/')));
    }
  }
  return modules;
}

/** The test names `cargo test -- --list` printed, one `name: test` line each. */
export function listedTestNames(stdout) {
  return stdout
    .split('\n')
    .map((l) => /^(\S+): test$/.exec(l.trim())?.[1])
    .filter(Boolean);
}
