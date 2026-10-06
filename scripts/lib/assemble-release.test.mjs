import { describe, expect, it } from 'vitest';
import { assembleRelease } from './assemble-release.mjs';

const HEADER = '# Changelog\n\n> Cutoff note.\n\n';
const OLDER = '## [0.4.0-dev.61] - 2026-10-06\n\nOlder\n\n### Fixed\n\n- **Old.** old\n';

describe('the release writer folds fragments into a version section', () => {
  it("writes dev.62's section shape: heading, headline, one ### per section, a tight list", () => {
    const out = assembleRelease(
      HEADER + OLDER,
      [
        {
          file: 'iss-dialog-deny.fixed.md',
          text: '**A permission dialog no longer freezes a pane.**\nThe box denies it.\n',
        },
        {
          file: 'fb-reopened.fixed.md',
          text: '**A reopened item can no longer be verified.** Only triage.\n',
        },
      ],
      '0.4.0-dev.62',
      '2026-10-06',
      'Runner panes deny dialogs',
    );
    expect(out).toBe(
      `${HEADER}## [0.4.0-dev.62] - 2026-10-06\n\nRunner panes deny dialogs\n\n### Fixed\n\n` +
        '- **A reopened item can no longer be verified.** Only triage.\n' +
        '- **A permission dialog no longer freezes a pane.** The box denies it.\n\n' +
        OLDER,
    );
  });

  it('lists sections in the release-notes order whatever order the files come in', () => {
    const out = assembleRelease(
      HEADER + OLDER,
      [
        { file: 'b.fixed.md', text: '**F.** f' },
        { file: 'a.added.md', text: '**A.** a' },
        { file: 'c.security.md', text: '**S.** s' },
      ],
      '1.0.0',
      '2026-10-07',
      'H',
    );
    const order = [...out.matchAll(/^### (\w+)/gm)].map((m) => m[1]);
    expect(order.slice(0, 3)).toEqual(['Added', 'Fixed', 'Security']);
  });

  it('a record with no released section yet takes the section at its end', () => {
    expect(
      assembleRelease(
        '# Changelog\n',
        [{ file: 'a.added.md', text: '**A.** a' }],
        '1.0.0',
        'd',
        'H',
      ),
    ).toBe('# Changelog\n\n## [1.0.0] - d\n\nH\n\n### Added\n\n- **A.** a\n');
  });
});

describe('the release writer refuses what it cannot write', () => {
  it('no fragments is refused by name', () => {
    expect(() => assembleRelease(HEADER + OLDER, [], '1.0.0', 'd', 'H')).toThrow(
      'no fragments under changelog.d/ — nothing to release',
    );
  });

  it('a record still carrying [Unreleased] is refused, so its entries are not left behind', () => {
    expect(() =>
      assembleRelease(
        `${HEADER}## [Unreleased]\n\n- **X.** x\n\n${OLDER}`,
        [{ file: 'a.fixed.md', text: '**A.** a' }],
        '1',
        'd',
        'H',
      ),
    ).toThrow('still carries `## [Unreleased]`');
  });

  it('a malformed fragment is refused naming its path, not published', () => {
    expect(() =>
      assembleRelease(HEADER + OLDER, [{ file: 'a.bugfix.md', text: 'no lead' }], '1', 'd', 'H'),
    ).toThrow(/changelog\.d\/a\.bugfix\.md names section `bugfix`.*does not open with a bold lead/);
  });
});
