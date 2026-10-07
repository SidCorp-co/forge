// The production replies that stated tracker facts no tool had read this turn (chat mining
// 2026-10-07, anonymised): every completion date given as 2024-05-15 with no tool call while the
// tracker held 2026-07-14/15, and an issue said to be closed that the person saw still open.

import { describe, expect, it } from 'vitest';
import { facts } from './facts.js';
import { datesIn, ungroundedClaims, withGrounding } from './grounding-rule.js';
import { admitted } from './screen.js';

const rows = (pairs: [number, string][]) =>
  facts({
    prefix: 'ISS',
    prefixes: ['ISS'],
    issueRows: new Map(pairs.map(([seq, status]) => [seq, { seq, merged: false, status }])),
    knownIssueSeqs: new Set(pairs.map(([seq]) => seq)),
  });

const ISSUE_59_READ = 'ISS-59 · closed · mergedAt 2026-07-15T03:12:00Z · Export filter by date';

describe('a tracker date in a reply is one this turn read', () => {
  it('refuses the invented completion date when the turn read nothing', () => {
    const breaks = ungroundedClaims(
      'ISS-59 hoàn thành ngày 2024-05-15.', // i18n-allow: a production ask or reply replayed as the test case
      [],
      rows([[59, 'closed']]),
    );
    const why = breaks.map((b) => b.why);
    expect(why).toHaveLength(2);
    expect(why[0]).toContain('2024-05-15');
    expect(why[0]).toContain('read nothing');
    expect(why[1]).toContain('without reading ISS-59 this turn');
  });

  it('refuses the invented date when the turn read the issue and it says otherwise', () => {
    const breaks = ungroundedClaims(
      'ISS-59 was closed on 2024-05-15.',
      [ISSUE_59_READ],
      rows([[59, 'closed']]),
    );
    expect(breaks.map((b) => b.why).join('\n')).toContain(
      'no tool result this turn carries that date',
    );
  });

  it('passes the date the turn read, and its day either side of a midnight timestamp', () => {
    const f = rows([[59, 'closed']]);
    expect(ungroundedClaims('ISS-59 was closed on 2026-07-15.', [ISSUE_59_READ], f)).toEqual([]);
    expect(ungroundedClaims('ISS-59 đã đóng ngày 16/07/2026.', [ISSUE_59_READ], f)).toEqual([]); // i18n-allow: a production ask or reply replayed as the test case
  });

  it('abstains on a planned, hedged or asked date, and on a date about nothing in the tracker', () => {
    const f = rows([[59, 'closed']]);
    expect(ungroundedClaims('Bản release dự kiến phát hành 2026-10-20.', [], f)).toEqual([]); // i18n-allow: a production ask or reply replayed as the test case
    expect(ungroundedClaims('Should ISS-59 ship on 2026-10-20?', [], f)).toEqual([]);
    expect(ungroundedClaims('The meeting is 2026-10-20 at the office.', [], f)).toEqual([]);
  });

  it('reads ISO, day/month/year and the Vietnamese long form as calendar days', () => {
    const written = '2026-07-15, 15/07/2026, ngày 15 tháng 7 năm 2026'; // i18n-allow: the Vietnamese date form
    expect(datesIn(written).map((d) => d.ms)).toEqual([
      Date.UTC(2026, 6, 15),
      Date.UTC(2026, 6, 15),
      Date.UTC(2026, 6, 15),
    ]);
    expect(datesIn('2026-13-40')).toEqual([]);
  });
});

describe('a status a reply gives an issue is the status the tracker holds, read this turn', () => {
  it('refuses "closed" for an issue the tracker holds open — the person saw Open after a refresh', () => {
    const breaks = ungroundedClaims(
      'Đã xử lý: ISS-744 đã đóng.', // i18n-allow: a production ask or reply replayed as the test case
      ['ISS-744 · open'],
      rows([[744, 'open']]),
    );
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.why).toContain('the tracker holds ISS-744 at open');
  });

  it('refuses a right status stated without reading the issue this turn', () => {
    const breaks = ungroundedClaims('ISS-61 is draft.', [], rows([[61, 'draft']]));
    expect(breaks[0]?.why).toContain('without reading ISS-61 this turn');
  });

  it('passes a status the turn read, in English, Vietnamese or as the raw word', () => {
    const f = rows([
      [61, 'draft'],
      [62, 'in_progress'],
      [63, 'awaiting_release'],
    ]);
    const read = ['ISS-61 draft', 'ISS-62 in_progress', 'ISS-63 awaiting_release'];
    expect(ungroundedClaims('ISS-61 is draft', read, f)).toEqual([]);
    expect(ungroundedClaims('ISS-62 đang làm', read, f)).toEqual([]); // i18n-allow: a production ask or reply replayed as the test case
    expect(ungroundedClaims('ISS-63: `awaiting_release`', read, f)).toEqual([]);
    expect(ungroundedClaims('ISS-63 hoàn thành', read, f)).toEqual([]); // i18n-allow: a production ask or reply replayed as the test case
  });

  it('abstains on a denial, a question and an issue the project does not hold', () => {
    const f = rows([[744, 'open']]);
    expect(ungroundedClaims('ISS-744 chưa đóng.', [], f)).toEqual([]); // i18n-allow: a production ask or reply replayed as the test case
    expect(ungroundedClaims('Is ISS-744 closed?', [], f)).toEqual([]);
    expect(ungroundedClaims('ISS-9999 is closed.', [], f)).toEqual([]);
    expect(
      ungroundedClaims('ISS-744 đã đóng.', [], facts({ ...f, issueLookupFailed: true })), // i18n-allow: a production ask or reply replayed as the test case
    ).toEqual([]);
  });
});

describe('the grounding joins the cell verdict', () => {
  it('turns a passing verdict into a refusal naming the rule, and keeps an earlier refusal', () => {
    const f = rows([[59, 'closed']]);
    const refused = withGrounding(admitted(['x']), ['ISS-59 closed on 2024-05-15'], [], f);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.refusals[0]?.rule).toBe('tracker-facts-grounded');
    const kept = withGrounding(
      {
        ok: false,
        refusals: [{ rule: 'non-empty', why: 'w', quote: null, shape: 's', example: 'e' }],
      },
      ['ISS-59 closed on 2024-05-15'],
      [],
      f,
    );
    expect(!kept.ok && kept.refusals.map((r) => r.rule)).toEqual([
      'non-empty',
      'tracker-facts-grounded',
      'tracker-facts-grounded',
    ]);
    const clean = admitted(['fine']);
    expect(withGrounding(clean, ['Nothing about dates.'], [], f)).toBe(clean);
  });
});
