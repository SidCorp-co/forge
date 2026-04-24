import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeMock = vi.fn();
vi.mock('../db/client.js', () => ({
  db: { execute: executeMock },
}));

vi.mock('../queue/boss.js', () => ({
  boss: {
    createQueue: vi.fn(async () => {}),
    schedule: vi.fn(async () => {}),
    work: vi.fn(async () => {}),
  },
}));

const { runRetentionSweep } = await import('./retention-sweeper.js');

beforeEach(() => {
  executeMock.mockReset();
});

describe('jobs/retention-sweeper', () => {
  it('returns the deleted row count from a single short batch', async () => {
    executeMock.mockResolvedValueOnce({ count: 42 });
    const result = await runRetentionSweep();
    expect(result.deleted).toBe(42);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns 0 when the delete affects no rows', async () => {
    executeMock.mockResolvedValueOnce({ count: 0 });
    const result = await runRetentionSweep();
    expect(result.deleted).toBe(0);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('falls back through alternate result shapes (rowCount)', async () => {
    executeMock.mockResolvedValueOnce({ rowCount: 7 });
    const result = await runRetentionSweep();
    expect(result.deleted).toBe(7);
  });

  it('iterates in batches until a short batch signals completion', async () => {
    executeMock.mockResolvedValueOnce({ count: 10_000 });
    executeMock.mockResolvedValueOnce({ count: 10_000 });
    executeMock.mockResolvedValueOnce({ count: 3 });
    const result = await runRetentionSweep();
    expect(result.deleted).toBe(20_003);
    expect(executeMock).toHaveBeenCalledTimes(3);
  });

  it('treats unknown result shapes as zero and stops iterating', async () => {
    executeMock.mockResolvedValueOnce([]);
    const result = await runRetentionSweep();
    expect(result.deleted).toBe(0);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});
