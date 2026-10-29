// @gate-input whole-tree — it runs the workspace's tsgo on a fixture, a program the guard cannot read
// @direct-test-of scripts/tc-changed.mjs
//
// The typecheck a dev merge runs reads each package's test files too (ISS-754): a type error
// confined to a test file is red under the package's tsconfig.test.json, naming the file and the
// error, while its source config stays green. Driven over a fixture package with the workspace's
// own compiler, so what goes red is what tc-changed runs.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configsOf, typecheckPackage } from './tc-check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = join(ROOT, 'node_modules', '.bin', 'tsgo');

const SOURCE_CONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    lib: ['ES2022'],
    types: [],
    strict: true,
    skipLibCheck: true,
  },
  include: ['src/**/*'],
  exclude: ['**/*.test.ts'],
};
const TEST_CONFIG = { extends: './tsconfig.json', include: ['src/**/*'], exclude: [] };

let root;
let cacheDir;

/** Write `files` (path relative to the fixture root → text), making each parent directory. */
function write(files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof text === 'string' ? text : JSON.stringify(text));
  }
}

const check = (dir) => typecheckPackage(root, { dir }, { bin, engine: 'tsgo', cacheDir });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-check-'));
  cacheDir = join(root, '.tc-cache');
  mkdirSync(cacheDir);
  write({
    'packages/both/tsconfig.json': SOURCE_CONFIG,
    'packages/both/tsconfig.test.json': TEST_CONFIG,
    'packages/both/src/count.ts': 'export const count: number = 1;\n',
    'packages/both/src/count.test.ts':
      "import { count } from './count';\nexport const label: string = count;\n",
    'packages/source-only/tsconfig.json': SOURCE_CONFIG,
    'packages/source-only/src/count.ts': 'export const count: number = 1;\n',
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('a package typechecked as a dev merge checks it', () => {
  it('the workspace compiler the probe drives is installed', () => {
    expect(existsSync(bin)).toBe(true);
  });

  it('is checked under its source config and its test config', () => {
    expect(configsOf(root, 'packages/both')).toEqual(['tsconfig.json', 'tsconfig.test.json']);
  });

  it('a type error in a test file alone is red under the test config, naming the file and the error', async () => {
    const results = await check('packages/both');
    const byConfig = Object.fromEntries(results.map((r) => [r.config, r]));
    expect(byConfig['tsconfig.json'].code).toBe(0);
    expect(byConfig['tsconfig.test.json'].code).not.toBe(0);
    expect(byConfig['tsconfig.test.json'].out).toContain('packages/both/src/count.test.ts');
    expect(byConfig['tsconfig.test.json'].out).toContain('TS2322');
  });

  it('is green under both once the test file is fixed', async () => {
    write({
      'packages/both/src/count.test.ts':
        "import { count } from './count';\nexport const label: string = String(count);\n",
    });
    const results = await check('packages/both');
    expect(results.map((r) => [r.config, r.code])).toEqual([
      ['tsconfig.json', 0],
      ['tsconfig.test.json', 0],
    ]);
  });

  it('a package with no test config is checked under its source config alone', async () => {
    expect(configsOf(root, 'packages/source-only')).toEqual(['tsconfig.json']);
    const results = await check('packages/source-only');
    expect(results.map((r) => [r.config, r.code])).toEqual([['tsconfig.json', 0]]);
  });
});
