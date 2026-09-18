/**
 * The instrument, not an afterthought: 66 real leads, labelled by hand, read
 * against the screen by exact equality.
 *
 * The shape is `status-assertions.test.ts` over `comment-corpus.json` — the
 * suite this project already trusts for a rule that reads prose — and the
 * property that matters is the same one: a screen that admitted everything
 * would satisfy every abstention case a corpus of easy rows could hold, so the
 * floor below is what stops one passing (ISS-1089).
 */

import { describe, expect, it } from 'vitest';
import { ROLE_PRODUCT, ROLE_TECHNICAL } from './audiences.js';
import corpus from './lead-corpus.json' with { type: 'json' };
import { screenLead } from './record-screen.js';

const read = (lead: string, audience: string): string[] => {
  const verdict = screenLead(lead, audience);
  return verdict.ok ? [] : verdict.refusals.map((r) => r.rule);
};

describe('the export the corpus is drawn from', () => {
  it('records where every row came from', () => {
    expect(corpus.rows.length).toBeGreaterThanOrEqual(50);
    for (const row of corpus.rows) {
      expect(row.commentId).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.onIssue).toMatch(/^ISS-\d+$/);
      expect(row.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(row.lead.length).toBeGreaterThan(24);
    }
  });

  it('says what was taken and how it was reviewed', () => {
    expect(corpus.rule.length).toBeGreaterThan(200);
    expect(corpus.reviewed.length).toBeGreaterThan(200);
  });

  // cm:guard the floor is the whole point. A `no-developer-detail` whose check returned no breaks,
  // or a `screenLead` that resolved every project to the technical cell, would satisfy every
  // admitted row above and this case alone would red. Measured when it was written: 20 of 66.
  it('holds enough refused leads that a screen admitting everything cannot pass', () => {
    const refused = corpus.rows.filter((r) => r.product.length > 0);
    expect(refused.length).toBeGreaterThanOrEqual(15);
  });

  // cm:guard and the inverse floor, for a screen that refused everything: a rule that broke on all
  // input would satisfy the case above and red only here.
  it('holds enough admitted leads that a screen refusing everything cannot pass', () => {
    const admitted = corpus.rows.filter((r) => r.product.length === 0);
    expect(admitted.length).toBeGreaterThanOrEqual(30);
  });

  it('holds rows the two lenses read differently, so the lens is exercised by real text', () => {
    const differ = corpus.rows.filter(
      (r) => JSON.stringify(r.product) !== JSON.stringify(r.technical),
    );
    expect(differ.length).toBeGreaterThanOrEqual(15);
  });
});

describe('every labelled lead, read against the cell its project resolves to', () => {
  it.each(corpus.rows.map((r, at) => [at, r] as const))(
    'row %i is read as its label says, under both lenses',
    (_at, row) => {
      expect({
        lead: row.lead,
        product: read(row.lead, ROLE_PRODUCT),
        technical: read(row.lead, ROLE_TECHNICAL),
      }).toEqual({
        lead: row.lead,
        product: row.product,
        technical: row.technical,
      });
    },
  );
});
