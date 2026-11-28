import { REPLY_RUBRIC_LINES, type ReplyRubricLine } from '@forge/contracts/support-reply-audit';
import { describe, expect, it } from 'vitest';
import { mapLine } from '../act-cards.js';
import { actClaimIn, liveStateClaimIn } from './code-lines.js';
import { AUDIT_RUBRIC_TEXT } from './index.js';
import { type AuditedReply, judgeReply, type TurnReads } from './judge.js';

// @direct-test-of packages/core/src/support/reply-audit/judge.ts
// @direct-test-of packages/core/src/support/reply-audit/teach.ts
// @direct-test-of packages/core/src/support/reply-audit/index.ts
// @direct-test-of packages/core/src/support/reply-audit/code-lines.ts
//
// ISS-1250 (owner 2026-11-16): the five quoted epod turns of the shared operations room, replayed
// through the verdict support.audit keeps. Even where the agent's own reading claims a pass, each
// fails naming the lines code can tell (grant talk, a direction to a screen, an API-host link); the
// lines only a reading can tell (the thread's context, the asker, the tone, accuracy) are the agent's
// own reading, which the replay supplies as an honest self-audit would. The four reference posts pass.

const API = ['forge-dev-api.sidcorp.co'];

const TURNS: Record<string, string> = {
  '16/11 02:21':
    'Dạ phòng này không cho em lưu quy tắc kênh. Để đổi, người quản lý phòng này trên Forge cần sửa cài đặt ngôn ngữ trong vai trò của em.', // i18n-allow: a quoted epod turn or reference post
  '16/11 02:22':
    'Phòng này không cho em sửa cài đặt dự án ạ. Anh hoặc master ePOD vào cài đặt của dự án ePOD trên Forge, đặt thành tiếng Anh là được.', // i18n-allow: a quoted epod turn or reference post
  '16/11 03:15':
    "Câu hỏi cũ về varnish vẫn mở, chỉ chủ dự án bấm chọn được — bấm 'Thêm varnish vào job deploy forge-ops' là đóng.", // i18n-allow: a quoted epod turn or reference post
  '16/11 03:16':
    'Yêu cầu nằm ở https://forge-dev-api.sidcorp.co/projects/epod/requirements/REQ-11 ạ.', // i18n-allow: a quoted epod turn or reference post
  '15/11 15:36':
    'Dạ phòng này chưa được cấp quyền đọc danh sách feedback, và dự án Forge hiện không có master trực.', // i18n-allow: a quoted epod turn or reference post
};

const GOOD: Record<string, string> = {
  '16/11 02:18':
    'ePOD v1.4.2 đã lên production: lỗi khi tải ảnh POD đã sửa, và các thông báo lỗi mới của CLI và theme bằng tiếng Việt.', // i18n-allow: a quoted epod turn or reference post
  '16/11 02:36': 'ePOD v1.4.3 đã lên production: nút in nhãn hiện lại trên trang đơn hàng.', // i18n-allow: a quoted epod turn or reference post
  '16/11 02:53': 'ePOD v1.4.4 đã lên production: báo cáo ngày xuất được file CSV.', // i18n-allow: a quoted epod turn or reference post
  '16/11 03:14':
    'Anh ơi, varnish cho forge-ops: 1) thêm vào job deploy, 2) để ngoài. Em đề xuất 1 vì cache đang trống sau mỗi lần deploy. Anh trả lời ngay trong luồng này nhé.', // i18n-allow: a quoted epod turn or reference post
};

/** What code alone names for each turn, whatever the agent's reading says. */
const BY_CODE: Record<string, ReplyRubricLine[]> = {
  '16/11 02:21': ['no_grant_talk', 'no_ui_directions'],
  '16/11 02:22': ['no_grant_talk', 'no_ui_directions'],
  '16/11 03:15': ['no_ui_directions'],
  '16/11 03:16': ['web_links'],
  '15/11 15:36': ['no_grant_talk'],
};

/**
 * The agent's honest reading of each turn, the lines no code can tell: 02:21 and 02:22 read the
 * owner's ruling as the room's settings when Babo's own 02:18 post had just named the epod product's
 * error language, and told the org owner to do it himself.
 */
const SELF: Record<string, ReplyRubricLine[]> = {
  '16/11 02:21': ['in_context', 'used_context', 'knew_asker', 'tone_fit_role', 'answered'],
  '16/11 02:22': ['in_context', 'used_context', 'knew_asker', 'tone_fit_role', 'answered'],
  '16/11 03:15': ['tone_fit_role', 'answered'],
  '16/11 03:16': [],
  '15/11 15:36': ['accurate', 'answered'],
};

const reply = (text: string): AuditedReply => ({
  text,
  roomKind: 'operations',
  apiHosts: API,
});
const reading = (lines: readonly ReplyRubricLine[]) =>
  lines.map((line) => ({ line, why: `the reply fails ${line}` }));

describe('support.audit keeps the verdict on a reply the agent posted (ISS-1250)', () => {
  it('fails each quoted epod turn on the lines code tells, even when the agent claims a pass', () => {
    for (const [at, text] of Object.entries(TURNS)) {
      const j = judgeReply(reply(text), []);
      expect({ at, verdict: j.verdict, failed: j.failed }).toEqual({
        at,
        verdict: 'fail',
        failed: BY_CODE[at],
      });
      expect(
        j.findings.every((f) => f.by === 'code'),
        at,
      ).toBe(true);
    }
  });

  it('names the thread, asker and tone lines of 02:21 and 02:22 from the agent’s own reading, beside code', () => {
    for (const [at, text] of Object.entries(TURNS)) {
      const j = judgeReply(reply(text), reading(SELF[at] ?? []));
      expect(new Set(j.failed), at).toEqual(new Set([...(SELF[at] ?? []), ...(BY_CODE[at] ?? [])]));
    }
    const j0221 = judgeReply(reply(TURNS['16/11 02:21'] ?? ''), reading(SELF['16/11 02:21'] ?? []));
    expect(j0221.findings.filter((f) => f.by === 'agent').map((f) => f.line)).toEqual(
      SELF['16/11 02:21'],
    );
  });

  it('passes the four reference posts, the 03:14 owner ask included', () => {
    for (const [at, text] of Object.entries(GOOD)) {
      const j = judgeReply(reply(text), []);
      expect({ at, verdict: j.verdict, failed: j.failed }).toEqual({
        at,
        verdict: 'pass',
        failed: [],
      });
    }
  });

  it('keeps one finding per line, the agent’s own first, where code finds it too', () => {
    const j = judgeReply(reply(TURNS['15/11 15:36'] ?? ''), [
      { line: 'no_grant_talk', why: 'I explained the room’s grant' },
    ]);
    expect(j.findings).toEqual([
      { line: 'no_grant_talk', why: 'I explained the room’s grant', by: 'agent' },
    ]);
  });

  // ISS-1451, ISS-1442 (FB-841, FB-852, FB-853): three rounds tuned the guess and failed live; it is a hint now
  it('raises no language finding for a reply in either language, whoever it answers', () => {
    const en = 'The release is live on production now, and the import is fixed.';
    const vi = 'Dạ chưa có cập nhật ạ, em sẽ báo anh ngay khi xong.'; // i18n-allow: a Vietnamese reply
    for (const text of [en, vi]) {
      const j = judgeReply(reply(text), []);
      expect(j.failed, text).not.toContain('language');
      expect(j.verdict, text).toBe('pass');
    }
  });

  it('tells no API-host link where the web app is served on that host too', () => {
    expect(judgeReply({ ...reply(TURNS['16/11 03:16'] ?? ''), apiHosts: [] }, []).verdict).toBe(
      'pass',
    );
  });

  it('teaches the tool every rubric line from the one rubric, and the brief the step', () => {
    for (const line of REPLY_RUBRIC_LINES) expect(AUDIT_RUBRIC_TEXT).toContain(`${line} (`);
    // the brief's line is support.audit's card, rendered (ISS-1251)
    expect(mapLine('audit')).toMatch(
      /^- When you posted a reply: audit it at once with support\.audit /,
    );
  });

  // ISS-1354 (FB-763, adminhub-api L-46): three failed audits in adminhub-api's room, each a statement
  // of a live setting resting on an earlier turn's read or a release seeder, after ISS-1329's teaching
  describe('a live-state claim is held to a read of its own turn (ISS-1354)', () => {
    const FB763 = [
      'Dạ chị, bên mình không có tài khoản API PGPrints nên chưa map được ạ.', // i18n-allow: a quoted FB-763 reply
      'Có sẵn ô store_id trong form nhà cung cấp rồi ạ.', // i18n-allow: a quoted FB-763 reply
    ];
    const earlier = new Date('2026-11-19T04:20:00Z');
    const judged = (text: string, reads: { thisTurn: boolean; earlierAt: Date | null }) =>
      judgeReply(
        {
          ...reply(text),
          roomKind: 'support',
          reads: { ...reads, looked: false, handedOn: false },
        },
        [],
      );

    it('reads each quoted reply as a claim of a live setting, and no plan or order state as one', () => {
      expect(FB763.map(liveStateClaimIn)).toEqual(['không có tài khoản', 'Có sẵn ô']); // i18n-allow: the quoted words
      expect(liveStateClaimIn('The PGPrints account is not set up yet.')).toBe('is not set up');
      expect(liveStateClaimIn('Em sẽ kiểm tra tài khoản PGPrints trên staging ạ.')).toBeNull(); // i18n-allow: a plan, no claim
      expect(liveStateClaimIn('Dạ, đơn hàng số 42 của anh đã giao hôm qua ạ.')).toBeNull(); // i18n-allow: an order's state
    });

    it('fails accurate where the claim rests on an earlier turn’s read, with that reason', () => {
      for (const text of FB763) {
        const j = judged(text, { thisTurn: false, earlierAt: earlier });
        expect(j.failed, text).toEqual(['accurate']);
        expect(j.findings[0]?.by).toBe('code');
        expect(j.findings[0]?.why).toContain(
          'from a read made in an earlier turn (2026-11-19T04:20:00.000Z), not one made in this turn',
        );
      }
      expect(
        judged(FB763[0] ?? '', { thisTurn: false, earlierAt: null }).findings[0]?.why,
      ).toContain('with no read of it made in this turn');
    });

    // ISS-1389 (FB-801, sidpeak): a room told its BA release 0.29.0's 16 issues were closed; the tracker showed them open
    it('holds a claim of an issue’s or release’s status to a read of its own turn, naming the read', () => {
      const FB801 = [
        'The 16 issues of release 0.29.0 are already closed.',
        'Release 0.29.0 has been deployed.',
        'ISS-21 is shipped.',
        'Các issue của release 0.29.0 đã đóng rồi ạ.', // i18n-allow: a quoted reply
      ];
      for (const text of FB801) {
        expect(liveStateClaimIn(text), text).not.toBeNull();
        const j = judged(text, { thisTurn: false, earlierAt: null });
        expect(j.failed, text).toContain('accurate');
        expect(j.findings.find((f) => f.line === 'accurate')?.why).toContain(
          'support.issues or support.releases',
        );
        expect(judged(text, { thisTurn: true, earlierAt: null }).failed, text).not.toContain(
          'accurate',
        );
      }
      expect(liveStateClaimIn('I will read the status of the issues after the deploy.')).toBeNull();
    });

    it('passes the same claim on a read of its own turn, and judges none where the turn is not on the record', () => {
      for (const text of FB763) {
        expect(judged(text, { thisTurn: true, earlierAt: null }).verdict, text).toBe('pass');
        expect(judgeReply({ ...reply(text), roomKind: 'support' }, []).verdict, text).toBe('pass');
      }
    });
  });
});

// ISS-1416 (FB-824, forge L-168): two replies stated a setting off from a read a turn old, and one
// told a raise landed in AdminHub API's technical thread when that raise had been refused there
describe('an on/off state and an act taken are held to their own turn (ISS-1416)', () => {
  const earlier = new Date('2026-11-21T11:30:57Z');
  const judged = (text: string, reads: Partial<TurnReads> = {}) =>
    judgeReply(
      {
        ...reply(text),
        roomKind: 'support',
        reads: { thisTurn: false, earlierAt: null, looked: false, handedOn: false, ...reads },
      },
      [],
    );

  it('fails accurate on a setting said off from an earlier turn’s read, naming that read’s time', () => {
    for (const text of [
      'Dạ tính năng đồng bộ trên staging chưa bật ạ.', // i18n-allow: the FB-824 shape
      'Dạ cờ gửi mail vẫn tắt ạ.', // i18n-allow: the FB-824 shape
    ]) {
      const j = judged(text, { earlierAt: earlier });
      expect(j.failed, text).toEqual(['accurate']);
      expect(j.findings[0]?.why, text).toContain('(2026-11-21T11:30:57.000Z)');
      expect(judged(text, { thisTurn: true }).verdict, text).toBe('pass');
    }
  });

  it('reads a report of an act landed elsewhere as a claim, and no plan or act not taken as one', () => {
    expect(actClaimIn("The host step was already raised in AdminHub API's technical thread.")).toBe(
      "raised in AdminHub API's technical thread",
    );
    const vi = 'Em đã báo lên luồng kỹ thuật của AdminHub API rồi ạ.'; // i18n-allow: the FB-824 shape
    expect(actClaimIn(vi)).toBe('đã báo lên luồng'); // i18n-allow: the quoted words
    expect(actClaimIn('I passed it to the team; I will report back.')).toBe(
      'passed it to the team',
    );
    for (const plan of [
      'I will raise it in the technical thread.',
      'It has not been raised in the thread yet.',
      'Em sẽ báo lên luồng kỹ thuật ạ.', // i18n-allow: a plan, no claim
      'ePOD v1.4.2 đã lên production.', // i18n-allow: a release, no act
    ]) {
      expect(actClaimIn(plan), plan).toBeNull();
    }
  });

  it('fails accurate on a raise reported with no act landed behind it, and passes it after one landed', () => {
    const text = "The host step was already raised in AdminHub API's technical thread.";
    const j = judged(text, {});
    expect(j.failed).toEqual(['accurate']);
    expect(j.findings[0]).toMatchObject({ line: 'accurate', by: 'code' });
    expect(j.findings[0]?.why).toContain('no act landed in this turn or earlier in this thread');
    expect(j.findings[0]?.why).toContain('refused or landed and where');
    expect(judged(text, { handedOn: true }).verdict).toBe('pass');
    expect(judgeReply({ ...reply(text), roomKind: 'support' }, []).verdict).toBe('pass');
  });
});

// ISS-1430 (FB-831, L-167): the brief offered "or say it is from an earlier read and when", the audit
// failed every claim with no read of its turn, so a reply that followed its brief failed accurate. One
// rule now: read it again this turn, or say plainly it is not checked now and restate nothing.
describe('a live state is read again this turn, or said not checked now (ISS-1430)', () => {
  const earlier = new Date('2026-11-22T06:51:00Z');
  const judged = (text: string, reads: Partial<TurnReads> = {}) =>
    judgeReply(
      {
        ...reply(text),
        roomKind: 'support',
        reads: { thisTurn: false, earlierAt: earlier, looked: false, handedOn: false, ...reads },
      },
      [],
    );
  // synthetic replies, each the shape of a restated earlier read: dated, past tense, or an "as of"
  const RESTATED: readonly [string, 'vi' | 'en'][] = [
    ['As of 11:02 UTC the worker limit was off.', 'en'],
    ['The nightly sync was disabled when I read it at 06:51.', 'en'],
    ['The export flag is still off.', 'en'],
    ['From my last read, the mail flag was turned off.', 'en'],
    ['Lúc 06:51 cờ gửi mail vẫn tắt ạ.', 'vi'], // i18n-allow: a synthetic reply
    ['Tính đến 11:02, giới hạn worker đang tắt ạ.', 'vi'], // i18n-allow: a synthetic reply
  ];
  // synthetic replies that say plainly the state is not checked now, and restate no value
  const NOT_CHECKED: readonly [string, 'vi' | 'en'][] = [
    [
      'I have not checked whether the nightly sync is enabled now; I will read it and tell you.',
      'en',
    ],
    ["I haven't read it again this turn, so I can't say if the export flag is turned off.", 'en'],
    ['Em chưa kiểm tra lại lúc này nên chưa biết cờ gửi mail đã bật hay chưa ạ.', 'vi'], // i18n-allow: a synthetic reply
    ["I couldn't check now whether ISS-21 is deployed.", 'en'],
  ];

  it('passes a reply that read the state this turn, dated or not', () => {
    for (const [text] of RESTATED) {
      expect(judged(text, { thisTurn: true }).verdict, text).toBe('pass');
    }
  });

  it('fails accurate on a restated earlier-read value, dated or not, naming the read to make', () => {
    for (const [text] of RESTATED) {
      const j = judged(text, {});
      expect(j.failed, text).toEqual(['accurate']);
      const why = j.findings.find((f) => f.line === 'accurate')?.why ?? '';
      expect(why, text).toContain(
        'from a read made in an earlier turn (2026-11-22T06:51:00.000Z), not one made in this turn',
      );
      expect(why, text).toContain('read it again in this turn (support.read)');
      expect(judged(text, { earlierAt: null }).findings[0]?.why, text).toContain(
        'with no read of it made in this turn',
      );
    }
  });

  it('passes a reply that says plainly it has not checked the state now', () => {
    for (const [text] of NOT_CHECKED) {
      expect(judged(text, {}).verdict, text).toBe('pass');
    }
  });

  it('fails a "not checked now" that still restates the earlier value', () => {
    for (const [text] of [
      ['I have not checked it now, but at 06:51 the export flag was off.', 'en'],
      ['The export flag was off at 06:51; I have not checked it again now.', 'en'],
      ['I have not checked it now; as of 06:51 the worker limit was disabled.', 'en'],
      ['Em chưa kiểm tra lại, nhưng lúc 06:51 cờ gửi mail vẫn tắt ạ.', 'vi'], // i18n-allow: a synthetic reply
    ] as const) {
      expect(judged(text, {}).failed, text).toEqual(['accurate']);
    }
  });

  // a master's answer handed in the turn is a fresh check the room agent usually cannot read again (it
  // lives in another project): the case holds it, and the agent says it dated, never whose it was
  it('passes a state the master answered in this turn, said dated with no name; fails it with none', () => {
    const text = 'At 02:05 the export flag was still off.';
    expect(judged(text, { masterAnswered: true }).verdict).toBe('pass');
    expect(judged(text, { masterAnswered: false }).failed).toEqual(['accurate']);
    expect(judged(text).failed).toEqual(['accurate']);
  });

  it('keeps a truthful "I raised it earlier" passing beside it (ISS-1423)', () => {
    const text = 'I raised it earlier in the technical thread; I have not checked the flag now.';
    expect(judged(text, { handedOn: true }).verdict).toBe('pass');
  });
});
