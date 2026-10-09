// Two open branches compared by `betweenBranches`: a branch stacked on another carries the other's
// migration as the same journal entry, which is one migration landing once, not a collision; what the
// stacked branch adds of its own, and two tags on one `when`, stay refused.

import { describe, expect, it } from 'vitest';
import { betweenBranches } from './migration-order.mjs';

const entry = (idx, when, tag) => ({ idx, when, tag });
const page = entry(478, 1824249600000, '0478_a_release_page_opens_on_highlights_and_can_be_shared');

describe('betweenBranches', () => {
  it('reads a branch stacked on another, holding the identical entry, as one migration', () => {
    const core = { branch: 'release-page', entries: [page] };
    const web = { branch: 'release-page-web', entries: [page] };
    expect(betweenBranches(core, web)).toEqual([]);
  });

  it('still measures what the stacked branch adds of its own', () => {
    const core = { branch: 'release-page', entries: [page] };
    const own = entry(479, 1824249600000, '0479_a_reach_is_recorded');
    const web = { branch: 'release-reach', entries: [page, own] };
    expect(betweenBranches(core, web).map((r) => r.rule)).toEqual(['duplicate-when']);
  });

  it('refuses two different migrations on one when and index', () => {
    const other = entry(478, page.when, '0478_another_table');
    const rules = betweenBranches(
      { branch: 'a', entries: [page] },
      { branch: 'b', entries: [other] },
    ).map((r) => r.rule);
    expect(rules).toEqual(['duplicate-when', 'duplicate-idx']);
  });
});
