import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeMock = vi.fn();
vi.mock('../db/client.js', () => ({
  db: { execute: executeMock },
}));

vi.mock('../queue/boss.js', () => ({
  boss: { schedule: vi.fn(async () => {}), work: vi.fn(async () => {}) },
}));

const { runRetentionSweep } = await import('./retention-sweeper.js');

beforeEach(() => {
  executeMock.mockReset();
});

describe('jobs/retention-sweeper', () => {
  it('returns the deleted row count from the delete result', async () => {
    executeMock.mockResolvedValueOnce({ count: 42 });
    const result = await runRetentionSweep();
    expect(result.deleted).toBe(42);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns 0 when the delete affects no rows', async () => {
    executeMock.mockResolvedValueOnce({ count: 0 });
    const result = await runRetentionSweep();
    expect(result.deleted).toBe(0);
  });

  it('falls back through alternate result shapes (rowCount)', async () => {
    executeMock.mockResolvedValueOnce({ rowCount: 7 });
    const result = await runRetentionSweep();
    expect(result.deleted).toBe(7);
  });

  it('treats array-shaped results as zero-delete (fallback)', async () => {
    executeMock.mockResolvedValueOnce([]);
    const result = await runRetentionSweep();
    expect(result.deleted).toBe(0);
  });
});
