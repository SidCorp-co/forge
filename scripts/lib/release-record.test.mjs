import { describe, expect, it } from 'vitest';
import {
  CORRECTION_SPAN,
  ENTRY_WORD_BUDGET,
  judge,
  normaliseEntry,
  pairEdits,
  parseRecord,
  wordCount,
} from './release-record.mjs';

const RECORD = `# Changelog

Style prose that is not an entry.

## [Unreleased]

### Added

- Work queued behind a paused pipeline run is now reported instead of sitting
  silently, naming what paused it and how many steps are frozen behind it.

### Fixed

- Deploy logs now carry the time they were read.

## [0.1.0] - 2026-04-01

### Added

- The first thing that ever shipped.
`;

const entriesOf = (text) => [...parseRecord(text).entries];
const lossOfRule = (verdict) => (verdict.violations ?? []).find((v) => v.rule === 'no-silent-loss');

describe('parseRecord', () => {
  it('reads one entry per bullet, joining the lines a hard wrap split', () => {
    expect(entriesOf(RECORD)).toEqual([
      'Work queued behind a paused pipeline run is now reported instead of sitting silently, naming what paused it and how many steps are frozen behind it.',
      'Deploy logs now carry the time they were read.',
      'The first thing that ever shipped.',
    ]);
  });

  it('names every release section and ignores the `###` groupings inside them', () => {
    expect(parseRecord(RECORD).sections).toEqual(['Unreleased', '0.1.0']);
  });

  it('takes nothing from prose above the first release heading', () => {
    const preamble =
      '# Changelog\n\n- this is a style rule, not a release\n\n## [Unreleased]\n\n- real\n';
    expect(entriesOf(preamble)).toEqual(['real']);
  });

  it('takes nothing from a fenced block, which quotes the format rather than recording a release', () => {
    const fenced = '## [Unreleased]\n\n```md\n- an example of an entry\n```\n\n- an actual entry\n';
    expect(entriesOf(fenced)).toEqual(['an actual entry']);
  });

  it('takes nothing from a commented-out entry, which is not on the rendered page', () => {
    const commented =
      '## [Unreleased]\n\n- a published entry\n\n<!--\n- ISS-000 an entry someone hid\n-->\n';
    expect(entriesOf(commented)).toEqual(['a published entry']);
  });

  it('is empty for the stub 3df9a8e9 left behind', () => {
    expect(entriesOf('# Changelog\n')).toEqual([]);
  });
});

describe('normaliseEntry', () => {
  it('collapses the whitespace a rewrap moves and nothing else', () => {
    expect(normaliseEntry('  Deploy logs now\n  carry the time\t they were read.  ')).toBe(
      'Deploy logs now carry the time they were read.',
    );
  });
});

describe('judge', () => {
  const clean = { head: RECORD, base: RECORD, amnesty: { removals: [] } };

  it('passes a record that lost nothing', () => {
    expect(judge(clean)).toMatchObject({ code: 0, entries: 3, sections: 2 });
  });

  it('passes an entry added since the base revision', () => {
    const grown = RECORD.replace('- Deploy logs', '- Something new shipped.\n\n- Deploy logs');
    expect(judge({ ...clean, head: grown })).toMatchObject({ code: 0, entries: 4 });
  });

  it('refuses the deletion of 3df9a8e9 — the whole record replaced by its own title', () => {
    const verdict = judge({ ...clean, head: '# Changelog\n' });
    expect(verdict.code).toBe(1);
    expect(verdict.violations.map((v) => v.rule).sort()).toEqual(['no-silent-loss', 'structure']);
    expect(verdict.violations.find((v) => v.rule === 'no-silent-loss').removed).toHaveLength(3);
  });

  it('refuses a thinning that keeps the structure intact, which no structural rule would catch', () => {
    const thinned = RECORD.replace('- The first thing that ever shipped.\n', '');
    const verdict = judge({ ...clean, head: thinned });
    expect(verdict.code).toBe(1);
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0].removed).toEqual(['The first thing that ever shipped.']);
  });

  it('passes a release cut, which moves every entry under a new heading', () => {
    const cut = RECORD.replace(
      '## [Unreleased]',
      '## [Unreleased]\n\n## [0.2.0] - 2026-08-30',
    ).replace('## [0.1.0]', '## [0.1.0]');
    expect(judge({ ...clean, head: cut }).code).toBe(0);
  });

  it('passes a rewrap, which moves every word without losing an entry', () => {
    const rewrapped = RECORD.replace(
      '- Work queued behind a paused pipeline run is now reported instead of sitting\n  silently, naming what paused it and how many steps are frozen behind it.',
      '- Work queued behind a paused pipeline run is now reported\n  instead of sitting silently, naming what paused it\n  and how many steps are frozen behind it.',
    );
    expect(judge({ ...clean, head: rewrapped }).code).toBe(0);
  });

  it('lets a declared removal through, and reports the same removal when nothing declares it', () => {
    const head = RECORD.replace('- Deploy logs now carry the time they were read.\n', '');
    const entry = 'Deploy logs now carry the time they were read.';
    expect(
      judge({ head, base: RECORD, amnesty: { removals: [{ entry, reason: 'never shipped' }] } })
        .code,
    ).toBe(0);
    expect(judge({ head, base: RECORD, amnesty: { removals: [] } }).code).toBe(1);
  });

  it('refuses an amnesty entry with no reason — an undeclared price is not a declaration', () => {
    const head = RECORD.replace('- Deploy logs now carry the time they were read.\n', '');
    const entry = 'Deploy logs now carry the time they were read.';
    expect(
      judge({ head, base: RECORD, amnesty: { removals: [{ entry, reason: '  ' }] } }).code,
    ).toBe(1);
  });

  it('matches an amnesty entry through the same normalisation the record gets', () => {
    const head = RECORD.replace(
      '- Work queued behind a paused pipeline run is now reported instead of sitting\n  silently, naming what paused it and how many steps are frozen behind it.\n',
      '',
    );
    const wrapped = {
      entry:
        'Work queued behind a paused pipeline run is now reported instead of sitting\n  silently, naming what paused it and how many steps are frozen behind it.',
      reason: 'folded into the entry above it',
    };
    expect(judge({ head, base: RECORD, amnesty: { removals: [wrapped] } }).code).toBe(0);
  });

  it('reports the missing heading on its own when no entry was lost with it', () => {
    const cut = '# Changelog\n\n## [0.1.0] - 2026-04-01\n\n- The first thing that ever shipped.\n';
    const verdict = judge({ head: cut, base: cut, amnesty: { removals: [] } });
    expect(verdict.code).toBe(1);
    expect(verdict.violations.map((v) => v.rule)).toEqual(['structure']);
    expect(verdict.violations[0].detail).toContain('[Unreleased]');
  });

  it('counts a heading demoted out of the parsed shape as loss too, because its readers lose the entries under it', () => {
    const renamed = RECORD.replace('## [Unreleased]', '## Unreleased');
    const verdict = judge({ ...clean, head: renamed });
    expect(verdict.violations.map((v) => v.rule).sort()).toEqual(['no-silent-loss', 'structure']);
    expect(verdict.violations.find((v) => v.rule === 'no-silent-loss').removed).toHaveLength(2);
  });

  it('refuses a release section that carries the same `###` heading twice', () => {
    const doubled = RECORD.replace(
      '## [Unreleased]',
      '## [Unreleased]\n\n### Fixed\n\n- an earlier fix.',
    );
    const verdict = judge({ head: doubled, base: doubled, amnesty: { removals: [] } });
    expect(verdict.code).toBe(1);
    const structure = verdict.violations.filter((v) => v.rule === 'structure');
    expect(structure).toHaveLength(1);
    expect(structure[0].detail).toContain('### Fixed');
  });

  it('reads a heading repeated under a DIFFERENT release as two distinct sections, not a repeat', () => {
    const twoReleases =
      '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- a.\n\n## [0.1.0] - 2026-04-01\n\n### Fixed\n\n- b.\n';
    expect(judge({ head: twoReleases, base: twoReleases, amnesty: { removals: [] } }).code).toBe(0);
  });

  it('cannot run without a base revision, and says so rather than passing', () => {
    expect(judge({ head: RECORD, base: null, amnesty: { removals: [] } })).toMatchObject({
      code: 2,
    });
  });

  it('still reports a broken structure when there is no base revision to compare against', () => {
    expect(judge({ head: '# Changelog\n', base: null, amnesty: { removals: [] } }).code).toBe(1);
  });

  it('cannot run when the record itself is unreadable', () => {
    expect(judge({ head: null, base: RECORD, amnesty: { removals: [] } }).code).toBe(2);
    expect(judge({ head: RECORD, base: 7, amnesty: { removals: [] } }).code).toBe(2);
  });
});

describe('entry-budget', () => {
  const withEntry = (entry) => `# Changelog\n\n## [Unreleased]\n\n- ${entry}\n`;
  const BASE = withEntry('Something short that already shipped.');
  const budgetOf = (verdict) => (verdict.violations ?? []).find((v) => v.rule === 'entry-budget');
  const words = (n) => `An added entry ${'padding '.repeat(n).trim()}`;

  it('refuses a new entry over the budget, naming its length', () => {
    const long = words(ENTRY_WORD_BUDGET + 10);
    const verdict = judge({ head: BASE + `\n- ${long}\n`, base: BASE, amnesty: null });
    const v = budgetOf(verdict);
    expect(verdict.code).toBe(1);
    expect(v.detail).toContain(String(wordCount(long)));
    expect(v.removed[0]).toContain(
      `[${wordCount(long)} words, new entry; ceiling ${ENTRY_WORD_BUDGET}]`,
    );
  });

  it('admits a new entry exactly at the budget — the boundary is not off by one', () => {
    const exact = words(ENTRY_WORD_BUDGET - 3);
    expect(wordCount(exact)).toBe(ENTRY_WORD_BUDGET);
    const verdict = judge({ head: BASE + `\n- ${exact}\n`, base: BASE, amnesty: null });
    expect(budgetOf(verdict)).toBeUndefined();
  });

  it('leaves an already-published over-long entry alone — the record is edited one line at a time', () => {
    const long = `${words(ENTRY_WORD_BUDGET + 10)} already published`;
    const record = withEntry(long);
    const verdict = judge({ head: record, base: record, amnesty: null });
    expect(budgetOf(verdict)).toBeUndefined();
    expect(verdict.code).toBe(0);
  });

  it('measures the entry after its continuation lines are joined, not the first line alone', () => {
    const wrapped = Array.from({ length: 8 }, () => 'seven words of padding on this line').join(
      '\n  ',
    );
    const verdict = judge({ head: `${BASE}\n- ${wrapped}\n`, base: BASE, amnesty: null });
    expect(budgetOf(verdict)).toBeDefined();
  });

  it('has no amnesty: declaring the entry does not buy past the budget', () => {
    const long = words(ENTRY_WORD_BUDGET + 10);
    const verdict = judge({
      head: BASE + `\n- ${long}\n`,
      base: BASE,
      amnesty: { removals: [{ entry: long, reason: 'it is long on purpose' }] },
    });
    expect(budgetOf(verdict)).toBeDefined();
  });
});

describe('correcting a published entry', () => {
  const prose = (n, tag = 'w') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');
  const record = (...entries) =>
    `# Changelog\n\n## [Unreleased]\n\n${entries.map((e) => `- ${e}\n`).join('\n')}`;
  const budgetOf = (verdict) => (verdict.violations ?? []).find((v) => v.rule === 'entry-budget');
  const lossOf = (verdict) => (verdict.violations ?? []).find((v) => v.rule === 'no-silent-loss');

  const SHORT = 'A short entry that also shipped.';
  const PUBLISHED = prose(120);
  const BASE = record(PUBLISHED, SHORT);

  it('reads a one-word correction to a published over-budget entry as neither a loss nor an addition', () => {
    const corrected = PUBLISHED.replace('w60', 'w60-corrected');
    expect(judge({ head: record(corrected, SHORT), base: BASE, amnesty: null })).toMatchObject({
      code: 0,
    });
  });

  it('refuses an entry that is genuinely new and over budget, naming its word count', () => {
    const fresh = prose(80, 'n');
    const verdict = judge({ head: record(PUBLISHED, SHORT, fresh), base: BASE, amnesty: null });
    expect(verdict.code).toBe(1);
    expect(budgetOf(verdict).detail).toContain('80 words');
    expect(budgetOf(verdict).removed[0]).toContain('[80 words, new entry; ceiling 40]');
  });

  it('refuses an edit that grows an already-over-budget entry past what it held', () => {
    const grown = `${PUBLISHED} ${prose(10, 'x')}`;
    const verdict = judge({ head: record(grown, SHORT), base: BASE, amnesty: null });
    expect(verdict.code).toBe(1);
    expect(budgetOf(verdict).removed[0]).toContain(
      '[130 words, correcting an entry of 120; ceiling 120]',
    );
    expect(lossOf(verdict)).toBeUndefined();
  });

  it('admits an edit that shrinks an over-budget entry without reaching the budget', () => {
    const trimmed = prose(120 - CORRECTION_SPAN);
    expect(judge({ head: record(trimmed, SHORT), base: BASE, amnesty: null }).code).toBe(0);
  });

  it('refuses a trim that takes more of the published entry than a correction may', () => {
    const gutted = prose(120 - CORRECTION_SPAN - 1);
    const verdict = judge({ head: record(gutted, SHORT), base: BASE, amnesty: null });
    expect(lossOf(verdict).removed).toEqual([PUBLISHED]);
  });

  it.each([
    [41, 41, false],
    [41, 42, true],
    [39, 40, false],
    [39, 41, true],
  ])('a %i-word entry corrected to %i words: refused = %s', (before, after, refused) => {
    const was = prose(before, 's');
    const now = `${prose(after - 1, 's')} ${prose(1, 'x')}`;
    const verdict = judge({ head: record(now), base: record(was), amnesty: null });
    expect(wordCount(now)).toBe(after);
    expect(budgetOf(verdict) !== undefined).toBe(refused);
    expect(lossOf(verdict)).toBeUndefined();
  });

  it('holds the plain budget over an edit to an entry that was under it', () => {
    const was = prose(38, 's');
    const verdict = judge({
      head: record(`${was} ${prose(5, 'x')}`),
      base: record(was),
      amnesty: null,
    });
    expect(budgetOf(verdict).removed[0]).toContain(
      '[43 words, correcting an entry of 38; ceiling 40]',
    );
  });

  it('still raises no-silent-loss for a genuine deletion made beside an addition', () => {
    const verdict = judge({ head: record(SHORT, prose(20, 'z')), base: BASE, amnesty: null });
    expect(verdict.code).toBe(1);
    expect(lossOf(verdict).removed).toEqual([PUBLISHED]);
  });

  it('still lets that deletion through on its amnesty row, and on nothing else', () => {
    const head = record(SHORT, prose(20, 'z'));
    const removals = [{ entry: PUBLISHED, reason: 'withdrawn, and here is why' }];
    expect(judge({ head, base: BASE, amnesty: { removals } }).code).toBe(0);
  });

  it('does not pair at exactly half: the threshold is MORE than half the longer entry', () => {
    const half = `${prose(60)} ${prose(60, 'q')}`;
    const verdict = judge({ head: record(half, SHORT), base: BASE, amnesty: null });
    expect(verdict.violations.map((v) => v.rule).sort()).toEqual([
      'entry-budget',
      'no-silent-loss',
    ]);
  });

  it('does not pair an entry wholly contained in a much longer one — the denominator is the longer', () => {
    const swollen = `${prose(60)} ${prose(60, 'q')}`;
    const verdict = judge({
      head: record(swollen, SHORT, prose(60, 'r')),
      base: BASE,
      amnesty: null,
    });
    expect(lossOf(verdict).removed).toEqual([PUBLISHED]);
  });

  it('pairs one removed entry with at most one added one, so a split pays the budget for its other half', () => {
    const head = record(prose(112), prose(106), SHORT);
    const verdict = judge({ head, base: BASE, amnesty: null });
    expect(lossOf(verdict)).toBeUndefined();
    expect(budgetOf(verdict).removed).toHaveLength(1);
    expect(budgetOf(verdict).removed[0]).toContain('[106 words, new entry; ceiling 40]');
  });

  it('reads the correction this gate was built for: a long entry losing a dead link', () => {
    const body = `**The backlog can be read by module.** ${prose(160)}`;
    const linked = `${body} Flow: [\`docs/flows/issue-work.html\`](docs/flows/issue-work.html).`;
    const verdict = judge({ head: record(body), base: record(linked), amnesty: null });
    expect(verdict).toMatchObject({ code: 0 });
  });
});

describe("a removal wearing a correction's face", () => {
  const words = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');
  const record = (...entries) =>
    `# Changelog\n\n## [Unreleased]\n\n${entries.map((e) => `- ${e}\n`).join('\n')}`;
  const ruleset = (verdict) => (verdict.violations ?? []).map((v) => v.rule).sort();

  // 61 words of background beside a 59-word claim: the background alone scores 61/120, which is
  // over half the longer entry. Every share threshold has such an entry; an absolute span has none.
  const BACKGROUND = words(61, 'bg');
  const PUBLISHED = `${BACKGROUND} ${words(59, 'claim')}`;

  it('refuses a published claim replaced wholesale behind surviving background prose', () => {
    const rewritten = `${BACKGROUND} ${words(59, 'other')}`;
    const verdict = judge({ head: record(rewritten), base: record(PUBLISHED), amnesty: null });
    expect(ruleset(verdict)).toEqual(['entry-budget', 'no-silent-loss']);
    expect(lossOfRule(verdict).removed).toEqual([PUBLISHED]);
  });

  it("refuses the same removal made by subtraction, with nothing put in the claim's place", () => {
    const verdict = judge({ head: record(BACKGROUND), base: record(PUBLISHED), amnesty: null });
    expect(lossOfRule(verdict).removed).toEqual([PUBLISHED]);
  });

  it('cannot be bought with background: the same claim swap is refused at every entry length', () => {
    for (const padding of [40, 100, 400, 1000]) {
      const background = words(padding, 'bg');
      const before = `${background} ${words(30, 'claim')}`;
      const after = `${background} ${words(30, 'other')}`;
      expect(pairEdits([before], [after]).size).toBe(0);
    }
  });

  it('takes a correction at the span and refuses the word past it, on either side', () => {
    const published = words(120, 'w');
    const trimmed = (n) => words(120 - n, 'w');
    expect(pairEdits([published], [trimmed(CORRECTION_SPAN)]).size).toBe(1);
    expect(pairEdits([published], [trimmed(CORRECTION_SPAN + 1)]).size).toBe(0);
    const grown = (n) => `${published} ${words(n, 'x')}`;
    expect(pairEdits([published], [grown(CORRECTION_SPAN)]).size).toBe(1);
    expect(pairEdits([published], [grown(CORRECTION_SPAN + 1)]).size).toBe(0);
  });

  it('still refuses a pair at exactly half the longer entry, inside the span', () => {
    const before = `${words(16, 'k')} ${words(16, 'a')}`;
    const after = `${words(16, 'k')} ${words(16, 'b')}`;
    expect(pairEdits([before], [after]).size).toBe(0);
  });
});

describe('two corrections in one change', () => {
  const run = (from, to, tag) =>
    Array.from({ length: to - from }, (_, i) => `${tag}${from + i}`).join(' ');
  const record = (...entries) =>
    `# Changelog\n\n## [Unreleased]\n\n${entries.map((e) => `- ${e}\n`).join('\n')}`;

  // A pairs with X (.77) and with Y (.73); B pairs with X (.73) and with nothing else. Taking the
  // likeliest candidate first spends A on X and leaves B lost and Y over budget; A-Y with B-X
  // clears every threshold and the one-to-one rule, and is the answer.
  const A = run(0, 44, 'c');
  const B = `${run(0, 22, 'c')} ${run(22, 34, 'b')} ${run(34, 44, 'x')}`;
  const X = `${run(0, 34, 'c')} ${run(34, 44, 'x')}`;
  const Y = `${run(0, 32, 'c')} ${run(32, 44, 'y')}`;

  it('takes both rather than the single likeliest, so neither correction refuses the other', () => {
    const paired = pairEdits([A, B], [X, Y]);
    expect(paired.size).toBe(2);
    expect(paired.get(X)).toBe(B);
    expect(paired.get(Y)).toBe(A);
  });

  it('reports neither a loss nor an over-budget entry for the pair of them', () => {
    expect(judge({ head: record(X, Y), base: record(A, B), amnesty: null })).toMatchObject({
      code: 0,
    });
  });

  it('breaks a tie between two pairings of the same size by similarity', () => {
    const published = run(0, 60, 'c');
    const near = `${run(0, 55, 'c')} ${run(55, 60, 'n')}`;
    const far = `${run(0, 48, 'c')} ${run(48, 60, 'f')}`;
    expect(pairEdits([published], [near, far]).get(near)).toBe(published);
    expect(pairEdits([published], [far, near]).get(near)).toBe(published);
  });
});

describe('the pairing against a brute-force reference', () => {
  // An independent oracle: the same qualification rule written out again, and every one-to-one
  // selection enumerated. What `pairEdits` returns has to tie it on both terms of the objective.
  const SPAN = CORRECTION_SPAN;
  const longestRun = (a, b) => {
    const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i += 1) {
      for (let j = 1; j <= b.length; j += 1) {
        table[i][j] =
          a[i - 1] === b[j - 1]
            ? table[i - 1][j - 1] + 1
            : Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
    return table[a.length][b.length];
  };
  const qualifies = (before, after) => {
    const was = before.split(' ');
    const now = after.split(' ');
    const longest = Math.max(was.length, now.length);
    const survived = longestRun(was, now);
    if (survived <= longest * 0.5) return null;
    if (was.length - survived > SPAN || now.length - survived > SPAN) return null;
    return survived / longest;
  };
  const bestOf = (removed, added) => {
    let best = { pairs: 0, share: 0 };
    const walk = (index, takenAdded, pairs, share) => {
      if (pairs > best.pairs || (pairs === best.pairs && share > best.share + 1e-9)) {
        best = { pairs, share };
      }
      if (index === removed.length) return;
      walk(index + 1, takenAdded, pairs, share);
      for (const [right, after] of added.entries()) {
        if (takenAdded.has(right)) continue;
        const scored = qualifies(removed[index], after);
        if (scored === null) continue;
        takenAdded.add(right);
        walk(index + 1, takenAdded, pairs + 1, share + scored);
        takenAdded.delete(right);
      }
    };
    walk(0, new Set(), 0, 0);
    return best;
  };

  // A small deterministic generator, so a failure names one seed rather than a mood.
  let seed = 20260921;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const variant = (base, changes, tag) => {
    const out = [...base];
    for (let n = 0; n < changes; n += 1) out[Math.floor(next() * out.length)] = `${tag}${n}`;
    return out;
  };

  it('ties the reference on pair count and on total similarity over 300 generated changes', () => {
    for (let round = 0; round < 300; round += 1) {
      const base = Array.from({ length: 30 + Math.floor(next() * 20) }, (_, i) => `w${i}`);
      const removed = [0, 1, 2].map((i) =>
        variant(base, Math.floor(next() * 20), `r${i}`).join(' '),
      );
      const added = [0, 1, 2].map((i) => variant(base, Math.floor(next() * 20), `a${i}`).join(' '));
      if (new Set([...removed, ...added]).size !== 6) continue;

      const paired = pairEdits(removed, added);
      let share = 0;
      const spent = new Set();
      for (const [after, before] of paired) {
        const scored = qualifies(before, after);
        expect(scored, `round ${round}: an unqualified pair was taken`).not.toBeNull();
        expect(spent.has(before), `round ${round}: one removed entry paired twice`).toBe(false);
        spent.add(before);
        share += scored;
      }
      const reference = bestOf(removed, added);
      expect(paired.size, `round ${round}: fewer pairs than the reference`).toBe(reference.pairs);
      expect(share, `round ${round}: a worse pairing of the same size`).toBeCloseTo(
        reference.share,
        9,
      );
    }
  });
});

describe('pairEdits', () => {
  const prose = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');

  it('pairs an entry with its own corrected text', () => {
    const before = prose(60, 'w');
    const after = before.replace('w30', 'w30-corrected');
    expect(pairEdits([before], [after]).get(after)).toBe(before);
  });

  it('leaves two genuinely different entries unpaired, whatever else the change did', () => {
    expect(pairEdits([prose(80, 'a')], [prose(80, 'b')]).size).toBe(0);
  });

  it('pairs nothing when the change only removed, or only added', () => {
    expect(pairEdits([prose(60, 'w')], []).size).toBe(0);
    expect(pairEdits([], [prose(60, 'w')]).size).toBe(0);
  });
});

describe('an entry a blank line split in two', () => {
  const prose = (n, tag = 'w') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');
  const structureOf = (verdict) => (verdict.violations ?? []).filter((v) => v.rule === 'structure');
  const lossOf = (verdict) => (verdict.violations ?? []).find((v) => v.rule === 'no-silent-loss');

  const PUBLISHED = prose(50);
  const BASE = `# Changelog\n\n## [Unreleased]\n\n- ${PUBLISHED}\n`;

  it('refuses the prose a blank line orphaned, which the record drops and the pairing would forgive', () => {
    const head = `# Changelog\n\n## [Unreleased]\n\n- ${prose(40)}\n\n${prose(50).split(' ').slice(40).join(' ')}\n`;
    const verdict = judge({ head, base: BASE, amnesty: null });
    expect(verdict.code).toBe(1);
    expect(structureOf(verdict)[0].detail).toContain('w40');
  });

  it('reports the orphan before the entry is treated as a correction of what it truncated', () => {
    const head = `# Changelog\n\n## [Unreleased]\n\n- ${prose(40)}\n\n${prose(50).split(' ').slice(40).join(' ')}\n`;
    const verdict = judge({ head, base: BASE, amnesty: null });
    expect(verdict.violations[0].rule).toBe('structure');
    expect(lossOf(verdict).removed).toEqual([PUBLISHED]);
  });

  it('takes the same trim made as one entry: an indented continuation and ten words deliberately gone', () => {
    const kept = prose(40).split(' ');
    const head = `# Changelog\n\n## [Unreleased]\n\n- ${kept.slice(0, 20).join(' ')}\n  ${kept.slice(20).join(' ')}\n`;
    const verdict = judge({ head, base: BASE, amnesty: null });
    expect(verdict.code).toBe(0);
  });

  it('leaves prose already orphaned at the base revision alone, entry and all', () => {
    const published = `# Changelog\n\n## [Unreleased]\n\n- ${PUBLISHED}\n\n  ${prose(30, 'p')}\n`;
    const head = `${published}\n- A new entry that is well inside the budget.\n`;
    const verdict = judge({ head, base: published, amnesty: null });
    expect(verdict.code).toBe(0);
  });

  it('refuses a truncation whose orphaned words another entry happens to carry already', () => {
    const tail = PUBLISHED.split(' ').slice(40).join(' ');
    const base = `# Changelog\n\n## [Unreleased]\n\n- ${PUBLISHED}\n\n- An unrelated bullet of its own.\n\n  ${tail}\n`;
    const head = `# Changelog\n\n## [Unreleased]\n\n- ${prose(40)}\n\n${tail}\n\n- An unrelated bullet of its own.\n\n  ${tail}\n`;
    const verdict = judge({ head, base, amnesty: null });
    expect(verdict.code).toBe(1);
    expect(structureOf(verdict)).toHaveLength(1);
    expect(lossOf(verdict).removed).toEqual([PUBLISHED]);
  });

  it('takes a correction to an entry that carries orphaned prose, leaving the prose where it was', () => {
    const orphan = prose(30, 'p');
    const base = `# Changelog\n\n## [Unreleased]\n\n- ${PUBLISHED}\n\n  ${orphan}\n`;
    const head = base.replace('w20 ', 'w20-corrected ');
    expect(judge({ head, base, amnesty: null }).code).toBe(0);
  });

  it('takes two corrections whose likeliest pairing is the cross one, each keeping its own paragraph', () => {
    const shared = prose(30, 'c');
    const withProse = (entry, tail) => `- ${shared} ${entry}\n\n  ${tail}\n`;
    const base = `# Changelog\n\n## [Unreleased]\n\n${withProse('a0 a1 a2', prose(10, 'p'))}\n${withProse('b0 b1 b2', prose(10, 'q'))}`;
    const head = `# Changelog\n\n## [Unreleased]\n\n${withProse('b0 b1 a2', prose(10, 'p'))}\n${withProse('a0 a1 b2', prose(10, 'q'))}`;
    const verdict = judge({ head, base, amnesty: null });
    expect(structureOf(verdict)).toEqual([]);
    expect(verdict.code).toBe(0);
  });

  it("lets only one added entry borrow a predecessor's published paragraph, never two", () => {
    const shared = prose(30, 'c');
    const orphan = prose(10, 'p');
    const base = `# Changelog\n\n## [Unreleased]\n\n- ${shared} a0 a1 a2\n\n  ${orphan}\n`;
    const head = `# Changelog\n\n## [Unreleased]\n\n- ${shared} a0 a1 x\n\n  ${orphan}\n\n- ${shared} a0 a1 y\n\n  ${orphan}\n`;
    const verdict = judge({ head, base, amnesty: null });
    expect(verdict.code).toBe(1);
    expect(structureOf(verdict)).toHaveLength(1);
  });

  it('refuses a brand-new entry split the same way, which loses nothing but records less than it says', () => {
    const head = `${BASE}\n- ${prose(20, 'n')}\n\n${prose(10, 'm')}\n`;
    const verdict = judge({ head, base: BASE, amnesty: null });
    expect(structureOf(verdict)).toHaveLength(1);
    expect(structureOf(verdict)[0].detail).toContain('m0');
  });
});

describe('an over-budget entry that is not a correction', () => {
  const prose = (n, tag = 'w') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');
  const budgetOf = (verdict) => (verdict.violations ?? []).find((v) => v.rule === 'entry-budget');
  const record = (...entries) =>
    `# Changelog\n\n## [Unreleased]\n\n${entries.map((e) => `- ${e}\n`).join('\n')}`;

  const SHORT = 'A short entry that also shipped.';
  const PUBLISHED = prose(120);
  const BASE = record(PUBLISHED, SHORT);

  it('names a replacement too wide to pair as a new entry, not as an edit of what it replaced', () => {
    const replacement = prose(103, 'r');
    const verdict = judge({ head: record(replacement, SHORT), base: BASE, amnesty: null });
    expect(verdict.code).toBe(1);
    expect(budgetOf(verdict).removed[0]).toContain('new entry');
    expect(budgetOf(verdict).removed[0]).not.toContain('120');
  });

  it('does not advertise the inherited ceiling to a refusal no entry in it inherited', () => {
    const replacement = prose(103, 'r');
    const verdict = judge({ head: record(replacement, SHORT), base: BASE, amnesty: null });
    expect(budgetOf(verdict).detail).not.toContain('the larger of');
  });

  it('does advertise it where an entry in the refusal did inherit one', () => {
    const grown = `${PUBLISHED} ${prose(10, 'x')}`;
    const verdict = judge({ head: record(grown, SHORT), base: BASE, amnesty: null });
    expect(budgetOf(verdict).removed[0]).toContain('correcting an entry of 120');
    expect(budgetOf(verdict).detail).toContain('what that entry held');
  });
});
