import { describe, expect, it } from 'vitest';
import { promoteUnreleased } from './promote-unreleased.mjs';

const RECORD = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Fixed',
  '',
  '- **A fix.** It is fixed.',
  '',
  '## [0.4.0-dev.49] - 2026-10-06',
  '',
  'Older',
  '',
].join('\n');

describe('cut-release promotes Unreleased into a version section', () => {
  it('the summary line is followed by exactly one blank line', () => {
    const out = promoteUnreleased(RECORD, '0.4.0-dev.50', '2026-10-06', 'Breakdowns carry waits');
    expect(out).toContain(
      '## [Unreleased]\n\n## [0.4.0-dev.50] - 2026-10-06\n\nBreakdowns carry waits\n\n### Fixed\n',
    );
  });
});

describe('cut-release refuses what it cannot promote', () => {
  it('a record with no Unreleased heading is refused by name', () => {
    expect(() => promoteUnreleased('# Changelog\n', '1.0.0', '2026-10-06', 'x')).toThrow(
      'no `## [Unreleased]` heading to promote',
    );
  });

  it('a flat Unreleased body and the sections below it keep their own spacing', () => {
    const flat = '## [Unreleased]\n- **A.** a\n\n## [1.0.0] - 2026-10-01\n\nOld\n';
    expect(promoteUnreleased(flat, '1.0.1', '2026-10-06', 'New')).toBe(
      '## [Unreleased]\n\n## [1.0.1] - 2026-10-06\n\nNew\n\n- **A.** a\n\n## [1.0.0] - 2026-10-01\n\nOld\n',
    );
  });
});
