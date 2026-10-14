import { describe, expect, it } from 'vitest';
import { neighbourFault, type ScoredHit } from './neighbour-ties.js';

const hit = (sourceRef: string, score: number): ScoredHit => ({ sourceRef, score });

// The circle of twelve issues the neighbours test seeds: from one seed the points sit in equal
// pairs either side of it, and a list of ten keeps one of the last pair and drops the other.
const COS = [1, 0.866025, 0.5, 0, -0.5, -0.866025];
const stored = [
  hit('self', COS[0] as number),
  hit('a1', COS[1] as number),
  hit('a2', COS[1] as number),
  hit('b1', COS[2] as number),
  hit('b2', COS[2] as number),
  hit('c1', COS[3] as number),
  hit('c2', COS[3] as number),
  hit('d1', COS[4] as number),
  hit('d2', COS[4] as number),
  hit('e1', COS[5] as number),
];
// The same search answered again: the tied pairs swap places and the cut keeps the other of the last pair.
const fresh = [
  hit('self', COS[0] as number),
  hit('a2', COS[1] as number),
  hit('a1', COS[1] as number),
  hit('b2', COS[2] as number),
  hit('b1', COS[2] as number),
  hit('c2', COS[3] as number),
  hit('c1', COS[3] as number),
  hit('d2', COS[4] as number),
  hit('d1', COS[4] as number),
  hit('e2', COS[5] as number),
];

describe('neighbourFault', () => {
  it('is a real disagreement for an ordered comparison, which is what failed in CI', () => {
    expect(stored.map((h) => h.sourceRef)).not.toEqual(fresh.map((h) => h.sourceRef));
  });

  it('agrees when only the order inside equal scores and the member cut inside a tie differ', () => {
    expect(neighbourFault(stored, fresh)).toBeNull();
  });

  it('agrees on identical lists', () => {
    expect(neighbourFault(stored, stored)).toBeNull();
  });

  it('refuses a different score ladder, naming both', () => {
    const lower = fresh.map((h, i) => (i === 3 ? hit(h.sourceRef, 0.4) : h));
    expect(neighbourFault(stored, lower)).toMatch(/^score ladders differ/);
  });

  it('refuses a list one hit shorter', () => {
    expect(neighbourFault(stored, fresh.slice(0, 9))).toMatch(/^score ladders differ/);
  });

  it('refuses a different hit above the lowest kept score', () => {
    const swapped = fresh.map((h) => (h.sourceRef === 'c1' ? hit('c3', h.score) : h));
    expect(neighbourFault(stored, swapped)).toMatch(/^hits above the lowest kept score differ/);
  });
});
