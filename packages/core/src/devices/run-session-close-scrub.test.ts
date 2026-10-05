import { describe, expect, it, vi } from 'vitest';

const PAT = 'forge_pat_dev_0123456789abcdef0123456789abcdef';
const tx = {};
const select = {
  from: () => select,
  where: async () => [{ status: 'running', runId: 'run-1' }],
};

vi.mock('../db/client.js', () => ({
  db: {
    select: () => select,
    transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  },
}));
const transitionSessions = vi.fn(async () => ({ rows: [{ id: 's-1' }], owedHandBacks: [] }));
vi.mock('../agent-sessions/index.js', () => ({
  insertSessionRow: vi.fn(),
  liveMasterSessionId: vi.fn(),
  settleHandBacks: vi.fn(async () => []),
  transitionSessions,
}));
vi.mock('../issues/index.js', () => ({
  heldIssuePrefixes: vi.fn(),
  refuseHeldTakeForSeqs: vi.fn(),
  releaseIssueLeaseRow: vi.fn(),
  takeIssueLeases: vi.fn(),
}));
const closeRunIfOneShotInTx = vi.fn();
vi.mock('../pipeline/index.js', () => ({
  closeRunIfOneShot: vi.fn(),
  closeRunIfOneShotInTx,
  insertOneShotRun: vi.fn(),
  lockRunForClose: vi.fn(),
  writeRunMetadata: vi.fn(),
}));

describe('closeRunSession', () => {
  it("stores a box's close detail through the secret scrubber, on the session and the run's cause", async () => {
    const { closeRunSession } = await import('./run-session.js');
    await closeRunSession({
      deviceId: 'device-1',
      sessionId: 's-1',
      outcome: 'died',
      detail: `git push failed: https://x-access-token:${PAT}@github.com/o/r`,
    });
    const calls = transitionSessions.mock.calls as unknown as [unknown, { set: unknown }][];
    const causes = closeRunIfOneShotInTx.mock.calls.map((c) => (c as unknown[])[3]);
    const stored = JSON.stringify([calls.map((c) => c[1].set), causes]);
    expect(transitionSessions).toHaveBeenCalledTimes(1);
    expect(stored).toContain('git push failed');
    expect(stored).not.toContain(PAT);
  });
});
