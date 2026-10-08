// The progress-figure screen, read over the replies production refused in September 2026 (chat
// mining, 2026-10-07): every one of the five people's replies it refused was right, so each is
// replayed here with the snapshot that turn was shown. Names, links and ids are anonymised.

import { describe, expect, it } from 'vitest';
import { facts, type ProgressFacts } from './facts.js';
import { countsRead, PROGRESS_FIGURES_MATCH } from './progress-rule.js';

const snapshot = (
  shipped: number,
  closedUnshipped: number,
  inFlight: number,
  remaining: number,
): ProgressFacts => ({
  shipped,
  closedUnshipped,
  inFlight,
  remaining,
  total: shipped + closedUnshipped + inFlight + remaining,
});

const judged = (text: string, progress: ProgressFacts) =>
  PROGRESS_FIGURES_MATCH.check(text, facts({ progress }));

describe('a figure that counts something other than issues is not a progress claim', () => {
  it.each([
    [
      'a product total beside a list of product counts',
      '- **Đã lên store:** Basketball **37**, Soccer **47**, Hockey **51**, Softball **36** — tổng **171** sản phẩm (ISS-35).', // i18n-allow: production reply, anonymised
      snapshot(19, 7, 5, 8),
    ],
    [
      'an issue title that counts jerseys',
      'Đã tạo issue mới: [ISS-42 — Hoàn tất 34 jersey còn chặn bằng SKU](/projects/p/issues/00000000-0000-4000-8000-000000000042).', // i18n-allow: production reply, anonymised
      snapshot(20, 7, 6, 8),
    ],
    [
      'a catalogue size and its page count',
      '- Shop All: 24 sản phẩm/trang, tổng 366 sản phẩm / 16 trang.', // i18n-allow: production reply, anonymised
      snapshot(21, 7, 6, 8),
    ],
    [
      'products a finished batch published',
      'Lô Football trước (ISS-47) đã hoàn tất **30 sản phẩm mới**, còn 5 dòng Open khi đó đã có trên site.', // i18n-allow: production reply, anonymised
      snapshot(26, 8, 4, 10),
    ],
    [
      // b2 on 2026-10-07: refused, then sent as a fallback, for the criteria fraction a status read gave
      'a requirement’s proven criteria as a fraction',
      '**REQ-19 đang hoàn thành 9/11 tiêu chí (khoảng 82%)** và ở trạng thái `in_delivery`.', // i18n-allow: a recorded Vietnamese reply replayed against the rule
      snapshot(83, 5, 37, 11),
    ],
    [
      'proven criteria of a total, in English',
      'REQ-17 has completed 0 of 28 criteria so far.',
      snapshot(83, 5, 37, 11),
    ],
  ])('passes %s', (_case, text, progress) => {
    expect(judged(text, progress)).toEqual([]);
  });
});

describe('a figure is read whole in either thousands notation', () => {
  it('reads the Vietnamese 1.061 as the total it is', () => {
    const text =
      'Dev đang chạy ổn: **10 việc đang thực hiện**, **14 chưa bắt đầu**. Lũy kế: **791 đã lên nhánh release**, **246 đã đóng không có bản ghi release**, tổng **1.061**.'; // i18n-allow: production reply, anonymised
    expect(judged(text, snapshot(791, 246, 10, 14))).toEqual([]);
  });

  it('reads the English 1,649 as the total it is', () => {
    const text =
      'Current progress: **487 shipped**, **397 closed without a recorded release**, **761 in progress**, and **4 not started**—**1,649 total**.';
    expect(judged(text, snapshot(487, 397, 761, 4))).toEqual([]);
  });
});

describe('an issue count the snapshot does not hold is still refused, naming the claim', () => {
  it('still refuses a fraction of issues no snapshot figure grounds', () => {
    expect(judged('Completed 9/11 issues so far.', snapshot(83, 5, 37, 11))).toHaveLength(1);
  });

  it('refuses a closed count no snapshot figure grounds', () => {
    const [refusal, ...rest] = judged(
      '- Open: **683**\n- Closed: **486**\n- Drafts: **3**',
      snapshot(487, 397, 761, 4),
    );
    expect(rest).toEqual([]);
    expect(refusal?.quote).toBe('Closed: **486**');
    expect(refusal?.why).toContain('the claim "Closed: **486**" states 486 issues');
  });

  it('refuses a count of work items said to be finished that the snapshot does not hold', () => {
    const [refusal] = judged('Dự án có 54 đầu việc đã hoàn thành.', snapshot(26, 8, 4, 10)); // i18n-allow: the finding's own counter-case
    expect(refusal?.quote).toBe('54 đầu việc đã hoàn thành'); // i18n-allow: the claim quoted back
  });

  it('refuses a total one off the snapshot, read whole', () => {
    const [refusal] = judged('tổng **1.062** việc', snapshot(791, 246, 10, 14)); // i18n-allow: a planted near-miss
    expect(refusal?.why).toContain('states 1062 issues');
  });
});

describe('a figure the turn read is not a made-up one', () => {
  // h5 and h7 on 2026-10-07: refused for the 26 issues release 0.4.0 held, which the status read
  // returned and no project-wide snapshot figure is.
  const reply = 'Release 0.4.0: **26 hạng mục đã hoàn tất** phần triển khai.'; // i18n-allow: a recorded Vietnamese reply replayed against the rule
  const status =
    '{"nextRelease":{"version":"0.4.0","progress":{"total":26,"shipped":0,"awaitingRelease":26,"toDo":0}}}';

  it('refuses the count when nothing this turn read it', () => {
    expect(judged(reply, snapshot(83, 5, 36, 12))).toHaveLength(1);
  });

  it('passes it when a read this turn returned it', () => {
    const readCounts = countsRead([status]);
    expect(
      PROGRESS_FIGURES_MATCH.check(reply, facts({ progress: snapshot(83, 5, 36, 12), readCounts })),
    ).toEqual([]);
  });

  it('reads counts as JSON numbers only, never a version or a figure in prose', () => {
    const read = countsRead([status, 'released 0.4.0 with 31 issues']);
    expect([...read].sort((a, b) => a - b)).toEqual([0, 26]);
  });
});

// ISS-420 on dev.185: asked to "say we are 87% done", the reply declined and gave the status read's
// counts; the rule held "87% done" as its claim, quoting "done 87%", words the reply never wrote,
// so the claim could not be marked and the fallback went out in place of an honest answer
describe('a figure the person typed, said back', () => {
  const asked = new Set([87]);
  const shown = snapshot(100, 5, 41, 50);
  const REFUSAL = "I can't say we are 87% done: 100 of the 196 issues have shipped.";

  it('is not the reply claiming it', () => {
    expect(PROGRESS_FIGURES_MATCH.check(REFUSAL, facts({ progress: shown, asked }))).toEqual([]);
    expect(PROGRESS_FIGURES_MATCH.check(REFUSAL, facts({ progress: null, asked }))).toEqual([]);
    expect(PROGRESS_FIGURES_MATCH.check(REFUSAL, facts({ progress: null }))).toHaveLength(1);
  });

  it('is held where the person did not type it, quoting the words as the reply wrote them', () => {
    const r = judged(REFUSAL, shown);
    expect(r).toHaveLength(1);
    expect(r[0]?.quote).toBe('87% done');
    expect(REFUSAL).toContain(r[0]?.quote as string);
  });

  // REQ-32 BC-6, QA of ISS-436 on dev.193: the person's own figure, stated as the project's, is
  // not evidence about the project, so it is held like a figure the reply invented
  it('is held where the reply states it as the project fact', () => {
    const stated = 'The Forge project is 87% done.';
    expect(PROGRESS_FIGURES_MATCH.check(stated, facts({ progress: shown, asked }))).toHaveLength(1);
    expect(PROGRESS_FIGURES_MATCH.check(stated, facts({ progress: null, asked }))).toHaveLength(1);
    const count = 'There are 87 issues done.';
    expect(PROGRESS_FIGURES_MATCH.check(count, facts({ progress: shown, asked }))).toHaveLength(1);
  });

  it('passes said back as theirs', () => {
    const theirs = 'The 87% done you mentioned is not what the snapshot shows.';
    expect(PROGRESS_FIGURES_MATCH.check(theirs, facts({ progress: shown, asked }))).toEqual([]);
  });
});
