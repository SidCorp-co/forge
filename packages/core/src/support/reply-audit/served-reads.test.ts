// @direct-test-of packages/core/src/support/reply-audit/judge.ts
import { describe, expect, it } from 'vitest';
import { type AuditedReply, judgeReply, type TurnReads } from './judge.js';

const reply = (text: string, language: 'vi' | 'en' = 'vi'): AuditedReply => ({
  text,
  language: { language, from: 'asker' },
  roomKind: 'operations',
  apiHosts: [],
});

// ISS-1440 (FB-837, L-185): three replies of 2026-11-23, replayed in synthetic words. Each stated a
// thing no read of its turn reached: which version sites serve, a deploy, and a product's behaviour.
describe('a served version, a deploy and a product’s behaviour are held to a read of that thing (ISS-1440)', () => {
  const judged = (text: string, reads: Partial<TurnReads> = {}) =>
    judgeReply(
      {
        ...reply(text, 'vi'),
        roomKind: 'agent',
        reads: { thisTurn: false, earlierAt: null, looked: false, handedOn: false, ...reads },
      },
      [],
    );
  const SERVED = 'Dạ chưa site nào chạy bản này ạ.'; // i18n-allow: a synthetic reply of the first shape
  const DEPLOY = 'Dạ bản này đang deploy ạ.'; // i18n-allow: a synthetic reply of the second shape
  const BEHAVES = 'Dạ Force Update hoạt động tốt, đã dọn 12 bản ghi ạ.'; // i18n-allow: a synthetic reply of the third shape
  // a turn that read only an issue and a release's shipped state: reads of something else
  const issueOnly = { thisTurn: true, servedRead: false, behaviourRead: false };

  it('fails a served version stated with no read of what is served, and names the read', () => {
    for (const reads of [{}, issueOnly]) {
      const j = judged(SERVED, reads);
      expect(j.failed).toEqual(['accurate']);
      expect(j.findings[0]?.why).toContain('support.releases or support.deployment');
    }
  });

  it('fails a deploy said off an unrelated read of the turn, though the turn read something', () => {
    const j = judged(DEPLOY, issueOnly);
    expect(j.failed).toEqual(['accurate']);
    expect(j.findings[0]?.why).toContain('support.releases or support.deployment');
  });

  it('fails behaviour and a count stated from a release read or a master’s answer in the reply’s own voice', () => {
    for (const reads of [
      { thisTurn: true, servedRead: true, behaviourRead: false },
      { masterAnswered: true },
    ]) {
      const j = judged(BEHAVES, reads);
      expect(j.failed).toEqual(['accurate']);
      expect(j.findings[0]?.why).toContain('support.look, support.read or a run');
    }
  });

  it('still passes each one that read the thing in its turn, said it as the master’s check, or said it is not confirmed', () => {
    expect(judged(SERVED, { thisTurn: true, servedRead: true }).verdict).toBe('pass');
    expect(judged(DEPLOY, { thisTurn: true, servedRead: true }).verdict).toBe('pass');
    expect(judged(BEHAVES, { thisTurn: true, behaviourRead: true }).verdict).toBe('pass');
    expect(
      judged('Theo master lúc 02:05, Force Update hoạt động tốt ạ.', { masterAnswered: true }) // i18n-allow: his check said as his
        .verdict,
    ).toBe('pass');
    expect(
      judged('Em chưa kiểm tra xem site nào chạy bản này, em chưa xác nhận lúc này ạ.').verdict, // i18n-allow: not confirmed now
    ).toBe('pass');
  });
});
