import { describe, expect, it } from 'vitest';
import { judge, normaliseEntry, parseRecord } from './release-record.mjs';

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
