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

  it('fails behaviour and a count stated from a release read alone', () => {
    const j = judged(BEHAVES, { thisTurn: true, servedRead: true, behaviourRead: false });
    expect(j.failed).toEqual(['accurate']);
    expect(j.findings[0]?.why).toContain('support.look, support.read or a run');
  });

  it('still passes each one that read the thing in its turn, was handed the check in it, or said it is not confirmed', () => {
    expect(judged(SERVED, { thisTurn: true, servedRead: true }).verdict).toBe('pass');
    expect(judged(DEPLOY, { thisTurn: true, servedRead: true }).verdict).toBe('pass');
    expect(judged(BEHAVES, { thisTurn: true, behaviourRead: true }).verdict).toBe('pass');
    expect(
      judged('Lúc 02:05 Force Update hoạt động tốt ạ.', { masterAnswered: true }).verdict, // i18n-allow: a check handed in the turn, said with when and no name
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
  const DATED = 'Lúc 02:05 Force Update hoạt động tốt ạ.'; // i18n-allow: a check handed in the turn, said with when and no name
  const NAMED = 'Theo master lúc 02:05, Force Update hoạt động tốt ạ.'; // i18n-allow: the same check, naming the master
  const OWN_VOICE = 'Dạ Force Update hoạt động tốt ạ.'; // i18n-allow: the same claim with no read behind it

  it('keeps the master’s answer beside the read, so the check handed in the turn passes a behaviour claim whether or not the reply names who made it', () => {
    expect(reads(true).masterAnswered).toBe(true);
    expect(judged(DATED, true).verdict).toBe('pass');
    expect(judged(OWN_VOICE, true).verdict).toBe('pass');
  });

  it('still fails a behaviour claim with no read of it and no check handed in the turn, named or not', () => {
    expect(judged(DATED, false).failed).toEqual(['accurate']);
    expect(judged(NAMED, false).failed).toEqual(['accurate']);
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
