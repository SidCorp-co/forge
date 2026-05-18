import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_PEPPER = 'y'.repeat(32);
vi.mock('../config/env.js', () => ({
  env: { DEVICE_TOKEN_PEPPER: TEST_PEPPER, NODE_ENV: 'test' },
}));

vi.mock('../queue/boss.js', () => ({
  boss: {},
}));

const dbExecute = vi.fn();
vi.mock('../db/client.js', () => ({
  db: { execute: dbExecute },
}));

const setManualHoldBlock = vi.fn(async () => undefined);
vi.mock('../pipeline/manual-hold.js', () => ({
  setManualHoldBlock: (...args: unknown[]) => setManualHoldBlock(...(args as [never])),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { runStuckSweep } = await import('./stuck-watcher.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('jobs/stuck-watcher runStuckSweep', () => {
  it('returns zero counts when no rows match', async () => {
    dbExecute.mockResolvedValueOnce([]);
    const result = await runStuckSweep();
    expect(result.markedFailed).toBe(0);
    expect(result.blocked).toBe(0);
    expect(setManualHoldBlock).not.toHaveBeenCalled();
  });

  it('marks stuck rows failed and blocks each issue via setManualHoldBlock', async () => {
    const stuckRows = [
      { id: 'job-1', issueId: 'i1', type: 'code', attempts: 1, agentSessionId: null },
      { id: 'job-2', issueId: 'i2', type: 'test', attempts: 1, agentSessionId: 's2' },
    ];
    dbExecute.mockResolvedValueOnce(stuckRows);

    const result = await runStuckSweep();
    expect(result.markedFailed).toBe(2);
    expect(result.blocked).toBe(2);
    expect(setManualHoldBlock).toHaveBeenCalledTimes(2);
    const firstCall = setManualHoldBlock.mock.calls[0]?.[0] as {
      issueId: string;
      context: { trigger: string; step: string };
    } | undefined;
    expect(firstCall?.issueId).toBe('i1');
    expect(firstCall?.context.trigger).toBe('session_lost');
  });

  it('skips block when job has no issueId', async () => {
    const stuckRows = [{ id: 'pm-1', issueId: null, type: 'pm', attempts: 1 }];
    dbExecute.mockResolvedValueOnce(stuckRows);
    const result = await runStuckSweep();
    expect(result.markedFailed).toBe(1);
    expect(result.blocked).toBe(0);
    expect(setManualHoldBlock).not.toHaveBeenCalled();
  });

  it('survives setManualHoldBlock throwing — sweep continues for remaining rows', async () => {
    const stuckRows = [
      { id: 'job-1', issueId: 'i1', type: 'code', attempts: 1 },
      { id: 'job-2', issueId: 'i2', type: 'code', attempts: 1 },
    ];
    dbExecute.mockResolvedValueOnce(stuckRows);
    setManualHoldBlock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    const result = await runStuckSweep();
    expect(result.markedFailed).toBe(2);
    expect(result.blocked).toBe(1);
  });
});
