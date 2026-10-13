import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_RANK_WEIGHTS,
  foldRankWeights,
  type ModuleDefinition,
  moduleWeightOf,
  RankWeightsRefused,
  rankWeightsProblem,
  scoringWeightsHash,
  undefinedModuleKeys,
} from './rank-weights.js';

describe('rankWeightsProblem — a rank object is refused by name', () => {
  it('accepts an override of one weight and an empty object', () => {
    expect(rankWeightsProblem({ priority: { high: 35 } })).toBeNull();
    expect(rankWeightsProblem({})).toBeNull();
    expect(rankWeightsProblem({ ageCap: null, blocks: 5 })).toBeNull();
  });

  it.each(['windowCap', 'readCap'])('names %s as retired rather than ignoring it', (key) => {
    const problem = rankWeightsProblem({ [key]: 30 });
    expect(problem).toContain(`rank.${key}`);
    expect(problem).toContain('retired with ISS-1336');
  });

  it('names an unknown key and lists the weights it does hold', () => {
    const problem = rankWeightsProblem({ prioriti: { high: 1 } });
    expect(problem).toContain('`rank.prioriti` is no weight of this table');
    expect(problem).toContain('priority');
  });

  it('names a table row that does not exist and lists the rows that do', () => {
    const problem = rankWeightsProblem({ priority: { urgent: 50 } });
    expect(problem).toContain('`rank.priority.urgent` names no row');
    expect(problem).toContain('critical');
  });

  it('refuses a non-number where points are expected, boundary values included', () => {
    expect(rankWeightsProblem({ priority: { high: '30' } })).toContain('a number of points');
    expect(rankWeightsProblem({ blocks: Number.NaN })).toContain('`rank.blocks` is a number');
    expect(rankWeightsProblem({ blocks: Number.POSITIVE_INFINITY })).toContain('is a number');
    expect(rankWeightsProblem({ ageCap: 'none' })).toContain('or `null` for no ceiling');
  });

  it('refuses a table given as a single value, and a non-object rank', () => {
    expect(rankWeightsProblem({ kind: 4 })).toContain('is a table of');
    expect(rankWeightsProblem([1])).toContain('`rank` is an object');
    expect(rankWeightsProblem('x')).toContain('`rank` is an object');
  });
});

describe('foldRankWeights', () => {
  it('serves the built-in table where a project stored none', () => {
    expect(foldRankWeights(undefined)).toMatchObject({ from: 'built-in', moduleTable: null });
    expect(foldRankWeights(null).value).toBe(BUILT_IN_RANK_WEIGHTS);
  });

  it('folds one weight over the built-in table and leaves the rest', () => {
    const folded = foldRankWeights({ priority: { high: 35 }, blocks: 9 });
    expect(folded.value.priority).toEqual({ ...BUILT_IN_RANK_WEIGHTS.priority, high: 35 });
    expect(folded.value.blocks).toBe(9);
    expect(folded.value.reopened).toBe(BUILT_IN_RANK_WEIGHTS.reopened);
    expect(BUILT_IN_RANK_WEIGHTS.priority.high).toBe(30);
  });

  it('refuses an illegal object rather than folding what it can', () => {
    expect(() => foldRankWeights({ windowCap: 3 })).toThrow(RankWeightsRefused);
  });

  it('carries the project own module table, none when it set none', () => {
    expect(foldRankWeights({ module: { core: 5 } }).moduleTable).toEqual({ core: 5 });
    expect(foldRankWeights({ blocks: 1 }).moduleTable).toBeNull();
  });
});

describe('scoringWeightsHash', () => {
  const base = BUILT_IN_RANK_WEIGHTS;

  it('is stable for equal tables whatever order the rows were written in', () => {
    const reordered = {
      ...base,
      priority: { none: 0, low: 10, medium: 20, high: 30, critical: 40 },
    };
    expect(scoringWeightsHash(reordered, null)).toBe(scoringWeightsHash(base, null));
  });

  it('moves when a scoring weight moves', () => {
    expect(scoringWeightsHash({ ...base, blocks: 4 }, null)).not.toBe(
      scoringWeightsHash(base, null),
    );
    expect(scoringWeightsHash(base, { core: 1 })).not.toBe(scoringWeightsHash(base, null));
  });

  it('does not move for a weight that scores nothing stored: age, reading, similarity, batchCap', () => {
    const same = scoringWeightsHash(base, null);
    expect(scoringWeightsHash({ ...base, agePerDay: 9, ageCap: 3 }, null)).toBe(same);
    expect(scoringWeightsHash({ ...base, reading: 1, similarity: 0.9, batchCap: 7 }, null)).toBe(
      same,
    );
  });
});

describe('module weights', () => {
  const modules: ModuleDefinition[] = [
    { id: 'a', name: 'platform', parentId: null },
    { id: 'b', name: 'billing', parentId: 'a' },
    { id: 'c', name: 'invoices', parentId: 'b' },
    { id: 'x', name: 'loop-one', parentId: 'y' },
    { id: 'y', name: 'loop-two', parentId: 'x' },
  ];

  it('takes the own row, then the nearest ancestor row, then unset', () => {
    const table = { platform: 7, billing: 3, unset: 1 };
    expect(moduleWeightOf(modules[2] as ModuleDefinition, modules, table)).toMatchObject({
      points: 3,
      via: 'billing',
    });
    expect(moduleWeightOf(modules[0] as ModuleDefinition, modules, table)).toMatchObject({
      points: 7,
      via: null,
    });
    expect(moduleWeightOf(null, modules, table).points).toBe(1);
    expect(moduleWeightOf(modules[2] as ModuleDefinition, modules, { unset: 2 }).points).toBe(2);
  });

  it('ends a parent cycle instead of walking it for ever', () => {
    expect(moduleWeightOf(modules[3] as ModuleDefinition, modules, { unset: 4 }).points).toBe(4);
  });

  it('lists the table keys that name no module, the unset row excepted', () => {
    expect(undefinedModuleKeys({ platform: 1, ghost: 2, unset: 0 }, modules)).toEqual(['ghost']);
  });
});
