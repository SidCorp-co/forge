import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type ChangelogError,
  changelogPath,
  isChangelogError,
  parseChangelog,
} from './changelog.js';

// Shaped as scripts/lib/assemble-release.mjs writes a version section (its test pins the same text).
const RECORD = `# Changelog

> Cutoff note.

## [0.4.0-dev.92] - 2026-10-08

A headline

### Digest

- <!-- digest: 2026-W41 --> **The week.** Screens and fixes.

### Added

- **A new screen.** It opens. <!-- tour: integrations -->

### Fixed

- **A fix.** Done.
  Carried on a second line.

- A legacy bullet. Without a lead.

## [0.4.0-dev.91] - 2026-10-07

Older

### Changed

- **Old.** Older text.
`;

function refusal(text: string): ChangelogError {
  try {
    parseChangelog(text, 'CHANGELOG.md');
  } catch (err) {
    if (isChangelogError(err)) return err;
    throw err;
  }
  throw new Error('the changelog parsed; it should have been refused');
}

describe('the changelog is read into releases', () => {
  const releases = parseChangelog(RECORD);

  it('reads each version section with its date, in the order written', () => {
    expect(releases.map((r) => [r.version, r.date])).toEqual([
      ['0.4.0-dev.92', '2026-10-08'],
      ['0.4.0-dev.91', '2026-10-07'],
    ]);
  });

  it('splits a bullet into its bold lead and the rest, joining continuation lines', () => {
    expect(releases[0]?.entries[1]).toEqual({
      section: 'Fixed',
      title: 'A fix.',
      body: 'Done. Carried on a second line.',
      tour: null,
    });
  });

  it('reads a `tour:` comment off an entry, invisible in its text', () => {
    expect(releases[0]?.entries[0]).toEqual({
      section: 'Added',
      title: 'A new screen.',
      body: 'It opens.',
      tour: 'integrations',
    });
  });

  it('reads a digest bullet with the week its comment names', () => {
    expect(releases[0]?.digests).toEqual([
      { week: '2026-W41', title: 'The week.', body: 'Screens and fixes.' },
    ]);
  });

  it('takes the first sentence of a bullet with no lead as its title', () => {
    expect(releases[0]?.entries[2]).toMatchObject({
      title: 'A legacy bullet.',
      body: 'Without a lead.',
    });
  });
});

describe('a section the reader cannot read is refused by file, version and line', () => {
  it('an unknown ### section', () => {
    const err = refusal(RECORD.replace('### Fixed', '### Misc'));
    expect(err.message).toContain('CHANGELOG.md:');
    expect(err).toMatchObject({ file: 'CHANGELOG.md', version: '0.4.0-dev.92', line: 17 });
    expect(err.message).toContain('`### Misc` is not a section');
  });

  it('a heading that is not `## [version] - date`', () => {
    const err = refusal(
      RECORD.replace('## [0.4.0-dev.91] - 2026-10-07', '## [0.4.0-dev.91] 2026-10-07'),
    );
    expect(err.line).toBe(24);
    expect(err.message).toContain('a section heading is `## [version] - YYYY-MM-DD`');
  });

  it('a date that is not a calendar day', () => {
    const err = refusal(RECORD.replace('2026-10-07', '2026-13-45'));
    expect(err).toMatchObject({ version: '0.4.0-dev.91' });
    expect(err.message).toContain('2026-13-45 is not a calendar date');
  });

  it('a version written twice', () => {
    expect(refusal(RECORD.replace('dev.91', 'dev.92')).message).toContain('more than one section');
  });

  it('a tour the catalog does not hold, naming the ones it does', () => {
    const err = refusal(RECORD.replace('tour: integrations', 'tour: nowhere'));
    expect(err).toMatchObject({ version: '0.4.0-dev.92', line: 15 });
    expect(err.message).toContain('tour "nowhere" is not in the catalog');
    expect(err.message).toContain('integrations');
  });

  it('a digest with no week, or over its words', () => {
    expect(refusal(RECORD.replace('<!-- digest: 2026-W41 --> ', '')).message).toContain(
      'opens with `<!-- digest: <ISO week> -->`',
    );
    const long = Array.from({ length: 121 }, () => 'w').join(' ');
    expect(refusal(RECORD.replace('Screens and fixes.', long)).message).toContain(
      'a digest body is at most 120 words; this is 121',
    );
  });

  it('a bullet before any section, and prose that reaches no entry', () => {
    expect(refusal(RECORD.replace('### Digest\n', '- **Stray.** x\n')).message).toContain(
      'a bullet sits before any `###` section',
    );
    const err = refusal(
      RECORD.replace('- **Old.** Older text.', '- **Old.** Older text.\n\nLoose prose.'),
    );
    expect(err.version).toBe('0.4.0-dev.91');
    expect(err.message).toContain('prose after a blank line reaches no entry');
  });
});

describe("this build's own CHANGELOG.md", () => {
  it('is read whole: every section, and the tours the catalog names are offered by an entry', () => {
    const releases = parseChangelog(readFileSync(changelogPath(), 'utf8'));
    expect(releases.length).toBeGreaterThan(60);
    const tours = new Set(releases.flatMap((r) => r.entries.map((e) => e.tour)));
    expect(tours).toContain('integrations');
    expect(tours).toContain('release-what-changes');
  });
});
