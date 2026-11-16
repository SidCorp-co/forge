import { REPLY_RUBRIC_LINES, type ReplyRubricLine } from '@forge/contracts/support-reply-audit';
import { describe, expect, it } from 'vitest';
import { mapLine } from '../act-cards.js';
import { AUDIT_TOOL_TEXT } from './index.js';
import { type AuditedReply, judgeReply } from './judge.js';

// @direct-test-of packages/core/src/support/reply-audit/judge.ts
// @direct-test-of packages/core/src/support/reply-audit/teach.ts
// @direct-test-of packages/core/src/support/reply-audit/index.ts
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

const reply = (text: string, language: 'vi' | 'en' = 'vi'): AuditedReply => ({
  text,
  language,
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

  it('fails a reply in another language than the project’s, and passes it in the project’s own', () => {
    const text = 'The release is live on production now, and the import is fixed.';
    expect(judgeReply(reply(text, 'vi'), []).failed).toEqual(['language']);
    expect(judgeReply(reply(text, 'en'), []).verdict).toBe('pass');
  });

  it('tells no API-host link where the web app is served on that host too', () => {
    expect(judgeReply({ ...reply(TURNS['16/11 03:16'] ?? ''), apiHosts: [] }, []).verdict).toBe(
      'pass',
    );
  });

  it('teaches the tool every rubric line from the one rubric, and the brief the step', () => {
    for (const line of REPLY_RUBRIC_LINES) expect(AUDIT_TOOL_TEXT).toContain(`${line} (`);
    // the brief's line is support.audit's card, rendered (ISS-1251)
    expect(mapLine('audit')).toMatch(
      /^- When you posted a reply: audit it at once with support\.audit /,
    );
  });
});
