import { describe, expect, it, vi } from 'vitest';

// cm:ignore CM013 — every frozen comment in this file is an `i18n-allow` pragma naming what its Vietnamese fixture exercises. The fixtures have to be Vietnamese, because the rules under test match Vietnamese phrasing, and deleting a pragma to pay the drain reds the language gate instead.

// cm:why every case here reaches the cell through a DOOR rather than through an audience and an intent, because that is the only way a caller can name one after ISS-1002: the pair comes off the door's row, so a door screened against the wrong cell is what these fixtures would catch.

const selectWhere = vi.fn();
const selectFrom = vi.fn(() => ({ where: selectWhere }));
vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));
vi.mock('../issues/issue-prefix-read.js', () => ({
  activeIssuePrefix: async () => null,
  heldIssuePrefixes: async () => [],
}));
vi.mock('../ws/server.js', () => ({ roomManager: { publish: vi.fn() } }));
vi.mock('../pipeline/outbox-session.js', () => ({ withActorContext: vi.fn() }));
vi.mock('../pipeline/runs.js', () => ({
  closeOpenRunForIssue: vi.fn(),
  setCurrentStepForOpenIssueRun: vi.fn(),
}));

const { screenReplyAtDoor } = await import('./reply-screen.js');
const { problemsOf } = await import('./contract.js');

type Progress = Parameters<typeof screenReplyAtDoor>[1]['progress'];

const screenStakeholderReply = async (
  projectId: string,
  reply: string,
  toolCalls: { name: string; arguments: string }[],
  progress: Progress,
): Promise<{ ok: boolean; problems: string[] }> => {
  const verdict = await screenReplyAtDoor('chat-sync', {
    projectId,
    segments: [reply],
    toolCalls,
    progress,
  });
  return { ok: verdict.ok, problems: problemsOf(verdict) };
};

const UUID = '87153ba0-1d92-427d-bc28-f508a163f6a4';

describe("screenReplyAtDoor, over the chat-sync door's public:report cell", () => {
  it('passes a clean, plain-language reply with no claims to verify', async () => {
    selectWhere.mockResolvedValue([]);
    const verdict = await screenStakeholderReply(
      'proj-1',
      // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
      'Đơn hàng của bạn đã được xử lý xong.', // i18n-allow: a plain-language bot reply exercised by the guard
      [],
      null,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.problems).toEqual([]);
  });

  it('rejects a reply citing an ISS id that does not exist in this project', async () => {
    selectWhere.mockResolvedValue([]);
    const verdict = await screenStakeholderReply(
      'proj-1',
      // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
      'Xem ISS-42 để biết chi tiết.', // i18n-allow: a bot reply citing an unverified ISS id
      [],
      null,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/ISS-42/);
  });

  it('accepts a verified ISS id (found in the DB) without the product-lint bare-id rejection', async () => {
    selectWhere.mockResolvedValue([{ id: UUID, issSeq: 42 }]);
    const verdict = await screenStakeholderReply(
      'proj-1',
      // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
      'Xem ISS-42 để biết chi tiết.', // i18n-allow: a bot reply citing a now-verified ISS id
      [],
      null,
    );
    expect(verdict.ok).toBe(true);
  });

  it('rejects a reply containing a code fence — leaked developer detail', async () => {
    selectWhere.mockResolvedValue([]);
    const verdict = await screenStakeholderReply(
      'proj-1',
      // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
      'Đây là log:\n```\nerror\n```', // i18n-allow: a bot reply leaking a code fence
      [],
      null,
    );
    expect(verdict.ok).toBe(false);
  });

  it('rejects an empty-promise reply with no follow-up turn', async () => {
    selectWhere.mockResolvedValue([]);
    const verdict = await screenStakeholderReply(
      'proj-1',
      // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
      'Để mình kiểm tra rồi báo lại nhé.', // i18n-allow: the empty-promise phrasing under test
      [],
      null,
    );
    expect(verdict.ok).toBe(false);
  });

  it('fails open (ok=true) and skips the bare-ISS-id rule when the DB query errors', async () => {
    selectWhere.mockRejectedValue(new Error('db down'));
    const verdict = await screenStakeholderReply(
      'proj-1',
      // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
      'Xem ISS-999 để biết chi tiết.', // i18n-allow: a bot reply citing an ISS id during a DB outage
      [],
      null,
    );
    expect(verdict.ok).toBe(true);
  });

  describe('progress claim (ISS-671)', () => {
    const facts = { shipped: 54, closedUnshipped: 10, inFlight: 7, remaining: 3, total: 74 };

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

    it("the 'legacy-session' sentinel self-computes rather than skipping the check", async () => {
      // cm:why the db mock has no `.groupBy`, so the self-compute fails closed — proving the call happened rather than being skipped
      selectWhere.mockResolvedValue([]);
      const verdict = await screenStakeholderReply(
        'proj-1',
        // cm:ignore CM001 — i18n-allow directive required by scripts/check-source-language.mjs
        'Dự án đã hoàn thành 54 việc.', // i18n-allow: Vietnamese progress phrasing under test
        [],
        'legacy-session',
      );
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
