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

const { runDesktopPairingCleanup } = await import('./desktop-pairing-cleanup.js');

beforeEach(() => {
  executeMock.mockReset();
});

describe('jobs/desktop-pairing-cleanup', () => {
  it('returns the deleted count from a single short batch', async () => {
    executeMock.mockResolvedValueOnce({ count: 9 });
    const result = await runDesktopPairingCleanup();
    expect(result.deleted).toBe(9);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('handles rowCount-shaped driver results', async () => {
    executeMock.mockResolvedValueOnce({ rowCount: 4 });
    const result = await runDesktopPairingCleanup();
    expect(result.deleted).toBe(4);
  });

  it('iterates in 10k batches until a short batch signals completion', async () => {
    executeMock.mockResolvedValueOnce({ count: 10_000 });
    executeMock.mockResolvedValueOnce({ count: 250 });
    const result = await runDesktopPairingCleanup();
    expect(result.deleted).toBe(10_250);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it('treats an unknown result shape as 0 and stops', async () => {
    executeMock.mockResolvedValueOnce([]);
    const result = await runDesktopPairingCleanup();
    expect(result.deleted).toBe(0);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});
