import { describe, expect, it } from 'vitest';
import {
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
    expect(v.removed[0]).toContain(`[${wordCount(long)} words]`);
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
    expect(budgetOf(verdict).removed[0]).toContain('[80 words]');
  });

  it('refuses an edit that grows an already-over-budget entry past what it held', () => {
    const grown = `${PUBLISHED} ${prose(10, 'x')}`;
    const verdict = judge({ head: record(grown, SHORT), base: BASE, amnesty: null });
    expect(verdict.code).toBe(1);
    expect(budgetOf(verdict).removed[0]).toContain('[130 words, was 120]');
    expect(lossOf(verdict)).toBeUndefined();
  });

  it('admits an edit that shrinks an over-budget entry without reaching the budget', () => {
    const trimmed = prose(90);
    expect(judge({ head: record(trimmed, SHORT), base: BASE, amnesty: null }).code).toBe(0);
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
    expect(budgetOf(verdict).removed[0]).toContain('[43 words]');
    expect(budgetOf(verdict).removed[0]).not.toContain('was');
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

  it('pairs one removed entry with at most one added one, so a split pays the budget for its other half', () => {
    const head = record(prose(100), prose(80), SHORT);
    const verdict = judge({ head, base: BASE, amnesty: null });
    expect(lossOf(verdict)).toBeUndefined();
    expect(budgetOf(verdict).removed).toHaveLength(1);
    expect(budgetOf(verdict).removed[0]).toContain('[80 words]');
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
