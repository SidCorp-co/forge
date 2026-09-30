import { describe, expect, it } from 'vitest';
import { matchLines, unionInsertions } from './union.mjs';

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

  it("unions two entries into a changelog of this repository's size, beyond any cell budget", () => {
    const older = Array.from({ length: 7500 }, (_, i) => `- entry ${i}, from an older release`);
    const big = `# Changelog\n\n## [Unreleased]\n\n${older.join('\n')}\n`;
    const ours = big.replace('## [Unreleased]\n\n', '## [Unreleased]\n\n- ours entry\n');
    const theirs = big
      .replace('## [Unreleased]\n\n', '## [Unreleased]\n\n- theirs entry\n')
      .replace('- entry 7000, from', '- a late fix\n- entry 7000, from');
    const merged = unionInsertions({ base: big, ours, theirs, path: 'CHANGELOG.md' });
    expect(merged.refusal).toBeUndefined();
    expect(
      merged.text.startsWith(
        '# Changelog\n\n## [Unreleased]\n\n- theirs entry\n- ours entry\n- entry 0,',
      ),
    ).toBe(true);
    expect(merged.text).toContain('- a late fix\n- entry 7000, from');
    expect(merged.text.split('\n')).toHaveLength(7508);
  });
});

/** The length of a longest common subsequence, by the quadratic table the matcher replaced. */
function lcsLength(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (let i = a.length - 1; i >= 0; i--) {
    let diag = 0;
    for (let j = b.length - 1; j >= 0; j--) {
      const keep = row[j];
      row[j] = a[i] === b[j] ? diag + 1 : Math.max(row[j], row[j + 1]);
      diag = keep;
    }
  }
  return row[0];
}

function isSubsequence(small, big) {
  let i = 0;
  for (const line of big) if (i < small.length && line === small[i]) i++;
  return i === small.length;
}

const lines = (text) => (text === '' ? [] : text.slice(0, -1).split('\n'));

describe('unionInsertions over duplicated lines', () => {
  it('refuses a rewrite exactly where the base is not a subsequence of the member, and otherwise adds every line the member added', () => {
    let seed = 1340;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const edit = (base, maxDrop) => {
      const out = [];
      let dropped = 0;
      for (const line of base) {
        if (next() % 4 === 0) out.push(`+${'xy'[next() % 2]}`);
        if (dropped < maxDrop && next() % 6 === 0) dropped++;
        else out.push(line);
      }
      if (next() % 3 === 0) out.push(`+${'xy'[next() % 2]}`);
      return out;
    };
    const text = (ls) => ls.map((l) => `${l}\n`).join('');
    let accepted = 0;
    for (let round = 0; round < 3000; round++) {
      const b = Array.from({ length: next() % 10 }, () => '- same'.repeat(1 + (next() % 2)));
      const o = edit(b, 1);
      const t = edit(b, next() % 3 === 0 ? 1 : 0);
      const r = unionInsertions({ base: text(b), ours: text(o), theirs: text(t), path: 'C' });
      const rewrote = !isSubsequence(b, t);
      expect(r.refusal?.includes('removes or rewrites') ?? false, `${b}|${t}`).toBe(rewrote);
      if (r.text === undefined) continue;
      accepted++;
      const merged = lines(r.text);
      expect(isSubsequence(o, merged)).toBe(true);
      if (isSubsequence(b, o)) expect(isSubsequence(t, merged), `${b}|${o}|${t}`).toBe(true);
      expect(merged).toHaveLength(o.length + t.length - b.length);
    }
    expect(accepted).toBeGreaterThan(500);
  });

  it('refuses by name an addition anchored after a duplicated line the combination rewrote', () => {
    const base = 'x\nsame\nsame\ny\n';
    const ours = 'x\nsame\ny\n';
    const theirs = 'x\nsame\nsame\nadded\ny\n';
    expect(unionInsertions({ base, ours, theirs, path: 'C' }).refusal).toBe(
      'C: this member adds after line 3 (`same`), which the combination removed or rewrote',
    );
  });

  it('keeps an addition between two duplicated lines both sides still hold', () => {
    const base = 'x\nsame\nsame\ny\n';
    const ours = 'top\nx\nsame\nsame\ny\n';
    const theirs = 'x\nsame\nadded\nsame\ny\n';
    expect(unionInsertions({ base, ours, theirs, path: 'C' }).text).toBe(
      'top\nx\nsame\nadded\nsame\ny\n',
    );
  });
});

describe('matchLines', () => {
  it('matches a longest common subsequence, in order and line for line, on every random pair', () => {
    let seed = 1203;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 2000; round++) {
      const a = Array.from({ length: next() % 14 }, () => 'abc'[next() % 3]);
      const b = Array.from({ length: next() % 14 }, () => 'abc'[next() % 3]);
      const map = matchLines(a, b);
      const pairs = map.flatMap((j, i) => (j === -1 ? [] : [[i, j]]));
      for (const [k, [i, j]] of pairs.entries()) {
        expect(a[i]).toBe(b[j]);
        if (k > 0) expect(j).toBeGreaterThan(pairs[k - 1][1]);
      }
      expect(pairs.length, `${a.join('')} / ${b.join('')}`).toBe(lcsLength(a, b));
    }
  });
});
