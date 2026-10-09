// The direct selection (REQ-36 BC-7, BC-17; ISS-472), over a fixture workspace in a temporary git
// repository: a touched file runs only the tests one hop from it, in every package, and nothing turns
// a selection into the whole suite.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  declarationsOf,
  fileModulesOf,
  indexTests,
  knownFiles,
  listedTestNames,
  modulePathOf,
  ownedTests,
  runnerSelection,
  selectDirect,
  specifiersOf,
} from './direct-tests.mjs';

const TSCONFIG = JSON.stringify({
  // comments and trailing commas are what a tsconfig holds
  compilerOptions: {
    paths: { '@forge/contracts/*': ['../contracts/src/*'], '@/*': ['./src/*'] },
  },
});

const FILES = {
  'packages/core/tsconfig.json': TSCONFIG,
  'packages/web-v2/tsconfig.json': TSCONFIG,
  'packages/contracts/tsconfig.json': TSCONFIG,
  'packages/core/src/issues/leaf.ts': 'export const leaf = 1;\n',
  'packages/core/src/issues/leaf.test.ts': "import { leaf } from './leaf.js';\n",
  'packages/core/src/issues/middle.ts':
    "import { leaf } from './leaf.js';\nexport const middle = leaf;\n",
  'packages/core/src/issues/middle.test.ts': "import { middle } from './middle.js';\n",
  'packages/core/src/issues/top.test.ts': "import { middle } from './middle.js';\n",
  'packages/core/src/issues/mocked.test.ts': "vi.mock('./leaf.js', () => ({}));\n",
  'packages/core/src/untested.ts': 'export const nobody = 0;\n',
  'packages/core/tests/integration/leaf-e2e.test.ts':
    "const { leaf } = await import('../../src/issues/leaf.js');\n",
  'packages/core/tests/integration/route-e2e.test.ts':
    '// @direct-test-of packages/core/src/issues/\nawait fetch("/api/issues");\n',
  'packages/contracts/src/vocab.ts': 'export const V = [];\n',
  'packages/contracts/src/vocab.test.ts': "import { V } from './vocab.js';\n",
  'packages/web-v2/src/lib/format.ts': "import { V } from '@forge/contracts/vocab';\nexport {};\n",
  'packages/web-v2/src/lib/format.test.ts': "import '@/lib/format';\n",
  'packages/web-v2/src/lib/page.test.tsx': "export { x } from '../lib/format';\n",
  'scripts/lib/thing.mjs': 'export const thing = 1;\n',
  'scripts/lib/thing.test.mjs': "import { thing } from './thing.mjs';\n",
  'scripts/lib/reads-ci.test.mjs': '// @direct-test-of .github/workflows/ci.yml\n',
  '.github/workflows/ci.yml': 'on: push\n',
  'packages/runner/crates/runner-core/src/lib.rs': 'pub mod ledger;\n',
  'packages/runner/crates/runner-core/src/ledger/mod.rs': 'pub mod runs;\n',
  'packages/runner/crates/runner-core/src/ledger/runs.rs': 'fn x() {}\n',
  'packages/runner/crates/runner-core/src/ledger/runs/cancel_tests.rs': '#[test] fn c() {}\n',
  'packages/runner/crates/runner-core/src/ledger/runs/state.rs': 'fn s() {}\n',
  'packages/runner/crates/runner-core/tests/wire.rs': '#[test] fn w() {}\n',
};

let root = '';
let tests = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'direct-tests-'));
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  spawnSync('git', ['init', '-q'], { cwd: root });
  tests = indexTests(root, knownFiles(root));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const selected = (touched) =>
  Object.fromEntries(
    selectDirect(touched, tests).collections.map((c) => [
      c.collection.name,
      c.files.map((f) => f.test),
    ]),
  );

describe('a touched file runs the tests one hop from it, never the import graph', () => {
  it('a core source runs its own test, its direct importers among the tests, the mock, and its integration test', () => {
    expect(selected(['packages/core/src/issues/leaf.ts'])).toEqual({
      '@forge/core': [
        'packages/core/src/issues/leaf.test.ts',
        'packages/core/src/issues/mocked.test.ts',
      ],
      '@forge/core integration': [
        'packages/core/tests/integration/leaf-e2e.test.ts',
        'packages/core/tests/integration/route-e2e.test.ts',
      ],
    });
  });

  it('does not run a test that reaches the file only through another module', () => {
    const files = selected(['packages/core/src/issues/leaf.ts'])['@forge/core'];
    expect(files).not.toContain('packages/core/src/issues/middle.test.ts');
    expect(files).not.toContain('packages/core/src/issues/top.test.ts');
  });

  it('a touched test runs itself and nothing else', () => {
    expect(selected(['packages/core/src/issues/top.test.ts'])).toEqual({
      '@forge/core': ['packages/core/src/issues/top.test.ts'],
    });
  });

  it('a web file runs its tests through the `@/` alias and a relative re-export, under the web config', () => {
    expect(selected(['packages/web-v2/src/lib/format.ts'])).toEqual({
      'web-v2': ['packages/web-v2/src/lib/format.test.ts', 'packages/web-v2/src/lib/page.test.tsx'],
    });
  });

  it('a contracts file runs its own test under the contracts config, and no web test that imports an importer', () => {
    expect(selected(['packages/contracts/src/vocab.ts'])).toEqual({
      '@forge/contracts': ['packages/contracts/src/vocab.test.ts'],
    });
  });

  it("a script runs its test under core's config, the collection that holds the scripts' tests", () => {
    const run = selectDirect(['scripts/lib/thing.mjs'], tests).collections;
    expect(
      run.map((c) => [c.collection.name, c.collection.cwd, c.files.map((f) => f.test)]),
    ).toEqual([['scripts', 'packages/core', ['scripts/lib/thing.test.mjs']]]);
  });
});

describe('a test no import reaches is selected only by its own declaration', () => {
  it('reads `@direct-test-of` for a file and for a directory', () => {
    const text = [
      '// @direct-test-of .github/workflows/ci.yml',
      ' * @direct-test-of ./scripts/',
      "const s = '// @direct-test-of not/a/declaration.ts';",
    ].join('\n');
    expect(declarationsOf(text)).toEqual(['.github/workflows/ci.yml', 'scripts/']);
    expect(selected(['.github/workflows/ci.yml'])).toEqual({
      scripts: ['scripts/lib/reads-ci.test.mjs'],
    });
  });

  it('reports touched code no test reaches rather than running more', () => {
    const out = selectDirect(['packages/core/src/untested.ts', 'docs/x.md'], tests);
    expect(out.collections).toEqual([]);
    expect(out.untested).toEqual(['packages/core/src/untested.ts']);
  });
});

describe('the specifiers a module names', () => {
  it('reads static, dynamic, re-export and vi.mock specifiers, and none from a comment', () => {
    const text = [
      "import a from './a.js';",
      "import type { B } from '../b.js';",
      "export * from './c.js';",
      "const d = await import('./d.js');",
      "vi.mock('./e.js');",
      "import './f.css';",
      "// import g from './g.js';",
    ].join('\n');
    expect(specifiersOf(text)).toEqual([
      './a.js',
      '../b.js',
      './c.js',
      './f.css',
      './d.js',
      './e.js',
    ]);
  });
});

describe("the runner's direct tests are the touched modules' own", () => {
  it('maps a source file to its module path, and a crate root and a bin to the root', () => {
    expect(modulePathOf(['ledger', 'runs.rs'])).toBe('ledger::runs');
    expect(modulePathOf(['ledger', 'mod.rs'])).toBe('ledger');
    expect(modulePathOf(['lib.rs'])).toBe('');
    expect(modulePathOf(['main.rs'])).toBe('');
    expect(modulePathOf(['bin', 'tool.rs'])).toBe('');
  });

  it('selects by crate: source modules, touched test targets, and what it cannot place', () => {
    expect(
      runnerSelection([
        'packages/runner/crates/runner-core/src/ledger/runs.rs',
        'packages/runner/crates/runner-core/tests/wire.rs',
        'packages/runner/crates/runner-core/build.rs',
        'packages/runner/Cargo.toml',
      ]),
    ).toEqual([
      {
        crate: 'runner-core',
        modules: [
          { path: 'packages/runner/crates/runner-core/src/ledger/runs.rs', module: 'ledger::runs' },
        ],
        testTargets: [{ path: 'packages/runner/crates/runner-core/tests/wire.rs', target: 'wire' }],
        untested: ['packages/runner/crates/runner-core/build.rs'],
      },
    ]);
  });

  it("owns a module's inline tests and its tests files, never a child module's that has a file of its own", () => {
    const listed = listedTestNames(
      [
        'ledger::runs::tests::takes_a_run: test',
        'ledger::runs::tests::refuses_twice: test',
        'ledger::runs::cancel_tests::stops_on_cancel: test',
        'ledger::runs::state::tests::own_case: test',
        'ledger::tests::opens: test',
        'tests::root_case: test',
        'src/lib.rs - doc (line 3): test',
        '',
        '3 tests, 0 benchmarks',
      ].join('\n'),
    );
    const modules = fileModulesOf(knownFiles(root), 'runner-core');
    expect([...modules].sort()).toEqual([
      '',
      'ledger',
      'ledger::runs',
      'ledger::runs::cancel_tests',
      'ledger::runs::state',
    ]);
    expect(ownedTests(listed, 'ledger::runs', modules)).toEqual([
      'ledger::runs::tests::takes_a_run',
      'ledger::runs::tests::refuses_twice',
      'ledger::runs::cancel_tests::stops_on_cancel',
    ]);
    expect(ownedTests(listed, 'ledger::runs::cancel_tests', modules)).toEqual([
      'ledger::runs::cancel_tests::stops_on_cancel',
    ]);
    expect(ownedTests(listed, 'ledger::runs::state', modules)).toEqual([
      'ledger::runs::state::tests::own_case',
    ]);
    expect(ownedTests(listed, 'ledger', modules)).toEqual(['ledger::tests::opens']);
    expect(ownedTests(listed, '', modules)).toEqual(['tests::root_case']);
  });
});

describe('no count of touched files and no share of the suite widens the selection (REQ-36 BC-17)', () => {
  // A missed red widens the selection for its change kind, never the suite size (`rule-suite`), so
  // the selection of a set is exactly what its files select one by one, however many there are.
  const byCollection = (out) =>
    Object.fromEntries(out.collections.map((c) => [c.collection.name, c.files.map((f) => f.test)]));

  // Sizes past any plausible threshold (ISS-472 round 3): dev landings touch 16 to 55 files, and a
  // guard whose fixture stopped at 12 let a fallback above 12 stay green. A count- or share-keyed
  // fallback fires for every count past its threshold, so the largest count here catches any
  // threshold below it, and every count up to `EVERY` catches one that fires on a window.
  const COUNT = 1200;
  const EVERY = 80;
  const counts = [
    ...Array.from({ length: EVERY }, (_, i) => i + 1),
    ...[100, 128, 200, 256, 400, 512, 600, 800, 1000, 1024, COUNT - 1, COUNT],
  ];

  it('at every count, n touched files select exactly their n tests, past half the suite and short of all', () => {
    const collection = { name: '@forge/core' };
    const index = [
      ...Array.from({ length: COUNT }, (_, i) => ({
        path: `packages/core/src/s${i}.test.ts`,
        collection,
        reaches: new Set([`packages/core/src/s${i}.ts`]),
        declares: [],
      })),
      { path: 'packages/core/src/z.test.ts', collection, reaches: new Set(), declares: [] },
    ];
    for (const n of counts) {
      const touched = Array.from({ length: n }, (_, i) => `packages/core/src/s${i}.ts`);
      const out = selectDirect(touched, index);
      expect([n, byCollection(out), out.untested]).toEqual([
        n,
        { '@forge/core': touched.map((t) => t.replace(/\.ts$/, '.test.ts')) },
        [],
      ]);
    }
  });

  it("over a synthetic index of thousands of tests, any set's selection is the union of each file's own", () => {
    // Deterministic: a seeded generator, so a red names the same set on every run.
    let seed = 472;
    const rand = (n) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const SOURCES = 900;
    const sources = Array.from({ length: SOURCES }, (_, i) => {
      const pkg = ['core', 'web-v2', 'contracts'][i % 3];
      return `packages/${pkg}/src/m${Math.floor(i / 30)}/f${i}.ts`;
    });
    const collections = Object.fromEntries(
      ['core', 'web-v2', 'contracts'].map((p) => [p, { name: p }]),
    );
    // Each test reaches one to four sources, a tenth declare a directory, and some sources are reached
    // by no test at all, so the untested report is exercised as well.
    const index = Array.from({ length: 2 * SOURCES }, (_, i) => {
      const pkg = ['core', 'web-v2', 'contracts'][i % 3];
      const reaches = new Set(
        Array.from({ length: 1 + rand(4) }, () => sources[rand(SOURCES - 60)]),
      );
      const declares = i % 10 === 0 ? [`packages/${pkg}/src/m${rand(28)}/`] : [];
      return {
        path: `packages/${pkg}/src/t${i}.test.ts`,
        collection: collections[pkg],
        reaches,
        declares,
      };
    });
    // Tests no touched file can reach: any one of them selected is the selection widened.
    for (const pkg of Object.keys(collections)) {
      for (let i = 0; i < 40; i++) {
        index.push({
          path: `packages/${pkg}/src/orphan${i}.test.ts`,
          collection: collections[pkg],
          reaches: new Set(),
          declares: [],
        });
      }
    }
    const sorted = (out) =>
      Object.fromEntries(
        Object.entries(byCollection(out))
          .map(([k, v]) => [k, [...v].sort()])
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    const alone = new Map(sources.map((f) => [f, selectDirect([f], index)]));
    for (const size of [1, 2, 13, 20, 55, 100, 300, 450, 600, 899, SOURCES]) {
      const set =
        size === SOURCES
          ? sources
          : [...new Set(Array.from({ length: size }, () => sources[rand(SOURCES)]))];
      const union = {};
      const untested = new Set();
      for (const f of set) {
        for (const [name, list] of Object.entries(byCollection(alone.get(f)))) {
          union[name] = [...new Set([...(union[name] ?? []), ...list])];
        }
        for (const u of alone.get(f).untested) untested.add(u);
      }
      const got = selectDirect(set, index);
      const want = sorted({
        collections: Object.entries(union).map(([name, list]) => ({
          collection: { name },
          files: list.map((test) => ({ test })),
        })),
      });
      expect([size, sorted(got), [...got.untested].sort()]).toEqual([
        size,
        want,
        [...untested].sort(),
      ]);
      // No test reaching none of the set is selected, at any size, the whole set of sources included.
      const orphans = Object.values(byCollection(got))
        .flat()
        .filter((t) => t.includes('/orphan'));
      expect([size, orphans]).toEqual([size, []]);
    }
  });

  it("the selection of every set of the fixture's files is the union of each file's own", () => {
    const files = [
      'packages/core/src/issues/leaf.ts',
      'packages/core/src/issues/middle.ts',
      'packages/core/src/issues/top.test.ts',
      'packages/core/src/untested.ts',
      'packages/contracts/src/vocab.ts',
      'packages/web-v2/src/lib/format.ts',
      'scripts/lib/thing.mjs',
      '.github/workflows/ci.yml',
    ];
    const alone = new Map(files.map((f) => [f, byCollection(selectDirect([f], tests))]));
    for (let mask = 1; mask < 1 << files.length; mask++) {
      const set = files.filter((_, i) => mask & (1 << i));
      const union = {};
      for (const f of set) {
        for (const [name, list] of Object.entries(alone.get(f))) {
          union[name] = [...new Set([...(union[name] ?? []), ...list])].sort();
        }
      }
      const got = Object.fromEntries(
        Object.entries(byCollection(selectDirect(set, tests))).map(([k, v]) => [k, [...v].sort()]),
      );
      expect([set, got]).toEqual([set, union]);
    }
  });
});
