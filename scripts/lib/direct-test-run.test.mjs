// @direct-test-of scripts/test-changed.mjs
// @direct-test-of scripts/merge-check.mjs
//
// A check the scripts time is a check run as the tracker records it (REQ-36 BC-14, ISS-474;
// `packages/contracts/src/check-runs.ts`): its own id, its kind, when it started and how long it took.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  check,
  describeChecks,
  notRun,
  owedBy,
  run,
  runDirectTests,
  runSelection,
} from './direct-test-run.mjs';
import { stripComments } from './gate.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('a timed check', () => {
  const made = () =>
    check({
      name: 'typecheck',
      kind: 'typecheck',
      scope: 'typescript',
      command: 'node scripts/tc-changed.mjs',
      files: [],
      result: 'pass',
      startedAt: Date.parse('2026-10-09T06:00:00.000Z'),
      durationMs: 1500,
    });

  it('carries its kind, its start as ISO 8601 and its duration in milliseconds', () => {
    expect(made()).toEqual({
      id: expect.stringMatching(UUID),
      kind: 'typecheck',
      name: 'typecheck',
      scope: 'typescript',
      command: 'node scripts/tc-changed.mjs',
      files: [],
      result: 'pass',
      durationMs: 1500,
      startedAt: '2026-10-09T06:00:00.000Z',
    });
  });

  it('has an id of its own, so two checks are two records and a resend is one', () => {
    expect(made().id).not.toBe(made().id);
  });

  it('keeps a note only where one was given', () => {
    expect(made()).not.toHaveProperty('note');
    expect(check({ ...made(), startedAt: 0, note: 'nothing to run' }).note).toBe('nothing to run');
  });
});

describe('running one command', () => {
  it('says when it started and how long it took', () => {
    const before = Date.now();
    const r = run(['node', '-e', ''], process.cwd(), { capture: true });
    expect(r.ok).toBe(true);
    expect(r.startedAt).toBeGreaterThanOrEqual(before);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('prints each check with its duration in seconds', () => {
    const [line] = describeChecks([
      { name: 'verify', scope: 'workspace', result: 'pass', durationMs: 61000, files: [] },
    ]);
    expect(line).toContain('61.0s');
  });
});

// The run layer itself (ISS-472 round 2): `runDirectTests` driven over a fixture repository, its
// commands handed to a recorder in place of a shell, so what it would have run is read back exactly.
// Removing the TypeScript run or the runner's loop goes red here, and a selection no run reached is
// red by name at run time (DIRECT_TESTS_NOT_RUN), never "no test file is direct".

const FIXTURE = {
  'packages/core/tsconfig.json': '{}',
  ...Object.fromEntries(
    ['a', 'b', 'c', 'd', 'e'].flatMap((n) => [
      [`packages/core/src/${n}.ts`, `export const ${n} = 1;\n`],
      [`packages/core/src/${n}.test.ts`, `import { ${n} } from './${n}.js';\n`],
    ]),
  ),
  'packages/core/src/unrelated.test.ts': "import { x } from './elsewhere.js';\n",
  'packages/core/src/untested.ts': 'export const nobody = 0;\n',
  'packages/core/tests/integration/a-e2e.test.ts': "await import('../../src/a.js');\n",
  'packages/contracts/tsconfig.json': '{}',
  'packages/contracts/src/vocab.ts': 'export const V = [];\n',
  'packages/contracts/src/vocab.test.ts': "import { V } from './vocab.js';\n",
  'packages/runner/crates/runner-core/src/lib.rs': 'pub mod job_exit;\n',
  'packages/runner/crates/runner-core/src/job_exit.rs': '#[cfg(test)] mod tests {}\n',
  'packages/runner/crates/runner-core/tests/wire.rs': '#[test] fn w() {}\n',
};

const LISTED = [
  'job_exit::tests::exits_zero: test',
  'job_exit::tests::exits_signal: test',
  'job_exit::tests::exits_code: test',
  'other::tests::not_owned: test',
  '',
].join('\n');

let fixture = '';

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'direct-test-run-'));
  for (const [path, text] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), text);
  }
  spawnSync('git', ['init', '-q'], { cwd: fixture });
});

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

/** A recorder standing in for `run`: every command, where it ran, and an answer of `fails` or ok. */
function recorder({ fails = () => false } = {}) {
  const calls = [];
  const exec = (argv, cwd, opts = {}) => {
    calls.push({ argv, cwd: relative(fixture, cwd) });
    const listing = argv[0] === 'cargo' && argv.includes('--list');
    const ok = !fails(argv);
    return {
      ok,
      status: ok ? 0 : 1,
      error: null,
      stdout: listing && opts.capture ? LISTED : '',
      stderr: '',
      startedAt: Date.now(),
      durationMs: 1,
    };
  };
  return { calls, exec };
}

const touchedOf = (...paths) => paths.map((path) => ({ path, change: 'changed' }));

/** The vitest runs a recorder saw: the collection's directory, its config, and the files named. */
const vitestRuns = (calls) =>
  calls
    .filter((c) => c.argv.includes('vitest'))
    .map((c) => ({
      cwd: c.cwd,
      config: c.argv[c.argv.indexOf('--config') + 1],
      files: c.argv.slice(c.argv.indexOf('--config') + 2).map((p) => relative(fixture, p)),
    }));

const cargoRuns = (calls) =>
  calls.filter((c) => c.argv[0] === 'cargo').map((c) => c.argv.join(' '));

describe('the run layer runs what the selection chose, and only that (REQ-36 BC-7)', () => {
  it('runs each selected TypeScript test file under its collection, and each runner test by name', () => {
    const { calls, exec } = recorder();
    const out = runDirectTests(fixture, {
      touched: touchedOf(
        'packages/core/src/a.ts',
        'packages/contracts/src/vocab.ts',
        'packages/runner/crates/runner-core/src/job_exit.rs',
        'packages/runner/crates/runner-core/tests/wire.rs',
      ),
      integration: false,
      exec,
    });
    expect(vitestRuns(calls)).toEqual([
      {
        cwd: 'packages/contracts',
        config: 'vitest.config.ts',
        files: ['packages/contracts/src/vocab.test.ts'],
      },
      { cwd: 'packages/core', config: 'vitest.config.ts', files: ['packages/core/src/a.test.ts'] },
    ]);
    expect(cargoRuns(calls)).toEqual([
      'cargo test -p runner-core --locked -- --list',
      'cargo test -p runner-core --locked -- --exact job_exit::tests::exits_zero job_exit::tests::exits_signal job_exit::tests::exits_code',
      'cargo test -p runner-core --locked --test wire',
    ]);
    expect(out.checks.map((c) => [c.scope, c.result])).toEqual([
      ['@forge/contracts', 'pass'],
      ['@forge/core', 'pass'],
      ['runner/runner-core', 'pass'],
      ['runner/runner-core', 'pass'],
    ]);
  });

  it('runs the direct integration tests only when asked, under the integration config', () => {
    const { calls, exec } = recorder();
    runDirectTests(fixture, {
      touched: touchedOf('packages/core/src/a.ts'),
      integration: true,
      exec,
    });
    expect(vitestRuns(calls).at(-1)).toEqual({
      cwd: 'packages/core',
      config: 'vitest.integration.config.ts',
      files: ['packages/core/tests/integration/a-e2e.test.ts'],
    });
  });

  it('a red run is a red check of its scope', () => {
    const { exec } = recorder({ fails: (argv) => argv.includes('--exact') });
    const out = runDirectTests(fixture, {
      touched: touchedOf('packages/runner/crates/runner-core/src/job_exit.rs'),
      integration: false,
      exec,
    });
    expect(out.checks.map((c) => [c.scope, c.result])).toEqual([['runner/runner-core', 'fail']]);
  });

  it('says no test file is direct only where nothing was selected, and runs nothing', () => {
    const { calls, exec } = recorder();
    const out = runDirectTests(fixture, {
      touched: touchedOf('packages/core/src/untested.ts'),
      integration: false,
      exec,
    });
    expect(calls).toEqual([]);
    expect(out.checks.map((c) => [c.result, c.note])).toEqual([
      ['none', 'no test file is direct for any touched file'],
    ]);
    expect(out.untested).toEqual(['packages/core/src/untested.ts']);
  });
});

describe('a selection no run reached is red by name (REQ-36 BC-7, BC-17)', () => {
  const owed = [
    { name: 'direct-tests', scope: '@forge/core', files: ['packages/core/src/a.test.ts'] },
    {
      name: 'direct-tests',
      scope: 'runner/runner-core',
      files: ['packages/runner/crates/runner-core/src/job_exit.rs'],
    },
  ];

  it('fails each scope whose selected files no check ran, naming them', () => {
    const ranCore = [{ scope: '@forge/core', files: ['packages/core/src/a.test.ts'] }];
    const red = notRun(owed, ranCore);
    expect(red.map((c) => [c.name, c.scope, c.result, c.files])).toEqual([
      [
        'direct-tests',
        'runner/runner-core',
        'fail',
        ['packages/runner/crates/runner-core/src/job_exit.rs'],
      ],
    ]);
    expect(red[0].note).toMatch(/^DIRECT_TESTS_NOT_RUN: 1 selected file\(s\) no run reached: /);
  });

  it('a run that drops part of its selection is red, never "no test file is direct"', () => {
    const { exec } = recorder();
    const dropsCrates = (root, sel) => runSelection(root, { ...sel, crates: [] });
    const out = runDirectTests(fixture, {
      touched: touchedOf('packages/runner/crates/runner-core/src/job_exit.rs'),
      integration: false,
      exec,
      runSelected: dropsCrates,
    });
    expect(out.checks.map((c) => [c.scope, c.result, c.note])).toEqual([
      [
        'runner/runner-core',
        'fail',
        'DIRECT_TESTS_NOT_RUN: 1 selected file(s) no run reached: packages/runner/crates/runner-core/src/job_exit.rs',
      ],
    ]);
  });

  it('a file run under another scope does not count for this one', () => {
    const elsewhere = [{ scope: 'web-v2', files: ['packages/core/src/a.test.ts'] }];
    expect(notRun(owed, elsewhere).map((c) => c.scope)).toEqual([
      '@forge/core',
      'runner/runner-core',
    ]);
  });

  it('owes every selected file of each collection and every touched module and target of a crate', () => {
    const o = owedBy({
      unit: [{ collection: { name: '@forge/core' }, files: [{ test: 't.test.ts' }] }],
      integ: [{ collection: { name: '@forge/core integration' }, files: [{ test: 'i.test.ts' }] }],
      crates: [
        { crate: 'k', modules: [{ path: 'm.rs' }], testTargets: [{ path: 'w.rs' }], untested: [] },
        { crate: 'only-build', modules: [], testTargets: [], untested: ['build.rs'] },
      ],
      integration: true,
    });
    expect(o.map((x) => [x.name, x.scope, x.files])).toEqual([
      ['direct-tests', '@forge/core', ['t.test.ts']],
      ['direct-tests', 'runner/k', ['m.rs', 'w.rs']],
      ['integration-tests', '@forge/core integration', ['i.test.ts']],
    ]);
  });
});

describe('no count of touched files widens what runs (REQ-36 BC-17)', () => {
  it('a five-file change runs the tests of those five files and no other', () => {
    const { calls, exec } = recorder();
    const five = ['a', 'b', 'c', 'd', 'e'].map((n) => `packages/core/src/${n}.ts`);
    runDirectTests(fixture, { touched: touchedOf(...five), integration: false, exec });
    expect(vitestRuns(calls)).toEqual([
      {
        cwd: 'packages/core',
        config: 'vitest.config.ts',
        files: ['a', 'b', 'c', 'd', 'e'].map((n) => `packages/core/src/${n}.test.ts`),
      },
    ]);
  });

  it('every vitest run names its files, at every count of touched files', () => {
    const sources = ['a', 'b', 'c', 'd', 'e'].map((n) => `packages/core/src/${n}.ts`);
    for (let n = 1; n <= sources.length; n++) {
      const { calls, exec } = recorder();
      runDirectTests(fixture, {
        touched: touchedOf(...sources.slice(0, n), 'packages/contracts/src/vocab.ts'),
        integration: true,
        exec,
      });
      for (const run of vitestRuns(calls)) {
        expect([
          n,
          run.files.length > 0,
          run.files.includes('packages/core/src/unrelated.test.ts'),
        ]).toEqual([n, true, false]);
      }
    }
  });
});

describe('the two entrypoints run no test but through the run layer (REQ-36 BC-17)', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  /** Each command an entrypoint starts itself: the program and its first argument. */
  const commandsOf = (file) =>
    [
      ...stripComments(readFileSync(join(HERE, '..', file), 'utf8')).matchAll(
        /\b(?:spawnSync|spawn|execSync|execFileSync|run)\(\s*\[?\s*'([^']+)'(?:\s*,\s*\[?\s*'([^']+)')?/g,
      ),
    ].map((m) => `${m[1]} ${m[2] ?? ''}`.trim());

  it("test-changed starts only git; its tests are runDirectTests' alone", () => {
    expect(commandsOf('test-changed.mjs').filter((c) => !c.startsWith('git '))).toEqual([]);
  });

  it('merge-check starts only git and pnpm verify, which declares the suites and runs none', () => {
    expect(
      commandsOf('merge-check.mjs').filter((c) => !c.startsWith('git ') && c !== 'pnpm verify'),
    ).toEqual([]);
    expect(commandsOf('merge-check.mjs')).toContain('pnpm verify');
  });
});
