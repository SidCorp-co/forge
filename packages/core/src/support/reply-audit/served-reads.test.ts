// @direct-test-of packages/core/src/support/reply-audit/judge.ts
// @direct-test-of packages/core/src/support/reply-audit/audit.ts
import { describe, expect, it } from 'vitest';
import { turnReadsOf } from './audit.js';
import { type AuditedReply, judgeReply, type TurnReads } from './judge.js';

const reply = (text: string): AuditedReply => ({
  text,
  roomKind: 'operations',
  apiHosts: [],
});

// ISS-1440 (FB-837, L-185): three replies of 2026-11-23, replayed in synthetic words. Each stated a
// thing no read of its turn reached: which version sites serve, a deploy, and a product's behaviour.
describe('a served version, a deploy and a product’s behaviour are held to a read of that thing (ISS-1440)', () => {
  const judged = (text: string, reads: Partial<TurnReads> = {}) =>
    judgeReply(
      {
        ...reply(text),
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

// ISS-1440 r2 c2: readsAround kept a master's answer only for a turn that made no other read, so a turn
// that read the release and then got the master's answer failed on `accurate` for a reply saying it as his.
describe('a read and a master’s answer in one turn (ISS-1440)', () => {
  const releaseRead = [{ kind: 'read', tool: 'releases' }];
  const reads = (masterAnswered: boolean) =>
    turnReadsOf({
      reads: releaseRead,
      acted: false,
      servedRead: true,
      masterAnswered,
      earlierAt: null,
    });
  const judged = (text: string, masterAnswered: boolean) =>
    judgeReply({ ...reply(text), roomKind: 'agent', reads: reads(masterAnswered) }, []);
  const AS_HIS = 'Theo master lúc 02:05, Force Update hoạt động tốt ạ.'; // i18n-allow: his check said as his
  const OWN_VOICE = 'Dạ Force Update hoạt động tốt ạ.'; // i18n-allow: the same claim in the reply's own voice

  it('keeps the master’s answer beside the read, so his check passes a behaviour claim said as his', () => {
    expect(reads(true).masterAnswered).toBe(true);
    expect(judged(AS_HIS, true).verdict).toBe('pass');
  });

  it('still fails a behaviour claim with no read of it and no master’s check, or one in the reply’s own voice', () => {
    expect(judged(AS_HIS, false).failed).toEqual(['accurate']);
    expect(judged(OWN_VOICE, true).failed).toEqual(['accurate']);
    const none = turnReadsOf({
      reads: [],
      acted: false,
      servedRead: false,
      masterAnswered: false,
      earlierAt: null,
    });
    expect(judgeReply({ ...reply(OWN_VOICE), roomKind: 'agent', reads: none }, []).failed).toEqual([
      'accurate',
    ]);
  });
});
