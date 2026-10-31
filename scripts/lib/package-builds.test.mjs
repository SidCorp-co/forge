// @direct-test-of scripts/merge-check.mjs
// @direct-test-of scripts/test-changed.mjs
// @direct-test-of scripts/lib/direct-test-run.mjs
// @direct-test-of scripts/lib/direct-tests.mjs
//
// The direct tests run against the workspace packages as their source stands, never against a dist
// built before a rebase (ISS-587, REQ-74 BC-5). `@forge/contracts` and `@forge/observability` export
// only their dist, so a core test loads whatever was last built: after a rebase onto a base that adds
// a contracts export, that is an old build, and the test fails ERR_MODULE_NOT_FOUND on a module the
// change never touched. The run layer rebuilds each package a selected collection loads before any
// test starts, and where it cannot get a build that matches the source it stops, by name.

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { run, runDirectTests } from './direct-test-run.mjs';
import { VITEST_COLLECTIONS } from './direct-tests.mjs';
import {
  buildMismatch,
  installRefusal,
  rebuildPackages,
  VERIFY_LOADS_BUILT,
  verifyBuildsOwed,
} from './package-builds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A package build standing in for tsgo: every src module copied to dist as its .js, dist emptied first. */
const COPY_BUILD = `import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
for (const f of readdirSync('src')) if (f.endsWith('.ts')) cpSync('src/' + f, 'dist/' + f.slice(0, -3) + '.js');
`;

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A workspace as a builder holds it after rebasing onto a base that added `fresh` to contracts: the
 * source has it, a core test imports it, and contracts' dist is the build from before the rebase.
 * `build` is the node argv of contracts' build script.
 */
function rebasedWorkspace({ build = ['build.mjs'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'package-builds-'));
  made.push(root);
  const files = {
    'package.json': JSON.stringify({ name: 'fixture', private: true }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'packages/contracts/package.json': JSON.stringify({
      name: '@forge/contracts',
      type: 'module',
      exports: { './*': { default: './dist/*.js' } },
      scripts: { build: ['node', ...build].join(' ') },
      nodeBuild: build,
    }),
    'packages/contracts/build.mjs': COPY_BUILD,
    'packages/contracts/src/old.ts': 'export const old = 1;\n',
    'packages/observability/package.json': JSON.stringify({
      name: '@forge/observability',
      type: 'module',
      exports: { '.': { default: './dist/index.js' } },
      scripts: { build: 'node build.mjs' },
      nodeBuild: ['build.mjs'],
    }),
    'packages/observability/build.mjs': COPY_BUILD,
    'packages/observability/src/index.ts': 'export const scrub = (s) => s;\n',
    'packages/core/package.json': JSON.stringify({ name: '@forge/core', type: 'module' }),
    'packages/core/src/fresh.test.ts': "import { fresh } from '@forge/contracts/fresh';\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  // The build from before the rebase: the old export only, older than every source file.
  for (const [dir, file] of [
    ['packages/contracts', 'old'],
    ['packages/observability', 'index'],
  ]) {
    mkdirSync(join(root, dir, 'dist'), { recursive: true });
    writeFileSync(
      join(root, dir, 'dist', `${file}.js`),
      readFileSync(join(root, dir, 'src', `${file}.ts`)),
    );
    const before = new Date(Date.now() - 60_000);
    utimesSync(join(root, dir, 'dist', `${file}.js`), before, before);
  }
  // What the rebase brought: the export the core test imports.
  writeFileSync(join(root, 'packages/contracts/src/fresh.ts'), 'export const fresh = 2;\n');
  const scope = join(root, 'packages/core/node_modules/@forge');
  mkdirSync(scope, { recursive: true });
  symlinkSync(join(root, 'packages/contracts'), join(scope, 'contracts'), 'dir');
  symlinkSync(join(root, 'packages/observability'), join(scope, 'observability'), 'dir');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  spawnSync('git', ['init', '-q'], { cwd: root });
  return root;
}

/**
 * Stands in for vitest: each selected core test is loaded the way vitest loads it, by Node's resolver
 * from the collection's own directory, so `@forge/contracts/<x>` reads contracts' exports into dist.
 */
function loadingSelection(started) {
  return (root, { unit }) =>
    unit.map(({ collection, files }) => {
      started.push(collection.name);
      const specifiers = files.flatMap((f) =>
        [...readFileSync(join(root, f.test), 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]),
      );
      const r = run(
        [
          'node',
          '--input-type=module',
          '-e',
          specifiers.map((s) => `await import('${s}');`).join(''),
        ],
        join(root, collection.cwd),
        { capture: true },
      );
      return {
        scope: collection.name,
        files: files.map((f) => f.test),
        result: r.ok ? 'pass' : 'fail',
        stderr: r.stderr,
      };
    });
}

/**
 * Stands in for pnpm, which a scripts test may not start (the whole-tree guard): `pnpm --filter
 * <name> run build` runs that fixture package's own build script under node in its directory, and
 * every other command runs as it is.
 */
function buildingExec(root) {
  return (argv, cwd, opts) => {
    if (argv[0] !== 'pnpm') return run(argv, cwd, opts);
    const name = argv[argv.indexOf('--filter') + 1];
    for (const dir of ['packages/contracts', 'packages/observability']) {
      const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
      if (manifest.name === name)
        return run(['node', ...manifest.nodeBuild], join(root, dir), opts);
    }
    throw new Error(`no fixture package is named ${name}`);
  };
}

const coreTest = [{ path: 'packages/core/src/fresh.test.ts', change: 'added' }];

describe('after a rebase onto a base adding a contracts export, core tests load it (ISS-587 c1)', () => {
  it('the fixture reproduces the defect: the stale dist lacks the export, so the load fails ERR_MODULE_NOT_FOUND', () => {
    const root = rebasedWorkspace();
    const r = run(
      ['node', '--input-type=module', '-e', "await import('@forge/contracts/fresh');"],
      join(root, 'packages/core'),
      { capture: true },
    );
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('ERR_MODULE_NOT_FOUND');
  });

  it('runDirectTests rebuilds contracts before the core test runs, so the test passes', () => {
    const root = rebasedWorkspace();
    const started = [];
    const out = runDirectTests(root, {
      touched: coreTest,
      integration: false,
      exec: buildingExec(root),
      runSelected: loadingSelection(started),
    });
    expect(out.refusal ?? null).toBeNull();
    expect(started).toEqual(['@forge/core']);
    expect(out.checks.map((c) => [c.scope, c.result, c.stderr ?? ''])).toEqual([
      ['@forge/core', 'pass', ''],
    ]);
    expect(buildMismatch(root, 'packages/contracts')).toBeNull();
  }, 60_000);
});

describe('a package build that cannot match its source stops the run before any test (ISS-587 c2)', () => {
  it('PACKAGE_BUILD_STALE when the rebuild fails: names the package, its stale dist and the command; no test starts', () => {
    const root = rebasedWorkspace({ build: ['-e', 'process.exit(3)'] });
    const started = [];
    const out = runDirectTests(root, {
      touched: coreTest,
      integration: false,
      exec: buildingExec(root),
      runSelected: loadingSelection(started),
    });
    expect(started).toEqual([]);
    expect(out.checks).toEqual([]);
    expect(out.refusal).toContain('PACKAGE_BUILD_STALE');
    expect(out.refusal).toContain('@forge/contracts');
    expect(out.refusal).toContain('packages/contracts/dist/fresh.js is missing');
    expect(out.refusal).toContain('`pnpm --filter @forge/contracts run build` exited 3');
    expect(out.refusal).toContain('@forge/core');
  }, 60_000);

  it('PACKAGE_BUILD_STALE when the build exits 0 and leaves its dist short of the source', () => {
    const root = rebasedWorkspace({ build: ['-e', '0'] });
    const started = [];
    const out = runDirectTests(root, {
      touched: coreTest,
      integration: false,
      exec: buildingExec(root),
      runSelected: loadingSelection(started),
    });
    expect(started).toEqual([]);
    expect(out.refusal).toContain('PACKAGE_BUILD_STALE');
    expect(out.refusal).toContain('still does not match its source');
    expect(out.refusal).toContain('packages/contracts/dist/fresh.js is missing');
  }, 60_000);

  it('PACKAGE_BUILD_STALE when a collection declares a package the checkout does not hold', () => {
    const root = rebasedWorkspace();
    rmSync(join(root, 'packages/observability'), { recursive: true, force: true });
    const out = rebuildPackages(
      root,
      [{ name: '@forge/observability', loadedBy: ['@forge/core'] }],
      {
        exec: run,
      },
    );
    expect(out.refusal).toContain('PACKAGE_BUILD_STALE');
    expect(out.refusal).toContain('no package under packages/ is named @forge/observability');
  });
});

describe('a dist matches its source when every source module is emitted and none is newer', () => {
  it('names a missing emit, then an emit older than its source, then nothing', () => {
    const root = rebasedWorkspace();
    expect(buildMismatch(root, 'packages/contracts')).toBe(
      'packages/contracts/dist/fresh.js is missing for packages/contracts/src/fresh.ts',
    );
    writeFileSync(join(root, 'packages/contracts/dist/fresh.js'), 'export const fresh = 2;\n');
    const before = new Date(Date.now() - 120_000);
    utimesSync(join(root, 'packages/contracts/dist/fresh.js'), before, before);
    expect(buildMismatch(root, 'packages/contracts')).toMatch(
      /^packages\/contracts\/dist\/(fresh|old)\.js is older than packages\/contracts\/src\/(fresh|old)\.ts$/,
    );
    const now = new Date();
    for (const f of ['fresh', 'old'])
      utimesSync(join(root, `packages/contracts/dist/${f}.js`), now, now);
    expect(buildMismatch(root, 'packages/contracts')).toBeNull();
  });

  it('a test file is not a module the build emits', () => {
    const root = rebasedWorkspace();
    writeFileSync(join(root, 'packages/contracts/src/fresh.test.ts'), 'export {};\n');
    writeFileSync(join(root, 'packages/contracts/dist/fresh.js'), 'export const fresh = 2;\n');
    const now = new Date();
    utimesSync(join(root, 'packages/contracts/dist/old.js'), now, now);
    expect(buildMismatch(root, 'packages/contracts')).toBeNull();
  });
});

describe('the collections declare every dist build their tests load (drift guard)', () => {
  const pkg = (dir) => JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
  /** True where every export of a package resolves into its dist. */
  const exportsDistOnly = (p) =>
    p.exports !== undefined &&
    Object.values(p.exports)
      .flatMap((t) => (typeof t === 'string' ? [t] : Object.values(t)))
      .filter((t) => !t.endsWith('.d.ts') && !t.startsWith('./src/'))
      .every((t) => t.startsWith('./dist/'));

  it("each collection run from core's directory declares each workspace dependency of core that exports only dist", () => {
    const core = pkg('packages/core');
    const workspaceDeps = Object.keys(core.dependencies ?? {}).filter((d) =>
      String(core.dependencies[d]).startsWith('workspace:'),
    );
    const dirOf = {
      '@forge/contracts': 'packages/contracts',
      '@forge/observability': 'packages/observability',
    };
    const owed = workspaceDeps.filter((d) => {
      if (!dirOf[d]) throw new Error(`core depends on ${d}, which this guard does not place`);
      return exportsDistOnly(pkg(dirOf[d]));
    });
    expect(owed.length).toBeGreaterThan(0);
    for (const c of VITEST_COLLECTIONS.filter((x) => x.cwd === 'packages/core'))
      expect([c.name, [...c.builds].sort()]).toEqual([c.name, [...owed].sort()]);
  });

  it('every collection declares its builds, and each declared package has a build script', () => {
    for (const c of VITEST_COLLECTIONS) {
      expect(Array.isArray(c.builds), c.name).toBe(true);
      for (const name of c.builds) {
        const dir = `packages/${name.replace('@forge/', '')}`;
        expect(pkg(dir).scripts?.build, name).toBeTruthy();
      }
    }
  });
});

describe('what pnpm verify loads from dist (ISS-679)', () => {
  it("declares every package core's own tests load from their builds", () => {
    const core = VITEST_COLLECTIONS.find((c) => c.name === '@forge/core');
    expect([...VERIFY_LOADS_BUILT].sort()).toEqual([...(core?.builds ?? [])].sort());
  });

  it('owes both before verify on a change that selected no test, and nothing its tests already built', () => {
    expect(verifyBuildsOwed([])).toEqual([
      { name: '@forge/observability', loadedBy: ['pnpm verify'] },
      { name: '@forge/contracts', loadedBy: ['pnpm verify'] },
    ]);
    expect(verifyBuildsOwed([{ name: '@forge/contracts' }])).toEqual([
      { name: '@forge/observability', loadedBy: ['pnpm verify'] },
    ]);
    expect(
      verifyBuildsOwed([{ name: '@forge/contracts' }, { name: '@forge/observability' }]),
    ).toEqual([]);
  });
});

describe('a checkout pnpm never installed (ISS-679)', () => {
  it('is refused NOT_INSTALLED naming the install to run, and passes once pnpm recorded one', () => {
    const root = mkdtempSync(join(tmpdir(), 'package-builds-install-'));
    made.push(root);
    const refusal = installRefusal(root);
    expect(refusal).toMatch(/^NOT_INSTALLED: /);
    expect(refusal).toContain('node_modules/.modules.yaml is missing');
    expect(refusal).toContain('pnpm install --frozen-lockfile');
    mkdirSync(join(root, 'node_modules'));
    expect(installRefusal(root)).toMatch(/^NOT_INSTALLED: /);
    writeFileSync(join(root, 'node_modules', '.modules.yaml'), 'layoutVersion: 5\n');
    expect(installRefusal(root)).toBeNull();
  });
});
