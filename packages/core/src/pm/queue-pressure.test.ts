import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeMock = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    execute: (...args: unknown[]) => executeMock(...args),
  },
}));

const spawnMock = vi.fn(async () => ({ ok: true, jobId: 'pm-1' }) as const);
vi.mock('./spawner.js', () => ({
  spawnPmSession: (...args: unknown[]) => spawnMock(...(args as [unknown])),
}));

vi.mock('../queue/boss.js', () => ({
  boss: {
    createQueue: vi.fn(async () => {}),
    work: vi.fn(async () => 'worker-1'),
    schedule: vi.fn(async () => {}),
  },
}));

const { runPmQueuePressureSweepOnce } = await import('./queue-pressure.js');

beforeEach(() => {
  executeMock.mockReset();
  spawnMock.mockClear();
});

describe('runPmQueuePressureSweepOnce', () => {
  it('spawns a PM session for each project over threshold', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        { project_id: 'p-1', queued: 6 },
        { project_id: 'p-2', queued: 9 },
      ],
    });
    const fired = await runPmQueuePressureSweepOnce();
    expect(fired.sort()).toEqual(['p-1', 'p-2']);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenNthCalledWith(1, {
      projectId: 'p-1',
      cause: 'queue-pressure',
      eventRef: { queued: 6, threshold: 5 },
    });
  });

  it('handles drivers that return rows directly (array result)', async () => {
    executeMock.mockResolvedValueOnce([{ project_id: 'p-1', queued: 6 }]);
    const fired = await runPmQueuePressureSweepOnce();
    expect(fired).toEqual(['p-1']);
  });

  it('does nothing when no project exceeds threshold (empty result)', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    const fired = await runPmQueuePressureSweepOnce();
    expect(fired).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('omits projects whose spawn was deduped or rate-limited', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ project_id: 'p-1', queued: 6 }] });
    spawnMock.mockResolvedValueOnce({ ok: false, reason: 'already-active' } as never);
    const fired = await runPmQueuePressureSweepOnce();
    expect(fired).toEqual([]);
  });
});
