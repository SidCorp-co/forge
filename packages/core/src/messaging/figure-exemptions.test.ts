// The exemption table read both ways: every row's example passes with the table, and is held
// without that row — a row whose example something else already exempts is a row that tests nothing.

import { describe, expect, it } from 'vitest';
import {
  askedValues,
  FIGURE_EXEMPTIONS,
  figuresIn,
  readingsOf,
  statedFigures,
} from './figure-exemptions.js';

const unasked = (text: string, ask: string, table = FIGURE_EXEMPTIONS) => {
  const asked = askedValues(ask, table);
  return statedFigures(text, table).filter((f) => !f.readings.some((r) => asked.has(r.value)));
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
