/**
 * ISS-845 (owner, 2026-10-31, REQ-79 r6): a pass judged at an earlier commit counts at a later landing
 * that descends from it, reported as carried, unless what changed between falls under what it covers.
 * Planted from adminhub-api ISS-78's round 11, which landed again two files on and lost every pass
 * judged at round 10's landing. Pure: what the landing holds of each judged commit is handed in, as
 * `landed-build-holds.ts:earlierCarriageOf` and the record door read it.
 *
 * @direct-test-of packages/core/src/issues/landed-carriage.ts
 */

import { describe, expect, it } from 'vitest';
import type { Carriage, StandingCriterion } from '../issues/index.js';
import { weighOnLanded } from './landed-weighing.js';

const L1 = '1111111111111111111111111111111111111111';
const L2 = '2222222222222222222222222222222222222222';
const ASIDE = '3333333333333333333333333333333333333333';
const CHANGED = ['src/billing/invoice.ts', 'src/billing/tax.ts'];

function judged(
  criterion: number,
  at: string,
  verdict = 'pass',
  covers: readonly string[] | null = null,
): StandingCriterion {
  return {
    criterion,
    verdict: {
      criterion,
      verdict,
      at: { kind: 'source', value: at },
      cited: [],
      unverified: null,
      covers,
    },
  };
}

const descends = (paths?: readonly string[]): ReadonlyMap<string, Carriage> =>
  new Map([[L1, paths ? { kind: 'descends', by: 'recorded', paths } : { kind: 'descends' }]]);

const weigh = (c: StandingCriterion, descent?: ReadonlyMap<string, Carriage>) =>
  weighOnLanded(L2, c, null, null, null, undefined, descent);

describe('a fix round landing two files on keeps the passes of the round before it', () => {
  const criteria = Array.from({ length: 107 }, (_, i) => judged(i + 1, L1));

  it('counts all 107 passes at L1 on L2, each carried naming both commits and the two files', () => {
    const weighed = criteria.map((c) => weigh(c, descends(CHANGED)));

    expect(weighed.filter((w) => w.counts)).toHaveLength(107);
    for (const w of weighed) {
      expect(w).toMatchObject({ counts: true, at: L1 });
      expect(w.counts && w.carried).toBe(
        `carried from \`${L1.slice(0, 12)}\` to \`${L2.slice(0, 12)}\`, which descends from it (recorded); 2 files: \`src/billing/invoice.ts\`, \`src/billing/tax.ts\` changed between them`,
      );
    }
  });

  it('carries on descent alone where the files between were not read, saying so', () => {
    const w = weigh(judged(1, L1), descends());
    expect(w.counts).toBe(true);
    expect(w.counts && w.carried).toContain('what changed between them was not read');
  });

  it('does not carry a pass covering a file that changed, naming the file and the prefix', () => {
    const w = weigh(judged(7, L1, 'pass', ['src/billing/tax.ts']), descends(CHANGED));
    expect(w.counts).toBe(false);
    expect(!w.counts && w.why).toContain(
      `\`${L2.slice(0, 12)}\` changes 1 file: \`src/billing/tax.ts\` since then, under what it covers (\`src/billing/tax.ts\`)`,
    );
  });

  it('carries a pass whose covers sit outside what changed (a prefix is a directory, not a string start)', () => {
    const w = weigh(judged(8, L1, 'pass', ['src/bill', 'src/auth/']), descends(CHANGED));
    expect(w.counts).toBe(true);
  });

  it('does not carry a covering pass where what changed between was not read', () => {
    const w = weigh(judged(9, L1, 'pass', ['src/billing/']), descends());
    expect(w.counts).toBe(false);
    expect(!w.counts && w.why).toContain('what changed between them was not read');
  });

  it('refuses a pass at a commit the landing does not descend from as another build', () => {
    const lacks = new Map<string, Carriage>([[ASIDE, { kind: 'differs', paths: CHANGED }]]);
    const w = weighOnLanded(L2, judged(3, ASIDE), null, null, null, undefined, lacks);
    expect(w.counts).toBe(false);
    expect(!w.counts && w.why).toContain(
      `it was judged at \`${ASIDE.slice(0, 12)}\`, which \`${L2.slice(0, 12)}\` does not descend from, so it judged another build`,
    );
  });

  it('earns nothing where whether the landing descends from it was not read', () => {
    const unread = new Map<string, Carriage>([
      [L1, { kind: 'unread', why: 'no merge mark records the landing 111111111111' }],
    ]);
    const w = weigh(judged(4, L1), unread);
    expect(w.counts).toBe(false);
    expect(!w.counts && w.why).toContain(
      `whether \`${L2.slice(0, 12)}\` descends from it was not read: no merge mark records the landing`,
    );
  });

  it('never carries a fail, and never passes one recorded at the landing itself', () => {
    expect(weigh(judged(5, L1, 'fail'), descends(CHANGED)).counts).toBe(false);
    expect(weigh(judged(5, L2, 'fail'), descends(CHANGED)).counts).toBe(false);
  });

  it('with nothing asked, names the rule a pass at an earlier commit is weighed by', () => {
    const w = weigh(judged(6, L1));
    expect(w.counts).toBe(false);
    expect(!w.counts && w.why).toContain(
      `a pass at an earlier commit counts only where \`${L2.slice(0, 12)}\` is read descending from it`,
    );
  });
});
