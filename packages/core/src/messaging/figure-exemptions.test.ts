// The exemption table read both ways: every row's example passes with the table, and is held
// without that row — a row whose example something else already exempts is a row that tests nothing.

import { describe, expect, it } from 'vitest';
import {
  askedValues,
  askersOwn,
  FIGURE_EXEMPTIONS,
  figuresIn,
  readingsOf,
  saidBackAt,
  statedFigures,
} from './figure-exemptions.js';

const unasked = (text: string, ask: string, table = FIGURE_EXEMPTIONS) => {
  const asked = askedValues(ask, table);
  return statedFigures(text, table).filter((f) => !askersOwn(text, f, asked));
};

describe('the figure exemption table', () => {
  for (const row of FIGURE_EXEMPTIONS) {
    const ask = 'ask' in row ? row.ask : '';
    it(`${row.id}: its example states no figure`, () => {
      expect(unasked(row.example, ask)).toEqual([]);
    });
    it(`${row.id}: its example states a figure without the row`, () => {
      const without = FIGURE_EXEMPTIONS.filter((r) => r !== row);
      expect(unasked(row.example, ask, without).length).toBeGreaterThan(0);
    });
  }

  it('names each row once, the six the rule owes and the asked count', () => {
    expect(FIGURE_EXEMPTIONS.map((r) => r.id).sort()).toEqual([
      'asked',
      'date',
      'id',
      'link',
      'ordinal',
      'quoted-source',
      'version',
    ]);
  });

  // ISS-442: "Release 0.4.0-dev.209 shipped" matched the `release <version>` form first, which
  // stopped at 0.4.0 and left "209 shipped" to be read as a count of shipped things
  it('reads a version named after its word whole, its prerelease part included', () => {
    for (const text of [
      'Release 0.4.0-dev.209 shipped to users yesterday.',
      'Version 1.2-rc.3 shipped.',
      'Bản 0.4.0-dev.209 đã phát hành.', // i18n-allow: a Vietnamese version with its prerelease part
    ]) {
      expect(statedFigures(text), text).toEqual([]);
    }
  });

  it('reads the Vietnamese rows too', () => {
    const vi = [
      'Đóng ngày 8 tháng 10 năm 2026.', // i18n-allow: a Vietnamese date
      'Xem ở bước 2, lần thứ 3, giai đoạn 4.', // i18n-allow: Vietnamese ordinals
      'Có trong phiên bản 0.4 rồi.', // i18n-allow: a Vietnamese version
    ];
    for (const text of vi) expect(figuresIn(text), text).toEqual([]);
  });

  it('reads a percentage, a ratio, a count, a state and a total as figures', () => {
    const said = (t: string) => statedFigures(t).map((f) => f.quote);
    expect(said('42% shipped')).toEqual(['42%']);
    expect(said('17 of 42 are ready, 3/5 in all.')).toEqual(['17', '42', '3', '5']);
    expect(said('There are 42 open issues and 3–5 days to go.')).toEqual(['42', '3', '5']);
    expect(said('42 issues, 17 shipped, 2 in progress.')).toEqual(['42', '17', '2']);
    expect(said('The total is 42.')).toEqual(['42']);
    expect(said('Có 42 issue, đã xong 17, còn 3 ngày.')).toEqual(['42', '17', '3']); // i18n-allow: a Vietnamese reply stating figures
    expect(said('Tỷ lệ là 41,7 phần trăm.')).toEqual(['41,7']); // i18n-allow: a Vietnamese percentage
  });

  it('abstains on a number not said as a figure: a size, a line, a port, a timeout', () => {
    for (const t of [
      'The panel is 900px wide on a 1366px screen.',
      'See line 42 of the file; the server listens on port 8080 open to all.',
      'The request times out after 30s and retries 3 times.',
      'Node 20 is required.',
    ]) {
      expect(statedFigures(t), t).toEqual([]);
    }
  });

  it('still reads a count that only looks like a month', () => {
    expect(figuresIn('There are 3 decisions and 2 marches.').map((f) => f.quote)).toEqual([
      '3',
      '2',
    ]);
  });
});

describe('a number as written', () => {
  it('keeps both readings of a group mark', () => {
    expect(readingsOf('1,234').map((r) => r.value)).toEqual([1234, 1.234]);
    expect(readingsOf('41,7')).toEqual([{ value: 41.7, decimals: 1 }]);
    expect(readingsOf('1.234,5').map((r) => r.value)).toEqual([1234.5]);
    expect(readingsOf('0.4.0')).toEqual([]);
  });
});

// REQ-32 BC-6: the person's number is theirs only said back, never stated as the project's
describe('a number the person typed', () => {
  const at = (text: string, n: string) => saidBackAt(text, text.indexOf(n));

  it('is said back where its clause names the person as its source', () => {
    expect(at('Here are the 5 oldest open items you asked for.', '5')).toBe(true);
    expect(at('Your 87% is not what the snapshot shows.', '87')).toBe(true);
    expect(at('Đây là 5 việc cũ nhất bạn hỏi.', '5')).toBe(true); // i18n-allow: a Vietnamese reply naming the person
  });

  it('is said back where the reply declines it before saying it', () => {
    expect(at("I can't say we are 87% done.", '87')).toBe(true);
    expect(at('Forge does not have 4,812 open issues.', '4,812')).toBe(true);
  });

  it('is stated where its clause neither names the person nor declines it', () => {
    expect(at('Forge has 4,812 open issues right now.', '4,812')).toBe(false);
    expect(at('Your project has 4,812 open issues.', '4,812')).toBe(false);
    expect(at('Not 40, Forge has 4,812 open issues.', '4,812')).toBe(false);
    expect(at('You asked earlier. Forge has 4,812 open issues.', '4,812')).toBe(false);
  });

  it('is never theirs where the person did not type it', () => {
    const text = 'Here are the 5 oldest open items you asked for.';
    const [five] = statedFigures(text);
    expect(five && askersOwn(text, five, new Set([5]))).toBe(true);
    expect(five && askersOwn(text, five, new Set([6]))).toBe(false);
  });
});
