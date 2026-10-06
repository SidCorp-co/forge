import { describe, expect, it } from 'vitest';
import { judge } from './release-record.mjs';

const RECORD =
  '# Changelog\n\n## [1.0.0] - 2026-10-06\n\nOne\n\n### Fixed\n\n- **Old.** It shipped.\n';
const rules = (verdict) => (verdict.violations ?? []).map((v) => v.rule);
const fragment = (file, text) => ({ file, text });

describe('unreleased entries are fragments', () => {
  it('a new fragment beside an untouched record holds', () => {
    const verdict = judge({
      head: RECORD,
      base: RECORD,
      fragments: { head: [fragment('iss-1.fixed.md', '**New.** It works now.\n')], base: [] },
    });
    expect(verdict.code).toBe(0);
  });

  it('a release folding the base fragments into a version section holds', () => {
    const released = RECORD.replace(
      '## [1.0.0]',
      '## [1.0.1] - 2026-10-07\n\nTwo\n\n### Fixed\n\n- **New.** It works now.\n\n## [1.0.0]',
    );
    const verdict = judge({
      head: released,
      base: RECORD,
      fragments: { head: [], base: [fragment('iss-1.fixed.md', '**New.**\nIt works now.')] },
    });
    expect(verdict).toMatchObject({ code: 0, violations: [] });
  });

  it('a promotion carrying several releases at once holds: a new version section is a release', () => {
    const promoted = RECORD.replace(
      '## [1.0.0]',
      '## [1.0.2] - 2026-10-08\n\nThree\n\n### Added\n\n- **B.** b\n\n## [1.0.1] - 2026-10-07\n\nTwo\n\n### Fixed\n\n- **A.** a\n\n## [1.0.0]',
    );
    expect(judge({ head: promoted, base: RECORD }).code).toBe(0);
  });

  it('a fragment deleted without a release is a loss', () => {
    const verdict = judge({
      head: RECORD,
      base: RECORD,
      fragments: { head: [], base: [fragment('iss-1.fixed.md', '**New.** It works now.')] },
    });
    expect(rules(verdict)).toEqual(['no-silent-loss']);
  });
});

describe('an entry written where the replaced guidance put it is refused by name', () => {
  it('an entry under [Unreleased] names the fragment path to move it to', () => {
    const head = RECORD.replace(
      '## [1.0.0]',
      '## [Unreleased]\n\n### Added\n\n- **New.** It works now.\n\n## [1.0.0]',
    );
    const verdict = judge({ head, base: RECORD, fragmentName: 'iss-7-lane' });
    expect(rules(verdict)).toEqual(['unreleased-in-record']);
    expect(verdict.violations[0].removed).toEqual([
      'changelog.d/iss-7-lane.added.md ← **New.** It works now.',
    ]);
  });

  it('an empty [Unreleased] heading is refused too: the record holds released sections only', () => {
    const head = RECORD.replace('## [1.0.0]', '## [Unreleased]\n\n## [1.0.0]');
    expect(rules(judge({ head, base: RECORD }))).toEqual(['unreleased-in-record']);
  });

  it('an entry written straight into a released section is refused, naming the fragment', () => {
    const head = RECORD.replace(
      '- **Old.** It shipped.',
      '- **Old.** It shipped.\n- **Merged in late.** It landed here.',
    );
    const verdict = judge({ head, base: RECORD, fragmentName: 'iss-8' });
    expect(rules(verdict)).toEqual(['entry-outside-a-fragment']);
    expect(verdict.violations[0].detail).toContain('changelog.d/iss-8.fixed.md');
  });

  it('a correction of a published entry is still an edit, not a direct write', () => {
    const base = RECORD.replace('It shipped.', 'It shipped to every project on the dev box today.');
    const head = base.replace('today.', 'on Monday.');
    expect(judge({ head, base }).code).toBe(0);
  });
});

describe('a fragment that is not one is refused by path', () => {
  const at = (file, text) =>
    judge({ head: RECORD, base: RECORD, fragments: { head: [fragment(file, text)], base: [] } });

  it('the directory README is not a fragment', () => {
    expect(at('README.md', '# Unreleased changelog entries\n\nOne change, one file.').code).toBe(0);
  });

  it('no bold lead', () => {
    const verdict = at('iss-1.fixed.md', 'It works now.');
    expect(rules(verdict)).toEqual(['fragment-shape']);
    expect(verdict.violations[0].detail).toContain(
      '`changelog.d/iss-1.fixed.md` does not open with a bold lead',
    );
  });

  it('a section that is not a release-note section', () => {
    expect(at('iss-1.bugfix.md', '**New.** x').violations[0].detail).toContain(
      'names section `bugfix`',
    );
  });

  it('a name that is not lower-case kebab', () => {
    expect(at('ISS_1.fixed.md', '**New.** x').violations[0].detail).toContain('is not named');
  });

  it('two paragraphs, a heading, a list marker', () => {
    expect(at('a.fixed.md', '**A.** a\n\n**B.** b').violations[0].detail).toContain(
      'more than one paragraph',
    );
    expect(at('a.fixed.md', '### Fixed\n**A.** a').violations[0].detail).toContain(
      'holds a heading',
    );
    expect(at('a.fixed.md', '- **A.** a').violations[0].detail).toContain(
      'opens with a list marker',
    );
  });

  it('over the word budget, at 41 words, while 40 holds', () => {
    const words = (n) => `**Lead.** ${Array.from({ length: n - 1 }, () => 'w').join(' ')}`;
    expect(at('a.fixed.md', words(40)).code).toBe(0);
    expect(rules(at('a.fixed.md', words(41)))).toEqual(['entry-budget']);
  });
});
