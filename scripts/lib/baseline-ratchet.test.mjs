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
    const faults = compareBaseline('down', at({ 'a.ts': { r: 10 } }), at({ 'a.ts': { r: 10 }, 'b.ts': { r: 3 } }));
    expect(faults).toEqual(['frozen total rose 10 -> 13']);
  });

  // cm:guard a rename must pass or the rule gets switched off — the baseline is path-keyed, so moving a file re-freezes the same debt under a new key and a "no new keys" rule would fire on every move
  it('lets a rename through: same debt, new path, flat total', () => {
    const faults = compareBaseline('down', at({ 'old.ts': { r: 10 } }), at({ 'new.ts': { r: 10 } }));
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
});

describe('improves: shrink', () => {
  it('accepts cleaning frozen entries away', () => {
    expect(compareBaseline('shrink', { 'a.ts': ['h1', 'h2'] }, { 'a.ts': ['h1'] })).toEqual([]);
  });

  it('refuses a bigger frozen set', () => {
    const faults = compareBaseline('shrink', { 'a.ts': ['h1'] }, { 'a.ts': ['h1'], 'b.ts': ['h2'] });
    expect(faults).toEqual(['frozen entries grew 1 -> 2']);
  });

  it('reads the flow-coverage shape, which is one array under a key', () => {
    const faults = compareBaseline('shrink', { uncovered: ['release/deploy'] }, { uncovered: ['release/deploy', 'dispatch/tick'] });
    expect(faults).toEqual(['frozen entries grew 1 -> 2']);
  });
});

describe('improves: tighten', () => {
  const at = (contracts) => ({ contracts });

  it('accepts draft becoming locked', () => {
    expect(compareBaseline('tighten', at([{ id: 'c', status: 'draft' }]), at([{ id: 'c', status: 'locked' }]))).toEqual([]);
  });

  it('refuses locked becoming draft', () => {
    const faults = compareBaseline('tighten', at([{ id: 'c', status: 'locked' }]), at([{ id: 'c', status: 'draft' }]));
    expect(faults).toEqual(['c: locked -> draft']);
  });

  // cm:guard deleting a contract and drafting it have the SAME effect on the graph, so a deletion must fail too — otherwise the cheapest way past this rule is `git rm` on the line that constrained you
  it('treats a deleted contract as loosening', () => {
    const faults = compareBaseline('tighten', at([{ id: 'c', status: 'locked' }]), at([]));
    expect(faults).toEqual(['c: locked -> removed']);
  });

  it('welcomes a contract that did not exist before', () => {
    const before = at([{ id: 'c', status: 'locked' }]);
    const now = at([{ id: 'c', status: 'locked' }, { id: 'd', status: 'draft' }]);
    expect(compareBaseline('tighten', before, now)).toEqual([]);
  });
});

// cm:guard an unknown direction must FAIL, not pass. A typo in the manifest would otherwise mean no comparison runs and the axis reports clean, which is the fail-open shape this file exists to close.
it('refuses a direction it does not implement', () => {
  expect(compareBaseline('sideways', {}, {})).toEqual(['unknown direction sideways']);
});
