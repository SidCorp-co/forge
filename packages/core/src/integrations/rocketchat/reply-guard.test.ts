import { describe, expect, it } from 'vitest';
import {
  checkProgressClaims,
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

describe('checkProgressClaims', () => {
  const facts = { shipped: 54, closedUnshipped: 10, inFlight: 7, remaining: 3, total: 74 };

  it('rejects Vietnamese "nothing done" phrasing when done > 0', () => {
    // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
    const verdict = checkProgressClaims('Dự án chưa làm gì cả, đang bắt đầu triển khai.', facts); // i18n-allow: Vietnamese denial phrasing under test
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/54/);
  });

  it('rejects English "nothing done" phrasing when done > 0', () => {
    const verdict = checkProgressClaims('Nothing has been done on this project yet.', facts);
    expect(verdict.ok).toBe(false);
  });

  it('does not flag the denial phrasing when nothing has shipped AND nothing is in flight', () => {
    const zero = { shipped: 0, closedUnshipped: 0, inFlight: 0, remaining: 3, total: 3 };
    // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
    const verdict = checkProgressClaims('Chưa có gì được làm cả.', zero); // i18n-allow: Vietnamese denial phrasing under test
    expect(verdict.ok).toBe(true);
  });

  it('rejects the denial phrasing when shipped is 0 but work is in flight (review minor)', () => {
    const inFlightOnly = { shipped: 0, closedUnshipped: 0, inFlight: 2, remaining: 1, total: 3 };
    // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
    const verdict = checkProgressClaims('Chưa có gì được làm cả.', inFlightOnly); // i18n-allow: Vietnamese denial phrasing under test
    expect(verdict.ok).toBe(false);
  });

  it('rejects an off-by-N count near a progress keyword', () => {
    // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
    const verdict = checkProgressClaims('Đã hoàn thành 40 việc trong dự án.', facts); // i18n-allow: Vietnamese progress phrasing under test
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/40/);
    expect(verdict.problems.join(' ')).toMatch(/54/);
  });

  it('accepts a count near a progress keyword that matches the authoritative figure', () => {
    // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
    const verdict = checkProgressClaims('Đã hoàn thành 54 việc, còn lại 3 việc.', facts); // i18n-allow: Vietnamese progress phrasing under test
    expect(verdict.ok).toBe(true);
  });

  it('does not flag an ordinary number several words away from a progress keyword (AC#6)', () => {
    // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
    const verdict = checkProgressClaims('Trong 3 tuần đã hoàn thành 54 việc.', facts); // i18n-allow: Vietnamese progress phrasing under test — "3" (weeks) must not be read as a claimed count
    expect(verdict.ok).toBe(true);
  });

  it('rejects a percentage that does not match the authoritative figures', () => {
    // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
    const verdict = checkProgressClaims('Dự án đã hoàn thành 40%.', facts); // i18n-allow: Vietnamese progress phrasing under test
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/40%/);
  });

  it('accepts a percentage that matches the authoritative figures', () => {
    const pct = Math.round((facts.shipped / facts.total) * 100);
    // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
    const verdict = checkProgressClaims(`Dự án đã hoàn thành ${pct}%.`, facts); // i18n-allow: Vietnamese progress phrasing under test
    expect(verdict.ok).toBe(true);
  });

  it('accepts 0% when total is 0 (nothing to divide, so 0% is the only legal share)', () => {
    const empty = { shipped: 0, closedUnshipped: 0, inFlight: 0, remaining: 0, total: 0 };
    // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
    const verdict = checkProgressClaims('Dự án đã hoàn thành 0%.', empty); // i18n-allow: Vietnamese progress phrasing under test
    expect(verdict.ok).toBe(true);
  });

  it('rejects a non-zero percentage when total is 0', () => {
    const empty = { shipped: 0, closedUnshipped: 0, inFlight: 0, remaining: 0, total: 0 };
    // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
    const verdict = checkProgressClaims('Dự án đã hoàn thành 40%.', empty); // i18n-allow: Vietnamese progress phrasing under test
    expect(verdict.ok).toBe(false);
  });

  it('accepts a legitimate percentage claim about a bucket other than shipped/total (AC#6/B1)', () => {
    // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
    const verdict = checkProgressClaims('10% đang làm.', facts); // i18n-allow: inFlight=7/total=74 rounds to 9%, within the +/-1 tolerance of the stated 10%
    expect(verdict.ok).toBe(true);
  });

  it('accepts multiple legal percentages in the same reply (B1)', () => {
    const pctShipped = Math.round((facts.shipped / facts.total) * 100);
    const verdict = checkProgressClaims(
      // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
      `Đã hoàn thành ${pctShipped}%, còn lại 4% chưa xong.`, // i18n-allow: Vietnamese progress phrasing under test
      facts,
    );
    expect(verdict.ok).toBe(true);
  });

  it('does not flag an unrelated percentage nowhere near a progress keyword (B1)', () => {
    const verdict = checkProgressClaims(
      // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
      'Tuần này build nhanh hơn 20%, và đã hoàn thành 54 việc.', // i18n-allow: Vietnamese progress phrasing under test — "20%" is not a progress claim
      facts,
    );
    expect(verdict.ok).toBe(true);
  });

  it('never reads an ISS-<n> id or an ISO date as a figure', () => {
    const verdict = checkProgressClaims(
      // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
      'Xem ISS-2026 (cập nhật 2026-08-11), hoàn thành 54 việc.', // i18n-allow: Vietnamese progress phrasing under test
      facts,
    );
    expect(verdict.ok).toBe(true);
  });

  it('fails CLOSED and rejects any progress figure when the snapshot is null', () => {
    // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
    const verdict = checkProgressClaims('Đã hoàn thành 54 việc.', null); // i18n-allow: Vietnamese progress phrasing under test
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/could not be computed/);
  });

  it('fails CLOSED and rejects a bare percentage when the snapshot is null', () => {
    // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
    const verdict = checkProgressClaims('Dự án đã hoàn thành 54%.', null); // i18n-allow: Vietnamese progress phrasing under test
    expect(verdict.ok).toBe(false);
  });

  it('passes an unrelated percentage nowhere near a progress keyword when the snapshot is null (B1)', () => {
    // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
    const verdict = checkProgressClaims('Discount hôm nay là 20% cho khách mới.', null); // i18n-allow: representative unrelated-percentage sentence under test
    expect(verdict.ok).toBe(true);
  });

  it('passes a reply with no progress figures even when the snapshot is null', () => {
    // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
    const verdict = checkProgressClaims('Chào bạn, mình có thể giúp gì cho bạn?', null); // i18n-allow: Vietnamese greeting under test
    expect(verdict.ok).toBe(true);
  });

  it('accepts a reply with no figures at all', () => {
    // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
    const verdict = checkProgressClaims('Dự án đang tiến triển tốt.', facts); // i18n-allow: Vietnamese progress phrasing under test
    expect(verdict.ok).toBe(true);
  });
});
