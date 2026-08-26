import { describe, expect, it } from 'vitest';
import {
  drainedLine,
  drainFaults,
  drainMatcher,
  freezeFaults,
  mergeOriginal,
} from './lint-budget.mjs';

const CORE = {
  cwd: 'packages/core',
  drain: { include: '^packages/core/src/', exclude: '\\.test\\.tsx?$' },
};
const matchers = [drainMatcher(CORE)];

/** The one argument shape drainFaults takes, with only the interesting part varying. */
const drain = ({ measured = {}, baseline = {}, changed = [], renamed = new Map() }) =>
  drainFaults({ measured, baseline, changed: new Set(changed), renamed, matchers });

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

  it('judges only the staged set when one is given', () => {
    const measured = { 'a.ts': { r: 9 }, 'b.ts': { r: 9 } };
    const faults = freezeFaults(measured, {}, new Set(['b.ts']));
    expect(faults.map((f) => f.file)).toEqual(['b.ts']);
  });
});

describe('drain', () => {
  // cm:guard EQUAL must fail. Non-increase is what every other baseline in this repo already enforces and it is why the codemap baseline sat at 3% drained for months — shipping it under the name "drain" is the substitution a plan review bounced this issue for once.
  it('refuses a touched debt-carrying file whose count did not move', () => {
    const faults = drain({
      measured: { 'packages/core/src/a.ts': { r: 3 } },
      baseline: { 'packages/core/src/a.ts': { r: 3 } },
      changed: ['packages/core/src/a.ts'],
    });
    expect(faults).toHaveLength(1);
    expect(faults[0].reasons[0]).toContain('leave it strictly lower');
  });

  it('accepts a payment of one', () => {
    const faults = drain({
      measured: { 'packages/core/src/a.ts': { r: 2 } },
      baseline: { 'packages/core/src/a.ts': { r: 3 } },
      changed: ['packages/core/src/a.ts'],
    });
    expect(faults).toEqual([]);
  });

  it('sums a payment across rules, so trading one rule for another is not a payment', () => {
    const faults = drain({
      measured: { 'packages/core/src/a.ts': { r: 1, other: 2 } },
      baseline: { 'packages/core/src/a.ts': { r: 3 } },
      changed: ['packages/core/src/a.ts'],
    });
    expect(faults).toHaveLength(1);
  });

  it('holds a file already at zero at zero', () => {
    const faults = drain({
      measured: { 'packages/core/src/a.ts': { r: 1 } },
      baseline: { 'packages/core/src/a.ts': {} },
      changed: ['packages/core/src/a.ts'],
    });
    expect(faults[0].reasons[0]).toContain('a file at zero stays at zero');
  });

  it('requires a new drainable file to be clean', () => {
    const faults = drain({
      measured: { 'packages/core/src/new.ts': { r: 1 } },
      changed: ['packages/core/src/new.ts'],
    });
    expect(faults).toHaveLength(1);
  });

  it('asks nothing of a new drainable file that is clean', () => {
    expect(drain({ changed: ['packages/core/src/new.ts'] })).toEqual([]);
  });

  // cm:guard test-file debt is frozen, never drained. `rows[0]!` in a test is idiomatic and a wrong one is a test failure, not a production crash — the issue's own carve-out, and the reason `exclude` exists rather than a comment saying to be careful.
  it('never asks a test file to pay', () => {
    const faults = drain({
      measured: { 'packages/core/src/a.test.ts': { r: 9 } },
      baseline: { 'packages/core/src/a.test.ts': { r: 9 } },
      changed: ['packages/core/src/a.test.ts'],
    });
    expect(faults).toEqual([]);
  });

  it('never asks a scope with no drain declaration to pay', () => {
    const faults = drainFaults({
      measured: { 'packages/web-v2/src/a.tsx': { r: 9 } },
      baseline: { 'packages/web-v2/src/a.tsx': { r: 9 } },
      changed: new Set(['packages/web-v2/src/a.tsx']),
      renamed: new Map(),
      matchers: [drainMatcher({ cwd: 'packages/web-v2' })].filter(Boolean),
    });
    expect(faults).toEqual([]);
  });

  it('lets a rename carry its debt through unpaid', () => {
    const faults = drain({
      measured: { 'packages/core/src/new.ts': { r: 3 } },
      baseline: { 'packages/core/src/old.ts': { r: 3 } },
      changed: ['packages/core/src/new.ts'],
      renamed: new Map([['packages/core/src/new.ts', 'packages/core/src/old.ts']]),
    });
    expect(faults).toEqual([]);
  });

  it('refuses a rename that gained debt on the way', () => {
    const faults = drain({
      measured: { 'packages/core/src/new.ts': { r: 4 } },
      baseline: { 'packages/core/src/old.ts': { r: 3 } },
      changed: ['packages/core/src/new.ts'],
      renamed: new Map([['packages/core/src/new.ts', 'packages/core/src/old.ts']]),
    });
    expect(faults[0].reasons[0]).toContain('a move may not add debt');
  });

  // cm:guard a registry typo must reach the caller as an error, never as null. Null demotes that scope to freeze-only, so the run stays green while half the contract stopped applying — a checker doing less than it claims, which is the one outcome this whole issue is about.
  it('refuses a drain block with no include pattern', () => {
    expect(() => drainMatcher({ cwd: 'p', drain: {} })).toThrow('declares no include pattern');
  });

  it('refuses a drain pattern that will not compile', () => {
    expect(() => drainMatcher({ cwd: 'p', drain: { include: '^(' } })).toThrow();
  });

  it('asks nothing of a file outside the branch delta', () => {
    const faults = drain({
      measured: { 'packages/core/src/a.ts': { r: 3 } },
      baseline: { 'packages/core/src/a.ts': { r: 3 } },
      changed: [],
    });
    expect(faults).toEqual([]);
  });
});

describe('original', () => {
  // cm:guard the denominator may only ever be ADDED to. Recomputing it makes every percentage relative to the last re-freeze, so the number can never fall and "trending to 0" stays exactly as unfalsifiable as it was before anyone printed it.
  it('keeps an existing original when the current count is lower', () => {
    expect(mergeOriginal({ a: 226 }, new Map([['a', 215]]))).toEqual({ a: 226 });
  });

  it('keeps an existing original when the current count is higher', () => {
    expect(mergeOriginal({ a: 226 }, new Map([['a', 900]]))).toEqual({ a: 226 });
  });

  it('seeds a scope it has never seen', () => {
    expect(mergeOriginal({ a: 226 }, new Map([['b', 12]]))).toEqual({ a: 226, b: 12 });
  });

  it('reports the drained percentage against the original, not the baseline', () => {
    expect(drainedLine('a', 215, 226)).toBe('  a: 215 / 226 original (5% drained)');
  });

  it('says so rather than dividing by nothing', () => {
    expect(drainedLine('a', 215, undefined)).toBe('  a: 215 (no original recorded)');
  });
});
