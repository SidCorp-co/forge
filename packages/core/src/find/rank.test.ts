// ISS-1256: every arm fused by reciprocal rank into one order, faceted before it is filtered, and
// grouped by type with each group where its best hit ranks.
// @direct-test-of packages/core/src/find/rank.ts
// @direct-test-of packages/core/src/lib/search-fusion.ts

import type { FindType } from '@forge/contracts/find';
import { describe, expect, it } from 'vitest';
import { fuseRanked } from '../lib/search-fusion.js';
import type { Candidate } from './candidate.js';
import { fuseArms, shapeResult } from './rank.js';

const c = (type: FindType, ref: string, extra: Partial<Candidate> = {}): Candidate => ({
  id: `${type}:${ref}`,
  type,
  ref,
  key: null,
  title: ref,
  text: `${ref} text`,
  projectId: 'p',
  status: null,
  placed: null,
  score: 0,
  arm: 'keyword',
  ...extra,
});

const ctx = {
  modules: new Map([
    ['L-exec', { slug: 'execution', name: 'Execution', path: 'execution/devices' }],
  ]),
  placements: new Map([['term:runslots', 'L-exec']]),
  projectSlugs: new Map([['p', 'forge']]),
  openPath: (id: string) => `/open/${id}`,
};

describe('fuseRanked', () => {
  it('sums each list’s weighted reciprocal rank and keeps a hit once', () => {
    const fused = fuseRanked(
      [
        {
          hits: [
            { id: 'a', score: 9 },
            { id: 'b', score: 8 },
          ],
          weight: 0.5,
        },
        { hits: [{ id: 'b', score: 1 }], weight: 0.5 },
      ],
      10,
    );
    expect(fused.map((h) => h.id)).toEqual(['b', 'a']);
    expect(fused[0]?.score).toBeCloseTo(0.5 / 62 + 0.5 / 61);
  });
});

describe('fuseArms', () => {
  it('ranks the term an alias named above a hit topping both keyword and dense arms', () => {
    const fused = fuseArms([
      { arm: 'keyword', hits: [c('rule', 'one-slot'), c('term', 'runslots')] },
      { arm: 'semantic', hits: [c('rule', 'one-slot')] },
      { arm: 'alias', hits: [c('term', 'runslots', { arm: 'alias', alias: 'chia slot' })] },
    ]);
    expect(fused.map((h) => h.id)).toEqual(['term:runslots', 'rule:one-slot']);
    expect(fused[0]).toMatchObject({ arms: ['alias', 'keyword'], matchedAlias: 'chia slot' });
    expect(fused[1]?.arms).toEqual(['keyword', 'semantic']);
  });
});

describe('shapeResult', () => {
  const fused = fuseArms([
    { arm: 'alias', hits: [c('term', 'runslots', { alias: 'chia slot' })] },
    {
      arm: 'keyword',
      hits: [
        c('issue', 'i1', { status: 'open' }),
        c('rule', 'r1'),
        c('issue', 'i2', { status: 'closed' }),
      ],
    },
  ]);

  it('gives each hit its tree path, Unplaced where no module holds it', () => {
    const { groups } = shapeResult(fused, { limit: 20 }, ctx);
    expect(groups[0]?.hits[0]).toMatchObject({
      id: 'term:runslots',
      path: ['Execution', 'Terms'],
      module: { slug: 'execution' },
      open: '/open/term:runslots',
      projectSlug: 'forge',
      match: { alias: 'chia slot' },
    });
    expect(groups.find((g) => g.type === 'rule')?.hits[0]?.path).toEqual(['Unplaced', 'Rules']);
  });

  it('orders groups by their best hit, so the first hit of the first group is the best', () => {
    const { groups } = shapeResult(fused, { limit: 20 }, ctx);
    expect(groups.map((g) => g.type)).toEqual(['term', 'issue', 'rule']);
    expect(groups[1]?.hits.map((h) => h.ref)).toEqual(['i1', 'i2']);
  });

  it('counts facets over every hit, then filters by type, module and status', () => {
    const shaped = shapeResult(fused, { type: ['issue'], status: ['open'], limit: 20 }, ctx);
    expect(shaped.total).toBe(1);
    expect(shaped.groups[0]?.hits.map((h) => h.ref)).toEqual(['i1']);
    expect(shaped.facets.type).toContainEqual({ value: 'issue', label: 'Issues', count: 2 });
    expect(shaped.facets.module).toEqual([
      { value: 'unplaced', label: 'Unplaced', count: 3 },
      { value: 'execution', label: 'Execution', count: 1 },
    ]);
    expect(shapeResult(fused, { module: ['execution'], limit: 20 }, ctx).total).toBe(1);
    expect(shapeResult(fused, { module: ['unplaced'], limit: 20 }, ctx).total).toBe(3);
  });

  it('cuts to the limit after filtering', () => {
    expect(shapeResult(fused, { limit: 2 }, ctx).total).toBe(2);
  });
});
