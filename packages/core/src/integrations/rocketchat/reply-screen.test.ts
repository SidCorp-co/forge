import { describe, expect, it, vi } from 'vitest';

// Parity check for the guard composition extracted from
// `connection-manager.ts`'s old `checkReply`/`verifyReplyClaims` — the ISS-675
// async escalation bridge shares this exact module so neither reply path can
// silently diverge from the other's ISS-672 kernel guards.

const selectWhere = vi.fn();
const selectFrom = vi.fn(() => ({ where: selectWhere }));
vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));
vi.mock('../../ws/server.js', () => ({ roomManager: { publish: vi.fn() } }));
vi.mock('../../pipeline/outbox-session.js', () => ({ withActorContext: vi.fn() }));
vi.mock('../../pipeline/runs.js', () => ({
  closeOpenRunForIssue: vi.fn(),
  setCurrentStepForOpenIssueRun: vi.fn(),
}));

const { screenStakeholderReply } = await import('./reply-screen.js');

const UUID = '87153ba0-1d92-427d-bc28-f508a163f6a4';

describe('screenStakeholderReply', () => {
  it('passes a clean, plain-language reply with no claims to verify', async () => {
    selectWhere.mockResolvedValue([]);
    const verdict = await screenStakeholderReply(
      'proj-1',
      'Đơn hàng của bạn đã được xử lý xong.', // i18n-allow: a plain-language bot reply exercised by the guard
      [],
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.problems).toEqual([]);
  });

  it('rejects a reply citing an ISS id that does not exist in this project', async () => {
    selectWhere.mockResolvedValue([]);
    const verdict = await screenStakeholderReply(
      'proj-1',
      'Xem ISS-42 để biết chi tiết.', // i18n-allow: a bot reply citing an unverified ISS id
      [],
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/ISS-42/);
  });

  it('accepts a verified ISS id (found in the DB) without the product-lint bare-id rejection', async () => {
    selectWhere.mockResolvedValue([{ id: UUID, issSeq: 42 }]);
    const verdict = await screenStakeholderReply(
      'proj-1',
      'Xem ISS-42 để biết chi tiết.', // i18n-allow: a bot reply citing a now-verified ISS id
      [],
    );
    expect(verdict.ok).toBe(true);
  });

  it('rejects a reply containing a code fence — leaked developer detail', async () => {
    selectWhere.mockResolvedValue([]);
    const verdict = await screenStakeholderReply(
      'proj-1',
      'Đây là log:\n```\nerror\n```', // i18n-allow: a bot reply leaking a code fence
      [],
    );
    expect(verdict.ok).toBe(false);
  });

  it('rejects an empty-promise reply with no follow-up turn', async () => {
    selectWhere.mockResolvedValue([]);
    const verdict = await screenStakeholderReply(
      'proj-1',
      'Để mình kiểm tra rồi báo lại nhé.', // i18n-allow: the empty-promise phrasing under test
      [],
    );
    expect(verdict.ok).toBe(false);
  });

  it('fails open (ok=true) and skips the bare-ISS-id rule when the DB query errors', async () => {
    selectWhere.mockRejectedValue(new Error('db down'));
    const verdict = await screenStakeholderReply(
      'proj-1',
      'Xem ISS-999 để biết chi tiết.', // i18n-allow: a bot reply citing an ISS id during a DB outage
      [],
    );
    expect(verdict.ok).toBe(true);
  });

  describe('progress claim (ISS-671)', () => {
    const facts = { done: 54, inFlight: 7, remaining: 3, total: 64 };

    it('ANDs a progress-claim rejection into the composed verdict', async () => {
      selectWhere.mockResolvedValue([]);
      // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
      const verdict = await screenStakeholderReply('proj-1', 'Dự án chưa làm gì cả.', [], facts); // i18n-allow: Vietnamese denial phrasing under test
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join(' ')).toMatch(/54/);
    });

    it('passes a reply whose stated figure matches the given snapshot, with no extra DB query for it', async () => {
      selectWhere.mockResolvedValue([]);
      const verdict = await screenStakeholderReply(
        'proj-1',
        // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
        'Dự án đã hoàn thành 54 việc.', // i18n-allow: Vietnamese progress phrasing under test
        [],
        facts,
      );
      expect(verdict.ok).toBe(true);
    });

    it('omitting the snapshot argument self-computes rather than skipping the check', async () => {
      // cm:why the db mock has no `.groupBy`, so the self-compute fails closed — proving the call happened rather than being skipped
      selectWhere.mockResolvedValue([]);
      // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
      const verdict = await screenStakeholderReply('proj-1', 'Dự án đã hoàn thành 54 việc.', []); // i18n-allow: Vietnamese progress phrasing under test
      expect(verdict.ok).toBe(false);
    });

    it('passing null explicitly fails closed on any stated figure', async () => {
      selectWhere.mockResolvedValue([]);
      const verdict = await screenStakeholderReply(
        'proj-1',
        // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
        'Dự án đã hoàn thành 54 việc.', // i18n-allow: Vietnamese progress phrasing under test
        [],
        null,
      );
      expect(verdict.ok).toBe(false);
    });
  });
});
