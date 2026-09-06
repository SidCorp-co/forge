import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));

const dbExecute = vi.fn(async (..._args: unknown[]) => [] as Array<Record<string, unknown>>);
vi.mock('../db/client.js', () => ({ db: { execute: (...a: unknown[]) => dbExecute(...a) } }));

const readThresholdsMock = vi.fn(async () => ({ ghostRunnerOfflineDays: 14 }));
vi.mock('../admin/thresholds.js', () => ({ readThresholds: () => readThresholdsMock() }));

const setRunnerStatusMock = vi.fn(
  async (_input: unknown): Promise<{ found: boolean; changed: boolean; oldStatus: string }> => ({
    found: true,
    changed: true,
    oldStatus: 'offline',
  }),
);
vi.mock('./runner-events.js', () => ({
  setRunnerStatus: (input: unknown) => setRunnerStatusMock(input),
}));

const loggerError = vi.fn();
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: (...a: unknown[]) => loggerError(...a) },
}));

vi.mock('../queue/boss.js', () => ({ boss: {} }));

const { reapGhostRunners } = await import('./ghost-reaper.js');

const ghost = (id: string) => ({ id, project_id: 'proj-1', name: `runner-${id}` });

// cm:edge contract -> packages/core/tests/integration/ghost-runner-reap-e2e.test.ts — this suite proves the per-row behaviour and the error isolation; the WHERE clause that PICKS the rows is SQL and a mocked db.execute is no evidence about it, so that file is where the predicate is judged.
describe('reapGhostRunners (ISS-654)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbExecute.mockResolvedValue([]);
    readThresholdsMock.mockResolvedValue({ ghostRunnerOfflineDays: 14 });
    setRunnerStatusMock.mockResolvedValue({ found: true, changed: true, oldStatus: 'offline' });
  });

  it('disables every candidate row through the audited writer', async () => {
    dbExecute.mockResolvedValue([ghost('r1'), ghost('r2')]);

    const res = await reapGhostRunners();

    expect(res.flagged).toBe(2);
    expect(setRunnerStatusMock).toHaveBeenNthCalledWith(1, {
      runnerId: 'r1',
      newStatus: 'disabled',
      reason: 'ghost',
    });
  });

  // cm:guard count only rows whose status actually MOVED — `setRunnerStatus` is change-gated and writes no audit row for a no-op, so counting the call instead of the change reports flags that left no trace anywhere.
  it('does not count a row whose status did not change', async () => {
    dbExecute.mockResolvedValue([ghost('r1')]);
    setRunnerStatusMock.mockResolvedValue({ found: true, changed: false, oldStatus: 'disabled' });

    expect((await reapGhostRunners()).flagged).toBe(0);
  });

  it('skips a row that throws and keeps flagging the rest', async () => {
    dbExecute.mockResolvedValue([ghost('r1'), ghost('r2')]);
    setRunnerStatusMock.mockRejectedValueOnce(new Error('locked'));

    const res = await reapGhostRunners();

    expect(res.flagged).toBe(1);
    expect(loggerError).toHaveBeenCalledOnce();
  });

  // cm:guard never throws — it runs from a pg-boss worker beside the other runner-axis sweeps, and a rejection there retries the whole tick rather than losing one pass.
  it('returns zero rather than throwing when the query fails', async () => {
    dbExecute.mockRejectedValue(new Error('db down'));

    await expect(reapGhostRunners()).resolves.toEqual({ flagged: 0 });
  });

  it('binds the configured day threshold into the query', async () => {
    readThresholdsMock.mockResolvedValue({ ghostRunnerOfflineDays: 45 });

    await reapGhostRunners();

    const bound = JSON.stringify(dbExecute.mock.calls[0]?.[0]);
    expect(bound).toContain('45');
  });
});
