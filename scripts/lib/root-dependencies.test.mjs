// @direct-test-of scripts/check-root-dependencies.mjs
// @direct-test-of .forge/conformance.json
// @direct-test-of .arch-tsconfig.json
// @direct-test-of package.json
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './gate.mjs';
import {
  allowanceFaults,
  declaredNames,
  judge,
  nodeModulesTarget,
  packageOf,
  pathMapUses,
  providedBins,
  sourceUses,
  undeclared,
} from './root-dependencies.mjs';

const ROOT_MANIFEST = {
  name: 'forge',
  devDependencies: { '@biomejs/biome': '^2', typescript: '^5', vitest: '^5' },
};
const INSTALLED = {
  '@biomejs/biome': { bin: { biome: 'bin/biome' } },
  typescript: { bin: { tsc: 'bin/tsc', tsserver: 'bin/tsserver' } },
  vitest: { bin: 'vitest.mjs' },
};
const declared = declaredNames(ROOT_MANIFEST);
/** A path under node_modules built from pieces, so this file's own fixtures are no root use. */
const nm = (rest) => ['node_modules', rest].join('/');
const bins = providedBins(declared, (name) => INSTALLED[name] ?? null);

/** What a source reaches that the root manifest above does not cover, as `line what`. */
function refusedIn(text, file = 'scripts/x.mjs') {
  return sourceUses(file, text)
    .uses.map((u) => undeclared(u, declared, bins))
    .filter(Boolean)
    .map((u) => `${u.line} ${u.package ?? `bin:${u.bin}`}`);
}

describe('packageOf', () => {
  it('names the package of a bare specifier, scoped or not, and nothing else', () => {
    expect(packageOf('@biomejs/biome/configuration')).toBe('@biomejs/biome');
    expect(packageOf('hono/http-exception')).toBe('hono');
    expect(packageOf('typescript')).toBe('typescript');
    for (const notOne of ['./a.mjs', '../b', '/abs', '#internal', 'node:fs', 'fs', 'path/posix']) {
      expect(packageOf(notOne)).toBeNull();
    }
    for (const notAName of ['--import', '**', 'HEAD', '@scope'])
      expect(packageOf(notAName)).toBeNull();
  });
});

describe('sourceUses refuses what the manifest does not declare', () => {
  it('a planted import, require, dynamic import and require.resolve each go red by line', () => {
    const text = [
      "import a from 'left-pad';",
      "export { b } from '@acme/kit/sub';",
      "const c = require('chalk');",
      "const d = await import('hono/http-exception');",
      "const e = require.resolve('ajv');",
      "import t from 'typescript';",
    ].join('\n');
    expect(refusedIn(text)).toEqual(['1 left-pad', '2 @acme/kit', '3 chalk', '4 hono', '5 ajv']);
  });

  it('a path into node_modules, by one literal or by join pieces, goes red naming the package', () => {
    const text = [
      "const a = join(ROOT, 'node_modules', 'hono', 'dist');",
      "const b = join(ROOT, 'node_modules', '@acme', 'kit', 'package.json');",
      "const c = 'node_modules/eslint/bin/eslint.js';",
      "const d = join(ROOT, 'node_modules', 'typescript', 'lib');",
    ].join('\n');
    expect(refusedIn(text)).toEqual(['1 hono', '2 @acme/kit', '3 eslint']);
  });

  it('a spawned bin no declared package provides goes red; a provided one does not', () => {
    const text = [
      "spawnSync('pnpm', ['exec', 'prettier', '--check']);",
      "const cmd = ['pnpm', 'exec', 'biome', 'check', 'scripts'];",
      "const tsx = join(ROOT, 'node_modules', '.bin', 'tsx');",
      "const s = 'pnpm exec vitest run';",
      "const n = 'npx eslint .';",
      "spawnSync('pnpm', ['exec', 'tsc', '--noEmit']);",
    ].join('\n');
    expect(refusedIn(text)).toEqual(['1 bin:prettier', '3 bin:tsx', '5 bin:eslint']);
  });

  it('a node loader flag loads its value as a module', () => {
    expect(refusedIn("spawn('node', ['--import', 'tsx', 'a.ts']);")).toEqual(['1 tsx']);
  });

  it('an import written inside a string a test writes as a fixture is a string, not an import', () => {
    const text = [
      'const fixture = "import { fresh } from \'@forge/contracts/fresh\';\\n";',
      "spawnSync('node', ['-e', \"await import('@forge/contracts/fresh');\"]);",
    ].join('\n');
    expect(refusedIn(text)).toEqual([]);
  });

  it('a list of directory names to skip is not a path into node_modules', () => {
    const text = [
      "const SKIP = new Set(['node_modules', 'dist', 'coverage']);",
      "const paths = ['node_modules', 'packages/core/node_modules'];",
      "const ex = join(root, 'node_modules', '**');",
    ].join('\n');
    expect(refusedIn(text)).toEqual([]);
  });

  it('names a bin it cannot read rather than skipping it in silence', () => {
    const { notes } = sourceUses(
      'scripts/x.mjs',
      "const b = join(ROOT, 'node_modules', '.bin', engine);",
    );
    expect(notes).toEqual([{ line: 1, text: expect.stringContaining('cannot read') }]);
  });
});

describe('pathMapUses', () => {
  it('reads each paths target under node_modules, with its line', () => {
    const text = JSON.stringify(
      { compilerOptions: { paths: { '@/*': ['src/*'], 'hono/*': [nm('hono/dist/*')] } } },
      null,
      2,
    );
    const line = text.split('\n').findIndex((l) => l.includes(nm('hono'))) + 1;
    expect(line).toBeGreaterThan(1);
    expect(pathMapUses(text)).toEqual([{ line, how: 'maps `hono/*` into', package: 'hono' }]);
  });
});

describe('nodeModulesTarget', () => {
  it('reads a package or a bin, and nothing from a dot entry', () => {
    expect(nodeModulesTarget('node_modules/.bin/tsx')).toEqual({ bin: 'tsx' });
    expect(nodeModulesTarget(`./${nm('@a/b/x.js')}`)).toEqual({ package: '@a/b' });
    expect(nodeModulesTarget('node_modules/.modules.yaml')).toBeNull();
    expect(nodeModulesTarget('packages/core/node_modules/hono')).toBeNull();
  });
});

describe('judge and the allowance list', () => {
  const hono = { file: '.arch-tsconfig.json', line: 20, package: 'hono' };
  const priced = {
    consumer: '.arch-tsconfig.json',
    package: 'hono',
    why: 'w',
    $costs: 'c',
    endsWhen: 'e',
  };

  it('an allowance excuses only its own consumer and package', () => {
    const elsewhere = { file: 'scripts/x.mjs', line: 3, package: 'hono' };
    const r = judge([hono, elsewhere], [priced]);
    expect(r.excused).toEqual([hono]);
    expect(r.refused).toEqual([elsewhere]);
    expect(r.stale).toEqual([]);
  });

  it('an allowance that covers no use is refused as stale', () => {
    expect(judge([], [priced]).stale).toEqual([priced]);
  });

  it('an allowance without its price, or naming neither package nor bin, is refused by field', () => {
    const faults = allowanceFaults([{ consumer: 'a', package: 'x', why: 'w' }, { consumer: 'b' }]);
    expect(faults).toContain(
      'allowed[0] carries no `$costs` — an allowance is priced or it is not taken',
    );
    expect(faults).toContain(
      'allowed[0] carries no `endsWhen` — an allowance is priced or it is not taken',
    );
    expect(faults).toContain('allowed[1] names neither or both of `package` and `bin`');
    expect(allowanceFaults([priced])).toEqual([]);
  });

  it("this repository's allowances are priced, and each covers a use the map still makes", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, '.forge/conformance.json'), 'utf8'));
    const cfg = manifest.checkers['root-dependencies'];
    expect(allowanceFaults(cfg.allowed)).toEqual([]);
    const uses = pathMapUses(readFileSync(join(ROOT, '.arch-tsconfig.json'), 'utf8'));
    const rootDeclared = declaredNames(
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')),
    );
    const findings = uses
      .map((u) => undeclared(u, rootDeclared, new Map()))
      .filter(Boolean)
      .map((u) => ({ file: '.arch-tsconfig.json', ...u }));
    const { refused, stale } = judge(findings, cfg.allowed);
    expect(refused).toEqual([]);
    expect(stale).toEqual([]);
  });
});
