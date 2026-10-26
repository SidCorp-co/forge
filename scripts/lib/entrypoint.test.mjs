import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launched } from './entrypoint.mjs';

/**
 * ISS-1236 r6: a script launched through a symlinked folder, or from a real path holding a space,
 * exited 0 having run nothing. This launches every guarded script both ways and walks every
 * script and package source for a launch check written by hand.
 *
 * @gate-input whole-tree
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The two helpers: the only files that may hold the comparison itself. */
const HELPERS = new Set(['scripts/lib/entrypoint.mjs', 'packages/core/src/lib/entrypoint.ts']);

/**
 * Every script that runs when launched, with arguments it refuses or a run that only reads, and the
 * words only its own `main` prints. A launch whose guard answered no exits 0 having printed nothing.
 */
const GUARDED = [
  ['scripts/check-repo-path-readers.mjs', ['--bogus'], /the only mode is --all/],
  ['scripts/check-merged-at-writers.mjs', ['--bogus'], /the only mode is --all/],
  ['scripts/check-lazy-module-init.mjs', [], /only --all is supported/],
  ['scripts/check-status-tuples.mjs', ['--bogus'], /the only mode is --all/],
  ['scripts/check-doc-citations.mjs', [], /the only mode is --all/],
  ['scripts/check-retired-model.mjs', [], /check-retired-model: \d+ files scanned/],
  ['scripts/cut-runner-tag.mjs', [], /usage: cut-runner-tag\.mjs/],
  ['scripts/next-runner-version.mjs', [], /next-runner-version: |version=/],
  ['scripts/runner-release-commit.mjs', ['--cwd', '.'], /runner-release-commit: /],
  ['scripts/lib/whole-tree-shell.mjs', ['--print-grammar'], /whole-tree spawn grammar/],
  ['scripts/verify.mjs', ['--entrypoint-test-unknown-flag'], /unknown|usage/i],
];

let scratch;
/** `scripts/` reached through a symlinked folder: argv names the link, the module its target. */
let linked;
/** A copy of `scripts/` whose real path holds a space, beside links to what it imports from. */
let spaced;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'entrypoint-'));
  linked = join(scratch, 'linked');
  mkdirSync(linked);
  symlinkSync(join(ROOT, 'scripts'), join(linked, 'scripts'));
  spaced = join(scratch, 'a checkout');
  mkdirSync(spaced);
  cpSync(join(ROOT, 'scripts'), join(spaced, 'scripts'), {
    recursive: true,
    filter: (src) => !src.includes('node_modules'),
  });
  symlinkSync(join(ROOT, 'node_modules'), join(spaced, 'node_modules'));
  symlinkSync(join(ROOT, 'packages'), join(spaced, 'packages'));
  for (const file of ['package.json', 'pnpm-workspace.yaml', 'turbo.json']) {
    cpSync(join(ROOT, file), join(spaced, file));
  }
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('launched — the one comparison', () => {
  it('answers yes for the file itself, through a symlinked folder, and from a path with a space', () => {
    const dir = join(scratch, 'a module dir');
    mkdirSync(dir);
    const file = join(dir, 'm.mjs');
    writeFileSync(file, '');
    symlinkSync(dir, join(scratch, 'module-link'));
    const url = pathToFileURL(file).href;
    expect(url).toContain('%20');
    expect(launched(url, file)).toBe(true);
    expect(launched(url, join(scratch, 'module-link', 'm.mjs'))).toBe(true);
  });

  it('answers no for another file, a file that is not there, and no entry at all', () => {
    const file = join(scratch, 'one.mjs');
    writeFileSync(file, '');
    writeFileSync(join(scratch, 'two.mjs'), '');
    const url = pathToFileURL(file).href;
    expect(launched(url, join(scratch, 'two.mjs'))).toBe(false);
    expect(launched(url, join(scratch, 'absent.mjs'))).toBe(false);
    expect(launched(url, '')).toBe(false);
  });
});

describe('every guarded script runs where it is launched from', () => {
  const run = (base, rel, args) => {
    const out = spawnSync(process.execPath, [join(base, rel), ...args], {
      cwd: scratch,
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: out.status, said: `${out.stdout}${out.stderr}` };
  };

  for (const [rel, args, says] of GUARDED) {
    it(`${rel}, launched through a symlinked folder, runs its main`, () => {
      const { said } = run(linked, rel, args);
      expect(said).toMatch(says);
    });

    it(`${rel}, launched from a real path holding a space, runs its main`, () => {
      const { said } = run(spaced, rel, args);
      expect(said).toMatch(says);
    });
  }

  it('lists every script under scripts/ that asks the helper', () => {
    const asking = sourceFiles('scripts').filter(
      (rel) => !HELPERS.has(rel) && /\blaunched\(import\.meta\.url\)/.test(read(rel)),
    );
    expect(asking.sort()).toEqual(GUARDED.map(([rel]) => rel).sort());
  });
});

/** A non-test source file that decides it was launched by comparing the two values itself. */
function handWrittenLaunchChecks(files) {
  return files
    .filter(([rel]) => !HELPERS.has(rel))
    .filter(([, text]) => /import\.meta\.url/.test(text) && /argv\s*\[\s*1\s*\]/.test(text))
    .map(([rel]) => rel);
}

describe('no file decides it was launched by hand', () => {
  it('refuses the raw template, pathToFileURL and new URL comparisons, by file', () => {
    // FIXTURE TEXT — the comparisons this rule refuses, as source.
    const planted = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source, searched rather than run
      ['scripts/a.mjs', 'if (import.meta.url === `file://${process.argv[1]}`) main();\n'],
      ['scripts/b.mjs', 'if (import.meta.url === pathToFileURL(process.argv[ 1 ]).href) main();\n'],
      ['packages/core/src/c.ts', 'const isMain = argv[1] && import.meta.url === x(argv[1]);\n'],
      ['scripts/d.mjs', 'if (launched(import.meta.url)) main();\n'],
      ['scripts/lib/entrypoint.mjs', 'realpathSync(fileURLToPath(import.meta.url)) === argv[1]'],
    ];
    expect(handWrittenLaunchChecks(planted)).toEqual([
      'scripts/a.mjs',
      'scripts/b.mjs',
      'packages/core/src/c.ts',
    ]);
  });

  it('finds none under scripts/ or any package source', () => {
    const roots = [
      'scripts',
      ...readdirSync(join(ROOT, 'packages')).map((p) => `packages/${p}/src`),
    ];
    const files = roots.flatMap((r) => sourceFiles(r)).map((rel) => [rel, read(rel)]);
    expect(files.length).toBeGreaterThan(100);
    expect(handWrittenLaunchChecks(files)).toEqual([]);
  });
});

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function sourceFiles(rel, acc = []) {
  let entries;
  try {
    entries = readdirSync(join(ROOT, rel), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return acc;
    throw err;
  }
  for (const entry of entries) {
    const path = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', '.next', 'target', 'coverage'].includes(entry.name)) {
        sourceFiles(path, acc);
      }
    } else if (
      /\.(mjs|cjs|js|ts|tsx)$/.test(entry.name) &&
      !/\.(test|fixture)\./.test(entry.name)
    ) {
      acc.push(path);
    }
  }
  return acc;
}
