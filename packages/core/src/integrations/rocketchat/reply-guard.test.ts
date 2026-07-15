import { describe, expect, it } from 'vitest';
import {
  detectEmptyPromise,
  extractIssueClaims,
  judgeIssueClaims,
  lintStakeholderReply,
  turnCreatedIssue,
} from './reply-guard.js';

const UUID = '87153ba0-1d92-427d-bc28-f508a163f6a4';
const noCalls: Array<{ name: string; arguments: string }> = [];
const createCall = [{ name: 'forge_issues', arguments: '{"action":"create","data":{}}' }];

describe('extractIssueClaims', () => {
  it('flags a non-UUID issue link id as malformed (the live 2026-07-07 incident)', () => {
    const c = extractIssueClaims(
      'Xem chi tiết tại https://forge-beta.example.co/projects/dodgeprint-api/issues/6673627998492006400 nhé.', // i18n-allow: reproduces the live hallucinated reply being guarded against
    );
    expect(c.malformedUrlIds).toEqual(['6673627998492006400']);
    expect(c.urlIds).toEqual([]);
  });

  it('collects UUID link ids and ISS refs, deduped', () => {
    const c = extractIssueClaims(
      `Issue ISS-56 (${'https://x.co/projects/p/issues/'}${UUID}) and again ISS-56 / ${UUID}`,
    );
    expect(c.urlIds).toEqual([UUID]);
    expect(c.issSeqs).toEqual([56]);
  });

  it('detects creation claims in Vietnamese and English', () => {
    expect(extractIssueClaims('Mình đã tạo một issue mới trong Forge').claimsCreation).toBe(true); // i18n-allow: the Vietnamese claim phrasing under test
    expect(extractIssueClaims('I created a new issue for this').claimsCreation).toBe(true);
    expect(extractIssueClaims('Here is the current status.').claimsCreation).toBe(false);
  });
});

describe('turnCreatedIssue', () => {
  it('matches only forge_issues create calls', () => {
    expect(turnCreatedIssue(createCall)).toBe(true);
    expect(turnCreatedIssue([{ name: 'forge_issues', arguments: '{"action":"list"}' }])).toBe(
      false,
    );
    expect(turnCreatedIssue(noCalls)).toBe(false);
  });
});

describe('judgeIssueClaims', () => {
  const known = { ids: new Set([UUID]), seqs: new Set([56]) };

  it('rejects malformed and unknown refs', () => {
    const claims = extractIssueClaims(
      'created issue at /projects/p/issues/12345 and ISS-999 for you',
    );
    const verdict = judgeIssueClaims(claims, known, noCalls);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/12345/);
    expect(verdict.problems.join(' ')).toMatch(/ISS-999/);
  });

  it('accepts verified refs', () => {
    const claims = extractIssueClaims(`created issue ISS-56: /projects/p/issues/${UUID}`);
    expect(judgeIssueClaims(claims, known, createCall).ok).toBe(true);
  });

  it('rejects a bare creation claim with no create call and no refs', () => {
    const claims = extractIssueClaims('Mình đã tạo issue để xử lý việc này rồi nhé'); // i18n-allow: the Vietnamese claim phrasing under test
    const verdict = judgeIssueClaims(claims, known, noCalls);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/no forge_issues create/);
  });

  it('lets a creation claim through when the create call actually ran', () => {
    const claims = extractIssueClaims('Mình đã tạo issue để xử lý việc này rồi nhé'); // i18n-allow: the Vietnamese claim phrasing under test
    expect(judgeIssueClaims(claims, known, createCall).ok).toBe(true);
  });

  it('accepts a plain informational reply', () => {
    const claims = extractIssueClaims('Task 12608 đang In Progress, chưa có update mới.'); // i18n-allow: representative Vietnamese status reply
    expect(judgeIssueClaims(claims, known, noCalls).ok).toBe(true);
  });
});

describe('lintStakeholderReply', () => {
  const noSeqs = new Set<number>();

  const codeFenceReply = 'Đây là fix:\n```ts\nconst x = 1;\n```'; // i18n-allow: representative Vietnamese stakeholder-reply prefix under test
  const pathLineReply = 'Bug nằm ở src/foo.ts:12 nhé.'; // i18n-allow: representative Vietnamese stakeholder-reply prefix under test
  const issIdReply = 'Xem ISS-99 để biết chi tiết.'; // i18n-allow: representative Vietnamese stakeholder-reply prefix under test
  const verifiedIssIdReply = 'Xem ISS-56 để biết chi tiết.'; // i18n-allow: representative Vietnamese stakeholder-reply prefix under test

  it('flags a code fence', () => {
    const verdict = lintStakeholderReply(codeFenceReply, { verifiedSeqs: noSeqs });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/code block/);
  });

  it('flags a path:line reference', () => {
    const verdict = lintStakeholderReply(pathLineReply, { verifiedSeqs: noSeqs });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/src\/foo\.ts:12/);
  });

  it('flags a bare pipeline status enum', () => {
    for (const token of ['needs_info', 'in_progress', 'on_hold']) {
      const reply = `Issue đang ở trạng thái ${token}.`; // i18n-allow: representative Vietnamese stakeholder-reply prefix under test
      const verdict = lintStakeholderReply(reply, { verifiedSeqs: noSeqs });
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join(' ')).toMatch(new RegExp(token));
    }
  });

  it('flags a bare unverified ISS-id', () => {
    const verdict = lintStakeholderReply(issIdReply, { verifiedSeqs: noSeqs });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/ISS-99/);
  });

  it('does not flag an ISS-id already verified this turn (carve-out)', () => {
    const verdict = lintStakeholderReply(verifiedIssIdReply, { verifiedSeqs: new Set([56]) });
    expect(verdict.ok).toBe(true);
  });

  it('skips the ISS-id rule entirely when the DB lookup failed (fail-open)', () => {
    const verdict = lintStakeholderReply(issIdReply, {
      verifiedSeqs: noSeqs,
      skipIssueIdRule: true,
    });
    expect(verdict.ok).toBe(true);
  });

  it('does not false-positive on a clean Vietnamese status sentence', () => {
    const verdict = lintStakeholderReply(
      'Đội ngũ đang xử lý yêu cầu của bạn, dự kiến hoàn thành trong tuần này.', // i18n-allow: representative clean stakeholder-facing sentence
      { verifiedSeqs: noSeqs },
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.problems).toEqual([]);
  });
});

describe('detectEmptyPromise', () => {
  it('flags a Vietnamese future-promise-with-no-result reply', () => {
    const verdict = detectEmptyPromise('Để mình kiểm tra rồi báo lại nhé.'); // i18n-allow: representative empty-promise phrasing under test
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/follow-up turn/);
  });

  it('flags an English future-promise-with-no-result reply', () => {
    const verdict = detectEmptyPromise("I'll check and get back to you.");
    expect(verdict.ok).toBe(false);
  });

  it('accepts a reply that states a concrete result', () => {
    const verdict = detectEmptyPromise('Task hiện có 3 issue đang mở, không có issue nào quá hạn.'); // i18n-allow: representative concrete-result reply
    expect(verdict.ok).toBe(true);
  });
});
