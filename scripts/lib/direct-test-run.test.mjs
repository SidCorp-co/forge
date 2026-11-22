// @direct-test-of scripts/test-changed.mjs
// @direct-test-of scripts/merge-check.mjs
//
// A check the scripts time is a check run as the tracker records it (REQ-36 BC-14, ISS-474;
// `packages/contracts/src/check-runs.ts`): its own id, its kind, when it started and how long it took.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  archmapScope,
  check,
  describeChecks,
  lintCommand,
  notRun,
  owedBy,
  run,
  runArchmap,
  runDirectTests,
  runFormLints,
  runReleaseRecord,
  runSelection,
} from './direct-test-run.mjs';
import { stripComments } from './gate.mjs';
import { CHECKS } from './verify-checks.mjs';

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

/**
 * The packages core's collections load from their dist builds, built to their source: the run layer
 * rebuilds each before a test runs and holds the dist to the source (ISS-587), and the recorder
 * stands in for the build, so the fixture carries a dist that already matches.
 */
function withBuiltPackages(root) {
  const files = {
    'packages/contracts/package.json': JSON.stringify({ name: '@forge/contracts' }),
    'packages/observability/package.json': JSON.stringify({ name: '@forge/observability' }),
    'packages/observability/src/index.ts': 'export const scrub = 1;\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  for (const pkg of ['contracts', 'observability']) {
    mkdirSync(join(root, 'packages', pkg, 'dist'), { recursive: true });
    for (const f of readdirSync(join(root, 'packages', pkg, 'src')))
      if (f.endsWith('.ts') && !f.endsWith('.test.ts'))
        writeFileSync(join(root, 'packages', pkg, 'dist', `${f.slice(0, -3)}.js`), '');
  }
}

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'direct-test-run-'));
  for (const [path, text] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), text);
  }
  withBuiltPackages(fixture);
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

describe("a builder's run checks the architecture contracts over what it touched", () => {
  const VERIFY_ARCHMAP = CHECKS.find((c) => c.label === 'archmap').cmd;
  let ready = '';
  beforeAll(() => {
    ready = mkdtempSync(join(tmpdir(), 'direct-test-run-archmap-'));
    for (const dir of ['packages/core/node_modules', 'packages/web-v2/node_modules'])
      mkdirSync(join(ready, dir), { recursive: true });
    for (const file of [
      'node_modules/dependency-cruiser/bin/dependency-cruise.mjs',
      'packages/observability/dist/index.js',
      'packages/contracts/dist/document-patch.js',
    ]) {
      mkdirSync(dirname(join(ready, file)), { recursive: true });
      writeFileSync(join(ready, file), '');
    }
  });
  afterAll(() => rmSync(ready, { recursive: true, force: true }));

  it("runs verify's own archmap command over each touched code file still on disk", () => {
    const { calls, exec } = recorder();
    const out = runArchmap(
      ready,
      [
        { path: 'packages/web-v2/src/features/a/page.tsx', change: 'changed' },
        { path: 'packages/core/src/gone.ts', change: 'removed' },
        { path: 'scripts/README.md', change: 'changed' },
      ],
      { exec },
    );
    expect(calls.map((c) => c.argv)).toEqual([
      [...VERIFY_ARCHMAP, 'packages/web-v2/src/features/a/page.tsx'],
    ]);
    expect(out.checks.map((c) => [c.name, c.kind, c.result, c.files])).toEqual([
      ['archmap', 'conformance', 'pass', ['packages/web-v2/src/features/a/page.tsx']],
    ]);
  });

  it('names the count of a wide change, so its record stays within the checks route limit', () => {
    // check-runs.ts CHECK_RUN_LIMITS.text: a command over 500 is refused, and every check of the
    // report with it (on 2026-11-17, 20 touched files made an 890-character command)
    const paths = Array.from(
      { length: 60 },
      (_, i) => `packages/web-v2/src/features/a/page-${i}.tsx`,
    );
    for (const path of paths) {
      mkdirSync(dirname(join(ready, path)), { recursive: true });
      writeFileSync(join(ready, path), '');
    }
    const { exec } = recorder();
    const out = runArchmap(ready, touchedOf(...paths), { exec });
    expect(out.checks[0].files).toHaveLength(60);
    expect(out.checks[0].command.length).toBeLessThanOrEqual(500);
    expect(out.checks[0].command).toMatch(/<60 files>$/);
  });

  it('a contract archmap finds broken is a red check', () => {
    const { exec } = recorder({ fails: () => true });
    const out = runArchmap(ready, touchedOf('packages/web-v2/src/features/a/page.tsx'), { exec });
    expect(out.checks.map((c) => c.result)).toEqual(['fail']);
  });

  it('checks the whole tree where the manifest, its baseline or archmap itself is touched', () => {
    for (const path of [
      '.arch.json',
      '.arch.baseline.json',
      '.arch-tsconfig.json',
      '.forge/archmap/src/cli.mjs',
    ]) {
      expect(archmapScope(touchedOf(path, 'packages/core/src/a.ts'))).toEqual({
        whole: true,
        paths: [],
      });
    }
    const { calls, exec } = recorder();
    runArchmap(ready, touchedOf('.arch.json'), { exec });
    expect(calls.map((c) => c.argv)).toEqual([VERIFY_ARCHMAP]);
  });

  it('runs nothing where no code file and nothing archmap reads was touched', () => {
    expect(archmapScope(touchedOf('docs/VISION.md', 'changelog.d/x.fixed.md'))).toBeNull();
    const { calls, exec } = recorder();
    expect(runArchmap(ready, touchedOf('docs/VISION.md'), { exec })).toEqual({
      checks: [],
      refusal: null,
    });
    expect(calls).toEqual([]);
  });

  it('a checkout archmap cannot run in is refused by name, never passed', () => {
    const { calls, exec } = recorder();
    const out = runArchmap(fixture, touchedOf('packages/core/src/a.ts'), { exec });
    expect(calls).toEqual([]);
    expect(out.checks).toEqual([]);
    expect(out.refusal).toMatch(
      /archmap cannot run in this checkout[\s\S]*pnpm install --frozen-lockfile/,
    );
  });
});

describe("a builder's run lints what it touched and judges its changelog fragment, as verify does (ISS-1370)", () => {
  const CORE_LINT = 'biome check src tests --max-diagnostics=none';
  const OBSERVABILITY_LINT = 'biome check src --max-diagnostics=none';
  const WEB_LINT =
    'eslint --pass-on-unpruned-suppressions --format ./eslint/count-formatter.mjs src';
  let tree = '';
  beforeAll(() => {
    tree = mkdtempSync(join(tmpdir(), 'direct-test-run-form-'));
    const files = {
      'packages/core/package.json': JSON.stringify({
        name: '@forge/core',
        scripts: { lint: CORE_LINT },
      }),
      'packages/observability/package.json': JSON.stringify({
        name: '@forge/observability',
        scripts: { lint: OBSERVABILITY_LINT },
      }),
      'packages/web-v2/package.json': JSON.stringify({
        name: 'web-v2',
        scripts: { lint: WEB_LINT },
      }),
      'packages/web-v2/eslint/count-formatter.mjs': '',
    };
    for (const dir of [
      'node_modules',
      'packages/core/node_modules',
      'packages/web-v2/node_modules',
      'packages/core/src',
      'packages/core/tests',
      'packages/observability/src',
      'packages/web-v2/src',
      'packages/web-v2/eslint',
      'scripts',
    ])
      mkdirSync(join(tree, dir), { recursive: true });
    for (const [path, text] of Object.entries(files)) writeFileSync(join(tree, path), text);
  });
  afterAll(() => rmSync(tree, { recursive: true, force: true }));

  /** A stand-in for `run` answering each command with `out` and `fails`, recording where it ran. */
  const lintRecorder = ({ fails = () => false, out = () => 'Checked 1 file(s)\n' } = {}) => {
    const calls = [];
    const exec = (argv, cwd, opts = {}) => {
      calls.push({ argv, cwd: relative(tree, cwd) || '.', capture: opts.capture === true });
      const ok = !fails(argv);
      return {
        ok,
        status: ok ? 0 : 1,
        error: null,
        stdout: out(argv),
        stderr: '',
        startedAt: Date.now(),
        durationMs: 3,
      };
    };
    return { calls, exec };
  };
  const quiet = (fn) => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      return fn();
    } finally {
      write.mockRestore();
    }
  };

  it("runs each form lint's own command over the touched files under its directories, never the tree", () => {
    const { calls, exec } = lintRecorder();
    const out = quiet(() =>
      runFormLints(
        tree,
        [
          { path: 'packages/core/src/a.ts', change: 'added' },
          { path: 'packages/core/tests/b.test.ts', change: 'changed' },
          { path: 'packages/core/src/gone.ts', change: 'removed' },
          { path: 'packages/core/drizzle/meta/_journal.json', change: 'changed' },
          { path: 'packages/observability/src/secret-scrub.ts', change: 'changed' },
          { path: 'packages/web-v2/src/page.tsx', change: 'changed' },
          { path: 'scripts/lib/x.mjs', change: 'changed' },
          { path: 'docs/VISION.md', change: 'changed' },
        ],
        { exec },
      ),
    );
    expect(out.refusal).toBeNull();
    expect(calls.map((c) => [c.cwd, c.argv.join(' ')])).toEqual([
      ['packages/core', 'pnpm exec biome check --max-diagnostics=none src/a.ts tests/b.test.ts'],
      [
        'packages/observability',
        'pnpm exec biome check --max-diagnostics=none src/secret-scrub.ts',
      ],
      [
        'packages/web-v2',
        'pnpm exec eslint --pass-on-unpruned-suppressions --format ./eslint/count-formatter.mjs src/page.tsx',
      ],
      ['.', 'pnpm exec biome check scripts/lib/x.mjs'],
    ]);
    expect(out.checks.map((c) => [c.name, c.kind, c.scope, c.result, c.files])).toEqual([
      [
        'core lint',
        'conformance',
        'form',
        'pass',
        ['packages/core/src/a.ts', 'packages/core/tests/b.test.ts'],
      ],
      [
        'observability lint',
        'conformance',
        'form',
        'pass',
        ['packages/observability/src/secret-scrub.ts'],
      ],
      ['web lint', 'conformance', 'form', 'pass', ['packages/web-v2/src/page.tsx']],
      ['scripts lint', 'conformance', 'form', 'pass', ['scripts/lib/x.mjs']],
    ]);
    expect(out.checks[0].command).toBe(
      '(cd packages/core && pnpm exec biome check --max-diagnostics=none <2 files>)',
    );
  });

  it('a format or lint red in a touched file is a red check naming it', () => {
    const { exec } = lintRecorder({ fails: (argv) => argv.includes('src/a.ts') });
    const out = quiet(() =>
      runFormLints(tree, touchedOf('packages/core/src/a.ts', 'scripts/y.mjs'), { exec }),
    );
    expect(out.checks.map((c) => [c.name, c.result, c.files])).toEqual([
      ['core lint', 'fail', ['packages/core/src/a.ts']],
      ['observability lint', 'none', []],
      ['web lint', 'none', []],
      ['scripts lint', 'pass', ['scripts/y.mjs']],
    ]);
  });

  it('a lint that read none of the files handed it says none, never pass', () => {
    // Biome handed only a file its config ignores reads 0 files and exits 1 ("No files were processed")
    const { exec } = lintRecorder({ fails: () => true, out: () => 'Checked 0 files in 3ms.\n' });
    const out = quiet(() => runFormLints(tree, touchedOf('scripts/README.md'), { exec }));
    expect(out.checks.find((c) => c.name === 'scripts lint')).toMatchObject({
      result: 'none',
      files: ['scripts/README.md'],
      note: expect.stringMatching(/read none of the touched files/),
    });
  });

  it('a change touching no linted file and no fragment reports each check as none, at no time, running nothing', () => {
    const { calls, exec } = lintRecorder();
    const touched = touchedOf('docs/VISION.md', 'packages/core/drizzle/0001_x.sql');
    const out = runFormLints(tree, touched, { exec });
    const record = runReleaseRecord(tree, touched, { exec });
    expect(calls).toEqual([]);
    expect([...out.checks, record].map((c) => [c.name, c.scope, c.result, c.durationMs])).toEqual([
      ['core lint', 'form', 'none', 0],
      ['observability lint', 'form', 'none', 0],
      ['web lint', 'form', 'none', 0],
      ['scripts lint', 'form', 'none', 0],
      ['release-record', 'record', 'none', 0],
    ]);
    expect(describeChecks([record])[0]).toMatch(
      /^ {2}none\s+release-record\s+record\s+0\.0s\s+— no touched changelog fragment/,
    );
  });

  it("runs verify's own release-record command where a fragment, the record or its amnesty is touched", () => {
    const VERIFY_RECORD = CHECKS.find((c) => c.label === 'release-record').cmd;
    for (const path of [
      'changelog.d/iss-1.fixed.md',
      'CHANGELOG.md',
      '.forge/changelog-amnesty.json',
    ]) {
      const { calls, exec } = lintRecorder({ fails: () => true });
      const red = quiet(() => runReleaseRecord(tree, touchedOf(path, 'docs/x.md'), { exec }));
      expect(calls.map((c) => [c.cwd, c.argv])).toEqual([['.', VERIFY_RECORD]]);
      expect([red.name, red.kind, red.scope, red.result, red.files]).toEqual([
        'release-record',
        'conformance',
        'record',
        'fail',
        [path],
      ]);
    }
  });

  it('a lint verify runs as no package script this run can narrow is refused by name', () => {
    const bare = mkdtempSync(join(tmpdir(), 'direct-test-run-form-bare-'));
    try {
      expect(lintCommand(bare, ['pnpm', '--filter', '@forge/core', 'lint'])).toEqual({
        refusal: expect.stringMatching(/pnpm --filter @forge\/core lint` names no package script/),
      });
      const { calls, exec } = lintRecorder();
      const out = runFormLints(bare, touchedOf('packages/core/src/a.ts'), { exec });
      expect(out).toEqual({ checks: [], refusal: expect.stringMatching(/^core lint: /) });
      expect(calls).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
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

// The same at sizes past any plausible threshold (ISS-472 round 3): dev landings touch 16 to 55 files,
// and a run layer whose fixture stopped at six let a whole-collection run above twelve stay green. A
// fallback keyed on a count or a share fires for every count past it, so the largest count here
// catches any threshold below it.
describe('no count of touched files widens what runs, at hundreds of files (REQ-36 BC-17)', () => {
  const WIDE = 600;
  let wide = '';

  beforeAll(() => {
    wide = mkdtempSync(join(tmpdir(), 'direct-test-run-wide-'));
    const files = {
      'packages/core/tsconfig.json': '{}',
      'packages/contracts/tsconfig.json': '{}',
      'packages/core/src/unrelated.test.ts': "import { x } from './elsewhere.js';\n",
      'packages/contracts/src/unrelated.test.ts': "import { x } from './elsewhere.js';\n",
    };
    for (let i = 0; i < WIDE; i++) {
      const pkg = i % 4 === 0 ? 'contracts' : 'core';
      files[`packages/${pkg}/src/w${i}.ts`] = `export const w${i} = 1;\n`;
      files[`packages/${pkg}/src/w${i}.test.ts`] = `import { w${i} } from './w${i}.js';\n`;
    }
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(wide, path)), { recursive: true });
      writeFileSync(join(wide, path), text);
    }
    withBuiltPackages(wide);
    spawnSync('git', ['init', '-q'], { cwd: wide });
  });

  afterAll(() => rmSync(wide, { recursive: true, force: true }));

  const sourceOf = (i) => `packages/${i % 4 === 0 ? 'contracts' : 'core'}/src/w${i}.ts`;

  it("runs exactly the touched files' tests, every vitest run naming its files, at every count up to all of them", () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (const n of [
        1,
        2,
        7,
        13,
        16,
        20,
        33,
        55,
        64,
        100,
        128,
        250,
        299,
        301,
        450,
        WIDE - 1,
        WIDE,
      ]) {
        const calls = [];
        const exec = (argv, cwd) => {
          calls.push({ argv, cwd: relative(wide, cwd) });
          return {
            ok: true,
            status: 0,
            error: null,
            stdout: '',
            stderr: '',
            startedAt: Date.now(),
            durationMs: 1,
          };
        };
        const touched = Array.from({ length: n }, (_, i) => ({
          path: sourceOf(i),
          change: 'changed',
        }));
        const { checks } = runDirectTests(wide, { touched, integration: false, exec });
        // Before them, the builds core's tests load (ISS-587), each once, and only where a core
        // collection runs: the first source is contracts', whose tests load no build.
        const isBuild = (c) => c.argv[0] === 'pnpm' && c.argv.at(-1) === 'build';
        expect([n, calls.filter(isBuild).map((c) => c.argv.join(' '))]).toEqual([
          n,
          n > 1
            ? [
                'pnpm --filter @forge/observability run build',
                'pnpm --filter @forge/contracts run build',
              ]
            : [],
        ]);
        // Every other command started is a vitest run naming files, and nothing else.
        const shapes = calls
          .filter((c) => !isBuild(c))
          .map((c) => {
            const at = c.argv.indexOf('--config');
            const named = at === -1 ? [] : c.argv.slice(at + 2);
            return c.argv.includes('vitest') && named.length > 0
              ? 'vitest naming files'
              : c.argv.join(' ');
          });
        expect([n, [...new Set(shapes)]]).toEqual([n, ['vitest naming files']]);
        const ran = calls
          .filter((c) => !isBuild(c))
          .flatMap((c) => c.argv.slice(c.argv.indexOf('--config') + 2))
          .map((p) => relative(wide, p));
        const want = touched.map((t) => t.path.replace(/\.ts$/, '.test.ts'));
        expect([n, [...ran].sort()]).toEqual([n, [...want].sort()]);
        expect([n, checks.filter((c) => c.result === 'fail').map((c) => c.name)]).toEqual([n, []]);
      }
    } finally {
      log.mockRestore();
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
