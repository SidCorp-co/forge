import { describe, expect, it } from 'vitest';
import { compareBaseline } from './baseline-ratchet.mjs';

describe('improves: down', () => {
  const at = (files) => ({ generatedAt: '2026-01-01', files });

  it('accepts a fix', () => {
    const faults = compareBaseline('down', at({ 'a.ts': { r: 10 } }), at({ 'a.ts': { r: 4 } }));
    expect(faults).toEqual([]);
  });

  it('refuses an existing offender getting worse', () => {
    const faults = compareBaseline('down', at({ 'a.ts': { r: 10 } }), at({ 'a.ts': { r: 11 } }));
    expect(faults).toContain('a.ts::r: 10 -> 11');
  });

  it('refuses a brand-new offender, because the total rises', () => {
    const faults = compareBaseline(
      'down',
      at({ 'a.ts': { r: 10 } }),
      at({ 'a.ts': { r: 10 }, 'b.ts': { r: 3 } }),
    );
    expect(faults).toEqual(['frozen total for . rose 10 -> 13']);
  });

  // cm:guard a rename must pass or the rule gets switched off — the baseline is path-keyed, so moving a file re-freezes the same debt under a new key and a "no new keys" rule would fire on every move
  it('lets a rename through: same debt, new path, flat total', () => {
    const faults = compareBaseline(
      'down',
      at({ 'old.ts': { r: 10 } }),
      at({ 'new.ts': { r: 10 } }),
    );
    expect(faults).toEqual([]);
  });

  // cm:guard trading debt is the price of tolerating renames: net cannot rise, so this is a bounded hole, not an open one
  it('allows a swap that leaves the total flat', () => {
    const faults = compareBaseline('down', at({ 'a.ts': { r: 10 } }), at({ 'b.ts': { r: 10 } }));
    expect(faults).toEqual([]);
  });

  it('reads a flat {path: n} baseline the same way as a nested one', () => {
    expect(compareBaseline('down', at({ 'a.ts': 5 }), at({ 'a.ts': 6 }))).toContain('a.ts: 5 -> 6');
  });

  // cm:guard these six are the widening rule, and the ones that refuse are what keep it honest. A total over every key made registering a new checker scope impossible — .forge/lint-baseline.json went 216 -> 493 when packages/core joined check-lint-budget, which `down` rejected — so the manifest's promise that declaring a new rule is never punished was false for any checker sharing a baseline file.
  it('accepts a first-time-covered area arriving with its debt frozen', () => {
    const faults = compareBaseline(
      'down',
      at({ 'packages/web-v2/src/a.tsx': { r: 216 } }),
      at({ 'packages/web-v2/src/a.tsx': { r: 216 }, 'packages/core/src/b.ts': { r: 280 } }),
    );
    expect(faults).toEqual([]);
  });

  it('still refuses debt on a new file inside an area it already covered', () => {
    const faults = compareBaseline(
      'down',
      at({ 'packages/core/src/a.ts': { r: 10 } }),
      at({ 'packages/core/src/a.ts': { r: 10 }, 'packages/core/src/b.ts': { r: 1 } }),
    );
    expect(faults).toEqual(['frozen total for packages/core rose 10 -> 11']);
  });

  it('still refuses an existing offender getting worse in a widening re-freeze', () => {
    const faults = compareBaseline(
      'down',
      at({ 'packages/web-v2/src/a.tsx': { r: 5 } }),
      at({ 'packages/web-v2/src/a.tsx': { r: 6 }, 'packages/core/src/b.ts': { r: 280 } }),
    );
    expect(faults).toContain('packages/web-v2/src/a.tsx::r: 5 -> 6');
  });

  // cm:guard debt may not move BETWEEN two covered areas either. One sum over the covered areas together accepted this — 50 web-v2 fixes paying for 50 new core diagnostics, net flat — and so did the single global sum that preceded it, which is why the totals are per area rather than one number.
  it('refuses debt laundered from one covered area into another', () => {
    const faults = compareBaseline(
      'down',
      at({ 'packages/web-v2/src/a.tsx': { r: 60 }, 'packages/core/src/x.ts': { r: 10 } }),
      at({
        'packages/web-v2/src/a.tsx': { r: 10 },
        'packages/core/src/x.ts': { r: 10 },
        'packages/core/src/new.ts': { r: 50 },
      }),
    );
    expect(faults).toEqual(['frozen total for packages/core rose 10 -> 60']);
  });

  // cm:guard this DECLARES a hole rather than closing one, and it is the price of letting a scope widen at all: from the baseline alone, a file moved into a first-time-seen area and a genuinely new scope arriving are the same edit. The pre-ISS-833 global sum caught this case and no longer does. Both sit behind a reviewed --update-baseline; delete this test and the next reader will believe the rule is tighter than it is.
  it('lets a move into a first-time-seen area escape its old total — declared, not closed', () => {
    const faults = compareBaseline(
      'down',
      at({ 'packages/core/src/a.ts': { r: 10 } }),
      at({ 'packages/newpkg/src/a.ts': { r: 40 } }),
    );
    expect(faults).toEqual([]);
  });

  it('treats an empty previous baseline as covering everything, not nothing', () => {
    const faults = compareBaseline('down', at({}), at({ 'packages/core/src/a.ts': { r: 1 } }));
    expect(faults).toEqual(['frozen total for packages/core rose 0 -> 1']);
  });
});

describe('improves: shrink', () => {
  it('accepts cleaning frozen entries away', () => {
    expect(compareBaseline('shrink', { 'a.ts': ['h1', 'h2'] }, { 'a.ts': ['h1'] })).toEqual([]);
  });

  it('refuses a bigger frozen set', () => {
    const faults = compareBaseline(
      'shrink',
      { 'a.ts': ['h1'] },
      { 'a.ts': ['h1'], 'b.ts': ['h2'] },
    );
    expect(faults).toEqual(['frozen entries grew 1 -> 2']);
  });

  it('reads the flow-coverage shape, which is one array under a key', () => {
    const faults = compareBaseline(
      'shrink',
      { uncovered: ['release/deploy'] },
      { uncovered: ['release/deploy', 'dispatch/tick'] },
    );
    expect(faults).toEqual(['frozen entries grew 1 -> 2']);
  });
});

describe('improves: tighten', () => {
  const at = (contracts) => ({ contracts });

  it('accepts draft becoming locked', () => {
    expect(
      compareBaseline(
        'tighten',
        at([{ id: 'c', status: 'draft' }]),
        at([{ id: 'c', status: 'locked' }]),
      ),
    ).toEqual([]);
  });

  it('refuses locked becoming draft', () => {
    const faults = compareBaseline(
      'tighten',
      at([{ id: 'c', status: 'locked' }]),
      at([{ id: 'c', status: 'draft' }]),
    );
    expect(faults).toEqual(['c: locked -> draft']);
  });

  // cm:guard deleting a contract and drafting it have the SAME effect on the graph, so a deletion must fail too — otherwise the cheapest way past this rule is `git rm` on the line that constrained you
  it('treats a deleted contract as loosening', () => {
    const faults = compareBaseline('tighten', at([{ id: 'c', status: 'locked' }]), at([]));
    expect(faults).toEqual(['c: locked -> removed']);
  });

  it('welcomes a contract that did not exist before', () => {
    const before = at([{ id: 'c', status: 'locked' }]);
    const now = at([
      { id: 'c', status: 'locked' },
      { id: 'd', status: 'draft' },
    ]);
    expect(compareBaseline('tighten', before, now)).toEqual([]);
  });
});

// cm:guard an unknown direction must FAIL, not pass. A typo in the manifest would otherwise mean no comparison runs and the axis reports clean, which is the fail-open shape this file exists to close.
it('refuses a direction it does not implement', () => {
  expect(compareBaseline('sideways', {}, {})).toEqual(['unknown direction sideways']);
});
