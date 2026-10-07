// The progress-figure screen, read over the replies production refused in September 2026 (chat
// mining, 2026-10-07): every one of the five people's replies it refused was right, so each is
// replayed here with the snapshot that turn was shown. Names, links and ids are anonymised.

import { describe, expect, it } from 'vitest';
import { facts, type ProgressFacts } from './facts.js';
import { PROGRESS_FIGURES_MATCH } from './progress-rule.js';

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
