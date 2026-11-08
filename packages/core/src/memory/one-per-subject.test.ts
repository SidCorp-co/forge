// REQ-89 BC-2 (ISS-1156): recall answers a subject once, by its newest entry, at the best rank any of
// its entries held, and the slot its duplicates took goes to the next subject.
// @direct-test-of packages/core/src/memory/one-per-subject.ts

import { describe, expect, it } from 'vitest';
import { foldBySubject } from './one-per-subject.js';
import type { MemoryHit } from './search.js';

const hit = (id: string, asOfDay: number): MemoryHit =>
  ({
    id,
    source: 'note',
    sourceRef: `ref/${id}`,
    text: id,
    metadata: {},
    score: 1,
    embeddedAt: new Date(0),
    writtenAt: new Date(0),
    asOf: new Date(Date.UTC(2026, 10, asOfDay)),
    verifiedAt: null,
    curation: {
      type: 'fact',
      scope: 'x',
      recheckWhen: null,
      value: null,
      endsWhen: null,
      owed: [],
    },
    stale: false,
  }) as MemoryHit;

describe('one hit per subject', () => {
  it('answers a subject held three times once, by its newest entry, at the best rank, naming the others', () => {
    const hits = [hit('old', 1), hit('other', 5), hit('newest', 8), hit('mid', 4)];
    const { hits: out, folded } = foldBySubject(hits, [
      ['old', 'mid'],
      ['mid', 'newest'],
    ]);
    expect(out.map((h) => h.id)).toEqual(['newest', 'other']);
    expect(out[0]?.duplicates?.sort()).toEqual(['mid', 'old']);
    expect(out[1]?.duplicates).toBeUndefined();
    expect(folded).toBe(2);
  });

  it('leaves hits of distinct subjects as they were', () => {
    const hits = [hit('a', 1), hit('b', 2)];
    expect(foldBySubject(hits, [])).toEqual({ hits, folded: 0 });
  });
});
