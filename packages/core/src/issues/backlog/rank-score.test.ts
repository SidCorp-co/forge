import { describe, expect, it } from 'vitest';
import { ageInDays, ageTermOf, moduleTermOf, staticScoreOf, withAge } from './rank-score.js';
import { BUILT_IN_RANK_WEIGHTS } from './rank-weights.js';

const W = BUILT_IN_RANK_WEIGHTS;
const none = { said: 'no rank.module table', points: 0 };
const bare = { priority: null, category: null, complexity: null, reopenCount: 0 };

describe('staticScoreOf — the CLI arithmetic, term by term', () => {
  it('sums priority, kind, complexity, module, reopened and blocks, in the order they print', () => {
    const { total, parts } = staticScoreOf(
      { priority: 'high', category: 'bug', complexity: 's', reopenCount: 2 },
      2,
      none,
      W,
    );
    expect(parts.map((p) => p.name)).toEqual([
      'priority',
      'kind',
      'complexity',
      'module',
      'reopened',
      'blocks',
    ]);
    expect(total).toBe(30 + 8 + 6 + 0 + 5 + 6);
  });

  it('scores a missing priority as none, a missing kind as feature and a missing complexity as unset', () => {
    const { total, parts } = staticScoreOf(bare, 0, none, W);
    expect(total).toBe(0);
    expect(parts[2]?.said).toContain('unset');
  });

  it('gives an unknown row zero rather than a guess, and counts reopened once however often', () => {
    const odd = staticScoreOf(
      { priority: 'urgent', category: 'chore', complexity: 'm', reopenCount: 9 },
      0,
      none,
      W,
    );
    expect(odd.parts[0]?.points).toBe(0);
    expect(odd.parts[1]?.points).toBe(0);
    expect(odd.parts[4]?.points).toBe(W.reopened);
  });

  it('weighs each chained issue at the blocks weight', () => {
    const at = (n: number) => staticScoreOf(bare, n, none, W).total;
    expect(at(4) - at(0)).toBe(4 * W.blocks);
  });
});

describe('moduleTermOf says what it read', () => {
  const modules = [{ id: 'a', name: 'core', parentId: null }];

  it('says there is no table, or no module, instead of scoring as if a row answered', () => {
    expect(moduleTermOf(null, modules, null)).toEqual(none);
    expect(moduleTermOf(null, [], { unset: 3 })).toMatchObject({
      said: 'no module defined',
      points: 0,
    });
  });

  it('scores the module row and names an issue with none as unset', () => {
    expect(moduleTermOf(modules[0] ?? null, modules, { core: 6, unset: 1 })).toEqual({
      said: 'core',
      points: 6,
    });
    expect(moduleTermOf(null, modules, { unset: 1 })).toMatchObject({ points: 1 });
  });
});

describe('age', () => {
  const day = 86_400_000;

  it('counts whole days and never goes negative', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    expect(ageInDays(new Date(now.getTime() - 3.9 * day), now)).toBe(3);
    expect(ageInDays(new Date(now.getTime() + 5 * day), now)).toBe(0);
    expect(ageInDays(new Date('nonsense'), now)).toBe(0);
  });

  it('scales per day and stops at the ceiling when one is set', () => {
    expect(ageTermOf(10, { ...W, agePerDay: 2 }).points).toBe(20);
    expect(ageTermOf(10, { ...W, agePerDay: 2, ageCap: 12 }).points).toBe(12);
    expect(ageTermOf(10, { ...W, ageCap: 0 }).points).toBe(0);
  });

  it('is placed after the module term', () => {
    const stored = staticScoreOf(bare, 0, none, W).parts;
    const names = withAge(stored, ageTermOf(1, W)).map((p) => p.name);
    expect(names.indexOf('age')).toBe(names.indexOf('module') + 1);
  });
});
