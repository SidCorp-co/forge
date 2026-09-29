import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { globToRegExp, parseConfig } from './config.mjs';
import { judgeEligibility } from './eligibility.mjs';

const good = {
  check: 'ci-passed',
  migrations: { dir: 'db/migrations/' },
  gate: { prepare: [], run: ['node', 'gate.mjs'] },
  union: [{ path: 'CHANGELOG.md', reason: 'both entries are meant to stand' }],
  ineligible: {
    paths: [{ glob: 'runner/**', reason: 'runs on three platforms' }],
    linesIn: ['**/*.mjs'],
    lines: [{ pattern: 'process\\.env\\.PATH', reason: 'PATH is process-wide' }],
  },
};

describe('parseConfig', () => {
  it('reads a well-formed file into rules', () => {
    const { config } = parseConfig(JSON.stringify(good), 'x');
    expect(config.migrationsDir).toBe('db/migrations');
    expect(config.union).toEqual(['CHANGELOG.md']);
    expect(config.pathRules[0].re.test('runner/src/a.rs')).toBe(true);
    expect(config.lineRules[0].re.test('process.env.PATH = x')).toBe(true);
  });

  it('refuses an absent file rather than reading it as nothing ineligible', () => {
    expect(parseConfig(null, '.forge/verify-queue.json at abc').refusal).toMatch(
      /no such file.*none is assumed/,
    );
  });

  it('refuses an entry that carries no reason, naming the entry', () => {
    const bad = { ...good, ineligible: { paths: [{ glob: 'x/**' }], lines: [] } };
    expect(parseConfig(JSON.stringify(bad), 'x').refusal).toMatch(
      /ineligible\.paths\[0\] needs a `glob` and a `reason`/,
    );
  });

  it.each([
    [{ union: {} }, '`union` must be a list of entries'],
    [{ ineligible: { paths: {} } }, '`ineligible.paths` must be a list of entries'],
    [{ ineligible: { paths: [], lines: 'x' } }, '`ineligible.lines` must be a list of entries'],
    [{ ineligible: [] }, '`ineligible` must be an object of `paths`, `lines` and `linesIn`'],
    [{ ineligible: undefined }, '`ineligible` must be an object of `paths`, `lines` and `linesIn`'],
    [{ ineligible: { lines: [] } }, '`ineligible.paths` must be a list of entries'],
    [{ ineligible: { paths: [] } }, '`ineligible.lines` must be a list of entries'],
  ])('refuses %j by name rather than throwing', (patch, why) => {
    expect(parseConfig(JSON.stringify({ ...good, ...patch }), 'x').refusal).toBe(`x: ${why}`);
  });

  it.each(['null', '[]', '"x"'])('refuses the document %s as not one object', (text) => {
    expect(parseConfig(text, 'x').refusal).toBe('x: the declarations must be one JSON object');
  });

  it.each([
    [{ gate: undefined }, '`gate.run` must name the command'],
    [{ gate: { run: ['node'] } }, '`gate.prepare` must be a list of argv lists'],
    [{ gate: { run: [] } }, '`gate.run` must name the command'],
    [
      { gate: { run: ['node'], prepare: ['pnpm install'] } },
      '`gate.prepare` must be a list of argv lists',
    ],
  ])('refuses the gate %j by name', (patch, why) => {
    expect(parseConfig(JSON.stringify({ ...good, ...patch }), 'x').refusal).toContain(why);
  });

  it('refuses a pattern that does not compile', () => {
    const bad = {
      ...good,
      ineligible: { paths: [], lines: [{ pattern: '(', reason: 'a reason long enough' }] },
    };
    expect(parseConfig(JSON.stringify(bad), 'x').refusal).toMatch(
      /lines\[0\]\.pattern does not compile/,
    );
  });

  it('refuses a file naming no required check', () => {
    const { check, ...rest } = good;
    void check;
    expect(parseConfig(JSON.stringify(rest), 'x').refusal).toMatch(/`check` must name/);
  });

  it('parses the declarations this repository ships', () => {
    const text = readFileSync(
      new URL('../../../.forge/verify-queue.json', import.meta.url),
      'utf8',
    );
    const read = parseConfig(text, '.forge/verify-queue.json');
    expect(read.refusal).toBeUndefined();
    expect(read.config.check).toBe('ci-passed');
  });

  it.each([
    'eslint.config.mjs',
    'scripts/verify.mjs',
    'scripts/check-comment-budget.mjs',
    'scripts/lib/debt-ratchet.mjs',
  ])('sends a change to the gate-wide surface %s to the whole gate', (path) => {
    const text = readFileSync(
      new URL('../../../.forge/verify-queue.json', import.meta.url),
      'utf8',
    );
    const { config } = parseConfig(text, '.forge/verify-queue.json');
    const refusals = judgeEligibility({ issue: 'ISS-9', files: [{ path, added: [] }] }, config);
    expect(refusals.map((r) => r.message).join('\n')).toContain(`ISS-9 touches ${path}`);
  });
});

describe('globToRegExp', () => {
  it.each([
    ['**/package.json', 'package.json', true],
    ['**/package.json', 'packages/core/package.json', true],
    ['**/package.json', 'packages/core/package.jsonx', false],
    ['packages/runner/**', 'packages/runner/crates/a.rs', true],
    ['packages/runner/**', 'packages/runner-x/a.rs', false],
    ['**/vitest*.config.*', 'packages/core/vitest.integration.config.ts', true],
    ['scripts/lib/whole-tree-*.mjs', 'scripts/lib/whole-tree-guard.mjs', true],
    ['scripts/lib/whole-tree-*.mjs', 'scripts/lib/sub/whole-tree-guard.mjs', false],
  ])('%s against %s is %s', (glob, path, want) => {
    expect(globToRegExp(glob).test(path)).toBe(want);
  });
});
