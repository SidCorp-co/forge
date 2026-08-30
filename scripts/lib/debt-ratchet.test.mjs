import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileTotal,
  freezeFaults,
  loadBaseline,
  parseMode,
  readManifest,
  scopeConfig,
  sortDeep,
  stagedFiles,
  total,
  tunedConfig,
  writeBaseline,
} from './debt-ratchet.mjs';

const roots = [];

/** A throwaway repo root; `manifest` undefined writes no `.forge/conformance.json` at all. */
function repo(manifest) {
  const root = mkdtempSync(join(tmpdir(), 'debt-ratchet-'));
  roots.push(root);
  if (manifest !== undefined) {
    mkdirSync(join(root, '.forge'), { recursive: true });
    writeFileSync(
      join(root, '.forge', 'conformance.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    );
  }
  return root;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('freeze', () => {
  it('refuses a file that gained a diagnostic', () => {
    const faults = freezeFaults({ 'a.ts': { r: 3 } }, { 'a.ts': { r: 2 } });
    expect(faults).toEqual([{ file: 'a.ts', reasons: ['r: 3 (baseline allowed 2)'] }]);
  });

  it('lets a file keep the debt it was frozen with', () => {
    expect(freezeFaults({ 'a.ts': { r: 2 } }, { 'a.ts': { r: 2 } })).toEqual([]);
  });

  it('refuses a rule the file was never frozen for, even when its total is unchanged', () => {
    const faults = freezeFaults({ 'a.ts': { other: 2 } }, { 'a.ts': { r: 2 } });
    expect(faults[0].reasons).toEqual(['other: 2 (baseline allowed 0)']);
  });

  it('refuses a file absent from the baseline entirely', () => {
    const faults = freezeFaults({ 'new.ts': { declaration: 15 } }, {});
    expect(faults[0].reasons).toEqual(['declaration: 15 (baseline allowed 0)']);
  });

  // cm:guard the reviewer's finding on ISS-848, made executable: this is the ONE input where the shared freeze is looser than the bespoke check-test-signal it replaced, which faulted on any unbaselined file unconditionally. It is unreachable while both test-signal ratios exceed 0, and the assertion below is what turns tuning one to 0 from a silent loosening into a red test.
  it('does not fault an all-zero entry, which is the bound on the rule above', () => {
    expect(freezeFaults({ 'a.ts': { declaration: 0, mock: 0 } }, {})).toEqual([]);
    expect(freezeFaults({ 'a.ts': { declaration: 0, mock: 1 } }, {})).toHaveLength(1);
  });

  it('judges only the staged set when one is given', () => {
    const measured = { 'a.ts': { r: 9 }, 'b.ts': { r: 9 } };
    const faults = freezeFaults(measured, {}, new Set(['b.ts']));
    expect(faults.map((f) => f.file)).toEqual(['b.ts']);
  });

  // cm:why the two-metric case is check-test-signal's whole shape — a file may improve on declaration while regressing on mock, and reporting only the first metric that moved would let the second land silently
  it('names every metric that rose, not the first', () => {
    const faults = freezeFaults(
      { 'a.ts': { declaration: 1, mock: 40 } },
      { 'a.ts': { declaration: 9, mock: 30 } },
    );
    expect(faults[0].reasons).toEqual(['mock: 40 (baseline allowed 30)']);
  });
});

describe('readManifest', () => {
  it('distinguishes an absent file from an unparseable one', () => {
    expect(readManifest(repo()).error).toMatch(/could not be read/);
    expect(readManifest(repo('{ not json')).error).toMatch(/not valid JSON/);
  });

  it('degrades an absent file to an empty manifest only when the caller says it may', () => {
    const root = repo();
    expect(readManifest(root, { required: false })).toEqual({ manifest: {} });
    expect(readManifest(root, { required: true }).error).toBeDefined();
  });

  // cm:guard `required: false` must NOT also swallow an unparseable file. A checker that degrades to its defaults on a manifest someone half-edited runs the built-in scope rather than the declared one and reports clean over it — the absent-file case is a documented degrade, a corrupt one never is.
  it('still refuses an unparseable file when absence is allowed', () => {
    expect(readManifest(repo('{ not json'), { required: false }).error).toMatch(/not valid JSON/);
  });
});

describe('scopeConfig', () => {
  it('returns the declared scopes', () => {
    const root = repo({ checkers: { 'lint-budget': { scopes: [{ cwd: 'packages/core' }] } } });
    expect(scopeConfig(root, 'lint-budget').scopes).toEqual([{ cwd: 'packages/core' }]);
  });

  it('refuses a missing key, a non-array and an empty list, each by name', () => {
    expect(scopeConfig(repo({ checkers: {} }), 'lint-budget').error).toMatch(/no checkers/);
    expect(scopeConfig(repo({ checkers: { x: { scopes: 3 } } }), 'x').error).toMatch(/no checkers/);
    expect(scopeConfig(repo({ checkers: { x: { scopes: [] } } }), 'x').error).toMatch(/empty x/);
  });

  // cm:guard an absent manifest is a broken checkout for a scope list, never a degrade. Falling back here would measure a built-in directory the manifest never declared, which is how check-lint-budget once demoted itself to web-v2-only at exit 0.
  it('refuses an absent manifest rather than inventing a scope', () => {
    expect(scopeConfig(repo(), 'lint-budget').error).toMatch(/could not be read/);
  });
});

describe('tunedConfig', () => {
  it('overlays the declared block on the built-in defaults', () => {
    const root = repo({ checkers: { 'test-signal': { minAssertions: 5 } } });
    const { config } = tunedConfig(root, 'test-signal', { minAssertions: 20, mockRatio: 0.7 });
    expect(config).toEqual({ minAssertions: 5, mockRatio: 0.7 });
  });

  // cm:edge contract -> .forge/conformance.json — that file's own `$comment` promises deleting a checker's block degrades to its built-in behaviour; this is the reader that keeps the promise, so removing it makes the manifest describe something no code does
  it('degrades to the defaults when the block or the whole manifest is absent', () => {
    const defaults = { minAssertions: 20 };
    expect(tunedConfig(repo({ checkers: {} }), 'test-signal', defaults).config).toEqual(defaults);
    expect(tunedConfig(repo(), 'test-signal', defaults).config).toEqual(defaults);
  });

  it('refuses an unparseable manifest instead of silently using the defaults', () => {
    expect(tunedConfig(repo('{'), 'test-signal', {}).error).toMatch(/not valid JSON/);
  });
});

describe('loadBaseline', () => {
  it('separates absent from unreadable, because only one of them may report clean', () => {
    const root = repo();
    expect(loadBaseline(join(root, 'nope.json'))).toEqual({});
    const bad = join(root, 'bad.json');
    writeFileSync(bad, '{ half');
    expect(loadBaseline(bad)).toBeNull();
  });

  it('round-trips what writeBaseline wrote, newline-terminated', () => {
    const path = join(repo(), 'b.json');
    writeBaseline(path, { files: { 'a.ts': { r: 1 } } });
    expect(loadBaseline(path)).toEqual({ files: { 'a.ts': { r: 1 } } });
  });
});

describe('sortDeep', () => {
  it('orders both levels so a re-freeze diffs as the counts that moved', () => {
    const sorted = sortDeep({ 'b.ts': { mock: 1, declaration: 2 }, 'a.ts': { r: 1 } });
    expect(Object.keys(sorted)).toEqual(['a.ts', 'b.ts']);
    expect(Object.keys(sorted['b.ts'])).toEqual(['declaration', 'mock']);
  });
});

describe('parseMode', () => {
  it('defaults to --all and accepts a declared mode', () => {
    expect(parseMode(['node', 's'], ['--all', '--staged'], 's').mode).toBe('--all');
    expect(parseMode(['node', 's', '--staged'], ['--all', '--staged'], 's').mode).toBe('--staged');
  });

  it('names the script and its modes when the mode is not one of them', () => {
    const { error } = parseMode(['node', 's', '--nope'], ['--all', '--staged'], 'check-x.mjs');
    expect(error).toBe('usage: check-x.mjs [--all|--staged]');
  });
});

describe('totals', () => {
  it('sums a file across metrics and a tree across files', () => {
    expect(fileTotal({ a: 2, b: 3 })).toBe(5);
    expect(total({ 'a.ts': { r: 2 }, 'b.ts': { r: 3, s: 1 } })).toBe(6);
  });

  it('ignores a non-numeric metric rather than producing NaN', () => {
    expect(fileTotal({ a: 2, generatedAt: 'x' })).toBe(2);
  });
});

describe('stagedFiles', () => {
  it('reads the staged set from a real index', () => {
    const root = repo({});
    const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    writeFileSync(join(root, 'a.ts'), '');
    writeFileSync(join(root, 'b.ts'), '');
    git('add', 'a.ts');
    expect(stagedFiles(root).files).toEqual(new Set(['a.ts']));
  });

  // cm:guard a git failure must NOT read as an empty stage. Every caller skips files outside the set, so an empty one makes `--staged` report clean over nothing — a pre-commit hook recorded as having passed because git broke is worse than one that did not run.
  it('reports an error rather than an empty set when git cannot answer', () => {
    const result = stagedFiles(repo({}));
    expect(result.files).toBeUndefined();
    expect(result.error).toMatch(/cannot tell what is staged/);
  });
});
