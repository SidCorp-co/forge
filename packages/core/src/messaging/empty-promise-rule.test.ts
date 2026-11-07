import { describe, expect, it } from 'vitest';
import { facts } from './facts.js';
import { NO_EMPTY_PROMISE } from './text-rules.js';

// @direct-test-of packages/core/src/messaging/text-rules.ts
//
// ISS-1122: the no-empty-promise rule refuses a promise of a later act the writer has no turn for,
// never a state. In Vietnamese the present-tense and not-yet markers describe a state: an order in
// transit, one with no tracking number, or a quoted status name. The two posts the
// epod room's agent had refused on 2026-11-07 are here word for word, and must pass.

const NONE = facts({
  prefix: 'ISS',
  prefixes: ['ISS'],
  knownIssueIds: new Set(),
  knownIssueSeqs: new Set(),
  issueRows: new Map(),
  toolCalls: [],
  progress: null,
});

const refused = (text: string) => NO_EMPTY_PROMISE.check(text, NONE).length > 0;

describe('ISS-1122: a state described in Vietnamese is no promise', () => {
  it.each([
    'Đơn không có kiện thì store nhận trạng thái "đang xử lý", không kèm mã vận đơn.', // i18n-allow: the post refused on 2026-11-07, word for word
    '205 đơn tạo từ 01/10 trên 26 site đã bật tracking: chiều nay gửi 569 đơn đang vận chuyển, lần này gửi thêm 621…', // i18n-allow: the post refused on 2026-11-07, word for word
    'Đơn 4321 đang xử lý ở kho, chưa có mã vận đơn.', // i18n-allow: an order's state, the subject a third party
    'Hệ thống đang kiểm tra địa chỉ của đơn này.', // i18n-allow: a system's state, not the writer's act
    'Bản phát hành này chưa có trên production.', // i18n-allow: an absent state
    'Đơn này chưa được giao.', // i18n-allow: an absent state
    'Yêu cầu đang chờ duyệt.', // i18n-allow: a state the brief names as passing
    'The order is being processed and has no tracking number yet.',
    'Mình đang xem hai đơn RIV-68493 và RIV-68340 của bạn nhé.', // i18n-allow: a sentence the rule never refused, kept passing
  ])('passes "%s"', (text) => {
    expect(refused(text)).toBe(false);
  });
});

describe('ISS-1122: a promise of a later act is still refused', () => {
  it.each([
    'Mình sẽ kiểm tra lại độ rộng panel và báo lại bạn sau.', // i18n-allow: the empty promise the rule exists for
    'Để mình kiểm tra.', // i18n-allow: a promise to check, named in the issue
    'Mình đang kiểm tra rồi báo lại.', // i18n-allow: a promise to report back, named in the issue
    'Mình đang xử lý, xong sẽ báo lại.', // i18n-allow: the writer's own act in progress, with a report owed
    'Đang kiểm tra rồi báo lại bạn nhé.', // i18n-allow: the same promise with its subject dropped
    'Bên mình sẽ phản hồi trong hôm nay.', // i18n-allow: a reply owed later
    "I'll check the export and get back to you.",
    "I'm checking the export now.",
    'Let me look into that.',
  ])('refuses "%s"', (text) => {
    expect(refused(text)).toBe(true);
  });
});

describe('ISS-1122: a check and a report told as what happened are no promise', () => {
  it('passes a warehouse that checked and then told the customer', () => {
    expect(refused('Kho kiểm tra xong rồi báo lại cho khách hôm qua.')).toBe(false); // i18n-allow: a past act of a third party
  });
});
