import { describe, expect, it } from 'vitest';
import { unionInsertions } from './union.mjs';

const base = '# Changelog\n\n## [Unreleased]\n\n- base entry\n- older entry\n';

describe('unionInsertions', () => {
  it('keeps both sides where each added an entry at the same place', () => {
    const ours = base.replace('- base entry', '- ours entry\n- base entry');
    const theirs = base.replace('- base entry', '- theirs entry\n- base entry');
    expect(unionInsertions({ base, ours, theirs, path: 'CHANGELOG.md' }).text).toBe(
      '# Changelog\n\n## [Unreleased]\n\n- theirs entry\n- ours entry\n- base entry\n- older entry\n',
    );
  });

  it('places an insertion after the base line it follows, however far the combination moved it', () => {
    const ours = `# Changelog\n\nA new preface.\nOf two lines.\n${base.slice('# Changelog\n\n'.length)}`;
    const theirs = base.replace('- older entry', '- older entry\n- oldest entry');
    const { text } = unionInsertions({ base, ours, theirs, path: 'CHANGELOG.md' });
    expect(text.endsWith('- older entry\n- oldest entry\n')).toBe(true);
    expect(text).toContain('A new preface.');
  });

  it('refuses a member that rewrote a line, rather than keeping both versions', () => {
    const theirs = base.replace('- older entry', '- older entry, corrected');
    expect(unionInsertions({ base, ours: base, theirs, path: 'CHANGELOG.md' }).refusal).toBe(
      'CHANGELOG.md: this member removes or rewrites line 6 (`- older entry`), and a union path only takes additions',
    );
  });

  it('refuses an addition after a line the combination rewrote', () => {
    const ours = base.replace('- older entry', '- older entry, corrected');
    const theirs = base.replace('- older entry', '- older entry\n- after it');
    expect(unionInsertions({ base, ours, theirs, path: 'CHANGELOG.md' }).refusal).toMatch(
      /adds after line 6 \(`- older entry`\), which the combination removed or rewrote$/,
    );
  });

  it('takes a file both sides created as the member’s lines above the combination’s', () => {
    expect(unionInsertions({ base: '', ours: 'a\n', theirs: 'b\n', path: 'x' }).text).toBe(
      'b\na\n',
    );
  });
});
