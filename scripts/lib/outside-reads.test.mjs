// ISS-134: a test reading a file outside its package by path is refused until it declares the path,
// and a declaration is refused until the `changes` filter of the job running the test matches it.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  ciFiltersOf,
  covered,
  filterMatches,
  homeOf,
  jobOutputsOf,
  judgeOutsideReads,
  readsOf,
} from './outside-reads.mjs';

const ts = createRequire(new URL('../../packages/core/package.json', import.meta.url))(
  'typescript',
);

const CORE_TEST = 'packages/core/src/devices/held.test.ts';
const STATUS = 'packages/runner/crates/runner-transport/src/status.rs';

/** A ci.yml holding the shapes the checker reads: the filter block and each collection's job. */
function ciYml({ core = [], web = [], scripts = [] } = {}) {
  const list = (patterns) => patterns.map((p) => `              - '${p}'`).join('\n');
  return `jobs:
  changes:
    steps:
      - uses: dorny/paths-filter@v4
        with:
          filters: |
            # a comment line the parser skips
            web:
              - 'packages/web-v2/**'
${list(web)}
            core:
              - 'packages/core/**'
${list(core)}
            scripts:
              - 'scripts/**'
${list(scripts)}

  web:
    needs: changes
    if: needs.changes.outputs.scoped != 'true' && (needs.changes.outputs.web == 'true')
  core:
    needs: changes
    if: (needs.changes.outputs.core == 'true' || needs.changes.outputs.scripts == 'true')
  core-integration:
    needs: changes
    if: needs.changes.outputs.core == 'true'
`;
}

const KNOWN = new Set([
  CORE_TEST,
  STATUS,
  'packages/runner/crates/runner-transport/src/lib.rs',
  'packages/core/src/devices/held.ts',
  'scripts/lib/gate.mjs',
  'scripts/split-product-copy.mjs',
]);

const READ_STATUS = `import { readFileSync } from 'node:fs';
const status = readFileSync(
  new URL('../../../runner/crates/runner-transport/src/status.rs', import.meta.url),
  'utf8',
);
`;

function judge(source, { ci = ciYml(), path = CORE_TEST, modules = {} } = {}) {
  const load = (_from, specifier) => modules[specifier] ?? null;
  return judgeOutsideReads({ ts, tests: [{ path, source }], known: KNOWN, load, ciText: ci });
}

describe('a read outside the package', () => {
  it('is refused undeclared, naming the test, its line and the path to declare', () => {
    const { refused } = judge(READ_STATUS);
    expect(refused).toHaveLength(1);
    expect(refused[0].path).toBe(CORE_TEST);
    expect(refused[0].why).toContain(`line 3 reads \`${STATUS}\` outside packages/core/`);
    expect(refused[0].why).toContain(`add \`// @direct-test-of ${STATUS}\``);
  });

  it('passes declared, once the job filter matches the declared path', () => {
    const declared = `// @direct-test-of ${STATUS}\n${READ_STATUS}`;
    expect(judge(declared, { ci: ciYml({ core: [STATUS] }) })).toEqual({ refused: [], reads: 1 });
  });

  it('refuses a declaration the filter of the job running the test does not match', () => {
    const declared = `// @direct-test-of ${STATUS}\n${READ_STATUS}`;
    const { refused } = judge(declared);
    expect(refused).toHaveLength(1);
    expect(refused[0].why).toContain(`declares \`@direct-test-of ${STATUS}\``);
    expect(refused[0].why).toContain('filter of job `core`');
    expect(refused[0].why).toContain(`add \`'${STATUS}'\` under one of core, scripts`);
  });

  it('is read through join, resolve, dirname and a const, in the file and one import away', () => {
    const inFile = `import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
readFileSync(join(ROOT, 'scripts', 'split-product-copy.mjs'), 'utf8');
`;
    expect(
      readsOf({ ts, path: CORE_TEST, source: inFile, known: KNOWN, load: () => null }),
    ).toEqual([
      expect.objectContaining({ target: 'scripts/split-product-copy.mjs', kind: 'file', line: 6 }),
    ]);
    const imported = `import { readFileSync } from 'node:fs';
import { ROOT } from '../../../../scripts/lib/gate.mjs';
readFileSync(\`\${ROOT}/scripts/split-product-copy.mjs\`, 'utf8');
`;
    const gate = {
      path: 'scripts/lib/gate.mjs',
      source:
        "import { dirname, resolve } from 'node:path';\nexport const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..');\n",
    };
    const load = (_from, spec) => (spec.endsWith('gate.mjs') ? gate : null);
    expect(readsOf({ ts, path: CORE_TEST, source: imported, known: KNOWN, load })).toEqual([
      expect.objectContaining({ target: 'scripts/split-product-copy.mjs', kind: 'file' }),
    ]);
  });

  it('counts a directory handed to a call, which only a directory declaration covers', () => {
    const lists = `import { readdirSync } from 'node:fs';
readdirSync(new URL('../../../runner/crates/runner-transport/', import.meta.url));
`;
    const [read] = readsOf({ ts, path: CORE_TEST, source: lists, known: KNOWN, load: () => null });
    expect(read).toMatchObject({ target: 'packages/runner/crates/runner-transport', kind: 'dir' });
    expect(covered([STATUS], read)).toBe(false);
    expect(covered(['packages/runner/'], read)).toBe(true);
  });

  it('is not a read inside the package, of a missing file, of the root, or where no path is built', () => {
    const quiet = `import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
readFileSync(new URL('./held.ts', import.meta.url), 'utf8');
existsSync(new URL('../../../web-v2/Dockerfile', import.meta.url));
readFileSync(new URL('../../../../', import.meta.url));
relative(new URL('../../../runner/', import.meta.url).pathname, 'x');
const read = (p) => readFileSync(join(p, 'status.rs'), 'utf8');
`;
    expect(judge(quiet)).toEqual({ refused: [], reads: 0 });
  });

  it('leaves a whole-tree test to whole-tree-gates, which runs it on every change', () => {
    expect(judge(`// @gate-input whole-tree\n${READ_STATUS}`)).toEqual({ refused: [], reads: 0 });
  });
});

describe('ci.yml', () => {
  it('reads the filters by output and the outputs a job runs on', () => {
    const ci = ciYml({ core: [STATUS] });
    expect(ciFiltersOf(ci).get('core')).toEqual(['packages/core/**', STATUS]);
    expect(jobOutputsOf(ci, 'core')).toEqual(['core', 'scripts']);
    expect(jobOutputsOf(ci, 'nope')).toBeNull();
  });

  it('matches a declared directory only by a pattern covering every file under it', () => {
    expect(filterMatches(['packages/runner/**'], 'packages/runner/crates/')).toBe(true);
    expect(filterMatches(['packages/runner/*.rs'], 'packages/runner/crates/')).toBe(false);
    expect(filterMatches(['.forge/conformance.json'], '.forge/conformance.json')).toBe(true);
  });

  it('refuses a collection whose job runs on no filter, and a file with no filter block', () => {
    const noIf = ciYml().replace("if: needs.changes.outputs.core == 'true'", 'if: always()');
    expect(judge('', { ci: noIf }).refused).toEqual([
      expect.objectContaining({
        why: 'job `core-integration`, which runs the @forge/core integration tests, runs on no `changes` output',
      }),
    ]);
    expect(judge('', { ci: 'jobs: {}\n' }).refused[0].why).toContain('no `dorny/paths-filter`');
  });

  it('places a test in its package, or its top directory outside packages/', () => {
    expect(homeOf(CORE_TEST)).toBe('packages/core/');
    expect(homeOf('scripts/lib/gate.test.mjs')).toBe('scripts/');
  });
});
