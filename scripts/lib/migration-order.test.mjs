import { describe, expect, it } from 'vitest';
import { checkSet, floorOf, newEntries } from './migration-order.mjs';

const DAY = 86_400_000;

/** A journal entry, written the way `_journal.json` writes one. */
function at(idx, when, tag = `${String(idx).padStart(4, '0')}_m${idx}`) {
  return { idx, when, tag };
}

/** The set this repo actually held on 2026-09-20, read off the three open branches. */
const MEASURED = {
  main: [at(288, 1_807_315_200_000, '0288_issue_creator_agency')],
  transitionAudit: {
    branch: 'origin/iss-1107-1108',
    entries: [
      at(289, 1_807_747_200_000, '0289_issue_transition_audit'),
      at(290, 1_807_833_600_000, '0290_closed_means_shipped'),
    ],
  },
  releaseVersion: {
    branch: 'origin/iss-1120-release-version',
    entries: [at(291, 1_807_920_000_000, '0291_release_cuts_a_version')],
  },
};

const rules = (result) => result.refusals.map((r) => r.rule);
const said = (result) => result.refusals.map((r) => r.message).join('\n');

describe('newEntries', () => {
  it('keeps only what main does not already carry, in index order', () => {
    const main = [at(1, 100), at(2, 200)];
    const branch = [at(2, 200), at(4, 400), at(1, 100), at(3, 300)];
    expect(newEntries(branch, main).map((e) => e.idx)).toEqual([3, 4]);
  });

  it('is empty for a branch that only carries what main carries', () => {
    const main = [at(1, 100), at(2, 200)];
    expect(newEntries([at(1, 100), at(2, 200)], main)).toEqual([]);
  });
});

describe('floorOf', () => {
  it('reads the highest when, not the last entry', () => {
    expect(floorOf([at(1, 300), at(2, 100)])).toBe(300);
  });

  it('is -Infinity for an empty journal, so any entry clears it', () => {
    expect(floorOf([])).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('checkSet refuses what no merge order can apply', () => {
  it('names both branches and the number when two of them hold one `when`', () => {
    const result = checkSet({
      main: [at(288, 1000)],
      self: { branch: 'iss-a', entries: [at(289, 2000, '0289_a')] },
      siblings: [{ branch: 'origin/iss-b', entries: [at(290, 2000, '0290_b')] }],
    });
    expect(rules(result)).toContain('duplicate-when');
    expect(said(result)).toContain('iss-a');
    expect(said(result)).toContain('origin/iss-b');
    expect(said(result)).toContain('2000');
  });

  it('refuses an entry that does not clear main, naming the floor and the number to take', () => {
    const result = checkSet({
      main: [at(288, 5000)],
      self: { branch: 'iss-a', entries: [at(289, 4000, '0289_a')] },
      siblings: [],
    });
    expect(rules(result)).toEqual(['below-floor']);
    expect(said(result)).toContain('0289_a');
    expect(said(result)).toContain('5000');
    expect(said(result)).toContain(String(5000 + DAY));
  });

  it('refuses a branch whose when range straddles a sibling, which no whole-branch order applies', () => {
    // A = {289, 291} and B = {290}: every entry distinct, every index ascending with its `when`,
    // and still unorderable — a branch merges whole, so whichever lands first raises the
    // high-water past the other's remainder.
    const result = checkSet({
      main: [at(288, 1000)],
      self: { branch: 'iss-a', entries: [at(289, 2000, '0289_a'), at(291, 4000, '0291_a')] },
      siblings: [{ branch: 'origin/iss-b', entries: [at(290, 3000, '0290_b')] }],
    });
    expect(rules(result)).toContain('interleaved');
    expect(said(result)).toContain('2000..4000');
    expect(said(result)).toContain('3000..3000');
  });

  it('refuses an index above a sibling whose `when` is below it', () => {
    const result = checkSet({
      main: [at(288, 1000)],
      self: { branch: 'iss-a', entries: [at(291, 2000, '0291_a')] },
      siblings: [{ branch: 'origin/iss-b', entries: [at(289, 3000, '0289_b')] }],
    });
    expect(rules(result)).toContain('inverted');
    expect(said(result)).toContain('0291_a');
    expect(said(result)).toContain('0289_b');
  });

  it('refuses two open branches holding one index', () => {
    const result = checkSet({
      main: [at(288, 1000)],
      self: { branch: 'iss-a', entries: [at(289, 2000, '0289_a')] },
      siblings: [{ branch: 'origin/iss-b', entries: [at(289, 3000, '0289_b')] }],
    });
    expect(rules(result)).toContain('duplicate-idx');
    expect(said(result)).toContain('index 289');
  });

  it('charges a shared `when` to one rule, not to two', () => {
    const result = checkSet({
      main: [at(288, 1000)],
      self: { branch: 'iss-a', entries: [at(289, 2000, '0289_a')] },
      siblings: [{ branch: 'origin/iss-b', entries: [at(290, 2000, '0290_b')] }],
    });
    expect(rules(result)).not.toContain('interleaved');
  });
});

describe('checkSet leaves a workable set alone', () => {
  it('passes the three branches this repo actually held, and derives their merge order', () => {
    const result = checkSet({
      main: MEASURED.main,
      self: MEASURED.releaseVersion,
      siblings: [MEASURED.transitionAudit],
    });
    expect(result.refusals).toEqual([]);
    expect(result.order.map((b) => b.branch)).toEqual([
      'origin/iss-1107-1108',
      'origin/iss-1120-release-version',
    ]);
    expect(result.next).toEqual({ when: 1_807_920_000_000 + DAY, idx: 292 });
  });

  it('names the sibling that has to renumber when this branch lands out of order', () => {
    const result = checkSet({
      main: MEASURED.main,
      self: MEASURED.releaseVersion,
      siblings: [MEASURED.transitionAudit],
    });
    expect(result.strandedByUs.map((b) => b.branch)).toEqual(['origin/iss-1107-1108']);
  });

  it('claims no head start for the branch that is already first', () => {
    const result = checkSet({
      main: MEASURED.main,
      self: MEASURED.transitionAudit,
      siblings: [MEASURED.releaseVersion],
    });
    expect(result.refusals).toEqual([]);
    expect(result.strandedByUs).toEqual([]);
  });
});

describe('a sibling already below the floor is reported, never charged to anybody', () => {
  it('reports it and refuses nothing, because no number here can repair it', () => {
    // main has deployed 290; the sibling still holds 289 below the floor; this branch adds 291.
    const result = checkSet({
      main: [at(288, 1000), at(290, 3000, '0290_landed')],
      self: { branch: 'iss-a', entries: [at(291, 4000, '0291_a')] },
      siblings: [{ branch: 'origin/iss-b', entries: [at(289, 2000, '0289_b')] }],
    });
    expect(result.refusals).toEqual([]);
    expect(result.stranded.map((b) => b.branch)).toEqual(['origin/iss-b']);
    expect(result.stranded[0].entries.map((e) => e.tag)).toEqual(['0289_b']);
  });

  it('keeps the stranded sibling out of the merge order it can no longer join', () => {
    const result = checkSet({
      main: [at(288, 1000), at(290, 3000, '0290_landed')],
      self: { branch: 'iss-a', entries: [at(291, 4000, '0291_a')] },
      siblings: [{ branch: 'origin/iss-b', entries: [at(289, 2000, '0289_b')] }],
    });
    expect(result.order.map((b) => b.branch)).toEqual(['iss-a']);
  });

  it('still refuses THIS tree below the floor while a sibling is stranded', () => {
    // The partition is for siblings only. Filtering our own below-floor entry out would delete
    // the very thing the check exists to refuse.
    const result = checkSet({
      main: [at(288, 1000), at(290, 3000, '0290_landed')],
      self: { branch: 'iss-a', entries: [at(289, 2000, '0289_a')] },
      siblings: [{ branch: 'origin/iss-b', entries: [at(289, 2500, '0289_b')] }],
    });
    expect(rules(result)).toContain('below-floor');
    expect(said(result)).toContain('0289_a');
  });
});

describe('two other open branches that cannot both land', () => {
  // A = {289, 291} straddled by B = {290}, with this tree clear of both at 292. Pairwise
  // compatibility with self is not the whole-set proposition, and a run that printed an order
  // here would be naming an order nobody can execute.
  const set = {
    main: [at(288, 1000)],
    self: { branch: 'iss-c', entries: [at(292, 5000, '0292_c')] },
    siblings: [
      { branch: 'origin/iss-a', entries: [at(289, 2000, '0289_a'), at(291, 4000, '0291_a')] },
      { branch: 'origin/iss-b', entries: [at(290, 3000, '0290_b')] },
    ],
  };

  it('is found, and named as the pair it is', () => {
    const result = checkSet(set);
    expect(result.betweenSiblings.map((r) => r.rule)).toContain('interleaved');
    const text = result.betweenSiblings.map((r) => r.message).join('\n');
    expect(text).toContain('origin/iss-a');
    expect(text).toContain('origin/iss-b');
  });

  it('is charged to nobody — this tree conflicts with neither and is refused nothing', () => {
    expect(checkSet(set).refusals).toEqual([]);
  });

  it('costs the claim: no merge order is offered over a set that has none', () => {
    expect(checkSet(set).order).toEqual([]);
  });
});

describe('the interleave refusal names the entries, not only the ranges', () => {
  it('prints the straddling tags on both sides', () => {
    const result = checkSet({
      main: [at(288, 1000)],
      self: { branch: 'iss-a', entries: [at(289, 2000, '0289_a'), at(291, 4000, '0291_a')] },
      siblings: [{ branch: 'origin/iss-b', entries: [at(290, 3000, '0290_b')] }],
    });
    expect(said(result)).toContain('0289_a');
    expect(said(result)).toContain('0291_a');
    expect(said(result)).toContain('0290_b');
  });
});
