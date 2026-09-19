import { describe, expect, it } from 'vitest';
import {
  drainedLine,
  drainFaults,
  drainMatcher,
  emptiedScopes,
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

describe('drain', () => {
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

describe('emptiedScopes', () => {
  const at = (o) => new Map(Object.entries(o));

  it('refuses a scope that measured nothing while its baseline holds debt', () => {
    expect(emptiedScopes(at({ 'packages/web-v2': 0 }), at({ 'packages/web-v2': 210 }))).toEqual([
      'packages/web-v2',
    ]);
  });

  it('asks nothing of a scope already frozen at zero', () => {
    expect(emptiedScopes(at({ 'packages/web-v2': 0 }), at({ 'packages/web-v2': 0 }))).toEqual([]);
  });

  it('ignores a scope that still measures debt', () => {
    expect(emptiedScopes(at({ 'packages/core': 277 }), at({ 'packages/core': 280 }))).toEqual([]);
  });

  it('names every emptied scope, not just the first', () => {
    expect(emptiedScopes(at({ a: 0, b: 0, c: 5 }), at({ a: 1, b: 2, c: 5 }))).toEqual(['a', 'b']);
  });

  it('treats a scope absent from the baseline as nothing to protect', () => {
    expect(emptiedScopes(at({ 'packages/new': 0 }), at({}))).toEqual([]);
  });

  it('does NOT catch a scope emptied in part — declared, not closed', () => {
    expect(emptiedScopes(at({ 'packages/web-v2': 186 }), at({ 'packages/web-v2': 210 }))).toEqual(
      [],
    );
    expect(emptiedScopes(at({ 'packages/web-v2': 1 }), at({ 'packages/web-v2': 210 }))).toEqual([]);
  });
});
