import { describe, expect, it, vi } from 'vitest';

const PAT = 'forge_pat_dev_0123456789abcdef0123456789abcdef';
const TOKEN_URL = `https://x-access-token:ghs_${'a'.repeat(36)}@github.com/a/b.git`;

const transition = vi.fn(async () => []);
const setDetail = vi.fn(async () => [{ id: 'r-1', projectId: 'p-1' }]);
const emit = vi.fn(async () => undefined);

vi.mock('../db/client.js', () => ({
  db: { transaction: async (cb: (tx: unknown) => unknown) => cb({}) },
}));
vi.mock('../lifecycle/index.js', () => ({ transition }));
vi.mock('../outbox/index.js', () => ({ emitEvent: emit }));
vi.mock('../runners/index.js', () => ({
  deleteDeviceRunners: vi.fn(),
  insertRunnerEvent: vi.fn(),
  mirrorHeartbeatToRunners: vi.fn(),
  setRunnerProvisionDetail: setDetail,
}));

const { reportProvisionStatus } = await import('./service.js');
const evidence = await import('./run-evidence.js');

function clean(text: string): void {
  expect(text).not.toContain(PAT);
  expect(text).not.toContain('ghs_');
}

describe('what a box reports is stored scrubbed', () => {
  it('scrubs a provision-status detail on the transition, the row and the event', async () => {
    await reportProvisionStatus({
      deviceId: 'd-1',
      runnerId: 'r-1',
      status: 'failed' as never,
      detail: `clone failed: ${TOKEN_URL} (token ${PAT})`,
    });
    const reason = (
      transition.mock.calls[0] as unknown as [unknown, unknown, { reason: string }]
    )[2].reason;
    const row = (setDetail.mock.calls[0] as unknown as [unknown, unknown, string])[2];
    const event = (emit.mock.calls[0] as unknown as [unknown, unknown, { detail: string }])[2]
      .detail;
    for (const t of [reason, row, event]) {
      clean(t);
      expect(t).toContain('clone failed');
    }
  });

  it("scrubs a held worktree's reason, a resume choice's why and a checkpoint's reasons", () => {
    const held = evidence.buildHeldWorktreeBody({
      sessionId: 's-1',
      box: 'box',
      held: {
        worktree: '/w',
        branch: 'iss-1',
        head: 'a'.repeat(40),
        commitsUnpushed: 1,
        kept: true,
        reason: `push refused with Authorization: Bearer ${PAT}`,
      } as never,
    });
    const why = evidence.buildResumeChoiceBody({
      choice: { runId: 'run-1', choice: 'continue', why: `the token ${PAT} still works` } as never,
    });
    const run = evidence.buildRunEvidenceBody({
      sessionId: 's-1',
      next: null,
      checkpoint: {
        source: 'box',
        endedReason: `died: ${TOKEN_URL}`,
        unread: [`password=hunter22 in ${PAT}`],
      } as never,
    });
    for (const body of [held, why, run]) clean(body);
    expect(held).toContain('a'.repeat(40));
    expect(run).not.toContain('hunter22');
  });
});
