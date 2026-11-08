/**
 * ISS-1131 (FB-567 point 3): a requirement criterion carries an optional short title of at most eight
 * words, which its row shows; a longer one is refused by name where the list is planned, and a title
 * left out keeps the one the criterion had, so a writer that carries criteria forward without titles
 * (`room-settle.ts`, `steward-decision.ts`) never drops one.
 *
 * @direct-test-of packages/core/src/requirements/rules.ts
 * @direct-test-of packages/contracts/src/criterion-title.ts
 */

import { describe, expect, it } from 'vitest';
import { type LiveCriterion, planCriteria } from './rules.js';

const NINE = 'Owner sees the review page with every fact once';
const live: LiveCriterion[] = [
  { id: 'c1', code: 'BC-1', body: 'A person signs in.', form: 'statement', title: 'Sign in' },
];

describe('a requirement criterion title', () => {
  it('refuses a title over eight words by name, at its criterion', () => {
    const planned = planCriteria(
      [{ body: 'The review page shows each fact once.', title: NINE }],
      [],
      0,
    );
    expect(planned.ok, 'a nine-word title was accepted').toBe(false);
    if (planned.ok) return;
    expect(planned.refusals).toEqual([
      expect.objectContaining({ code: 'CRITERION_TITLE_TOO_LONG', path: '/criteria/0/title' }),
    ]);
  });

  it('keeps a title of eight words, trimmed', () => {
    const planned = planCriteria(
      [{ body: 'The review page shows each fact once.', title: '  Each fact once on review  ' }],
      [],
      0,
    );
    expect(planned.ok && planned.plan.insert).toEqual([
      {
        code: 'BC-1',
        body: 'The review page shows each fact once.',
        form: 'statement',
        title: 'Each fact once on review',
      },
    ]);
  });

  it('keeps the title a criterion had when a write leaves it out, and rewords it when one is sent', () => {
    const same = planCriteria([{ code: 'BC-1', body: 'A person signs in.' }], live, 1);
    expect(same.ok && same.plan).toMatchObject({ keep: ['c1'], retire: [], insert: [] });
    const retitled = planCriteria(
      [{ code: 'BC-1', body: 'A person signs in.', title: 'Signs in' }],
      live,
      1,
    );
    expect(retitled.ok && retitled.plan).toMatchObject({
      retire: ['c1'],
      insert: [{ code: 'BC-1', title: 'Signs in' }],
    });
    const cleared = planCriteria(
      [{ code: 'BC-1', body: 'A person signs in.', title: null }],
      live,
      1,
    );
    expect(cleared.ok && cleared.plan.insert).toEqual([
      { code: 'BC-1', body: 'A person signs in.', form: 'statement', title: null },
    ]);
  });
});
