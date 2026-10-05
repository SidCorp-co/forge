import { describe, expect, it, vi } from 'vitest';

const executed: string[] = [];
const tx = {
  execute: vi.fn(async (query: { queryChunks?: unknown[] }) => {
    const text = JSON.stringify(query.queryChunks ?? query);
    executed.push(text);
    return /SELECT/.test(text) ? [{ id: 'run-1' }] : [];
  }),
};

vi.mock('../db/client.js', () => ({
  db: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) },
}));
vi.mock('../agent-sessions/index.js', () => ({
  insertSessionRow: vi.fn(),
  liveMasterSessionId: vi.fn(),
  settleHandBacks: vi.fn(),
  transitionSessions: vi.fn(),
}));
vi.mock('../issues/index.js', () => ({
  heldIssuePrefixes: vi.fn(),
  refuseHeldTakeForSeqs: vi.fn(),
  releaseIssueLeaseRow: vi.fn(async () => ({ released: true, projectId: 'project-1' })),
  takeIssueLeases: vi.fn(),
}));
const writeRunMetadata = vi.fn(async () => true);
vi.mock('../pipeline/index.js', () => ({
  closeRunIfOneShot: vi.fn(),
  closeRunIfOneShotInTx: vi.fn(),
  insertOneShotRun: vi.fn(),
  lockRunForClose: vi.fn(),
  writeRunMetadata,
}));

describe('releaseIssueLease', () => {
  it('shrinks the run membership through the pipeline run writer, untouched updated_at, in the release transaction', async () => {
    const { releaseIssueLease } = await import('./run-session.js');
    const outcome = await releaseIssueLease({ deviceId: 'device-1', issueKey: 'ISS-7' });

    expect(outcome).toEqual({ released: true, projectId: 'project-1' });
    expect(writeRunMetadata).toHaveBeenCalledTimes(1);
    expect(writeRunMetadata).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ touch: false }),
      tx,
    );
    expect(executed.some((q) => /UPDATE pipeline_runs/.test(q))).toBe(false);
  });
});
