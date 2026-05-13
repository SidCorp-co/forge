import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeMock = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    execute: (...args: unknown[]) => executeMock(...args),
  },
}));

const spawnMock = vi.fn(async (_args: unknown) => ({ ok: true, jobId: 'pm-1' }) as const);
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
  // Default: spawnPmSession resolves ok so tests focused on the queue path
  // don't need to re-stub it.
  spawnMock.mockResolvedValue({ ok: true, jobId: 'pm-1' });
});

describe('runPmQueuePressureSweepOnce', () => {
  it('spawns a PM session for each project over threshold (no pipeline_runs data)', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        { project_id: 'p-1', queued: 6 },
        { project_id: 'p-2', queued: 9 },
      ],
    });
    executeMock.mockResolvedValueOnce({ rows: [] });
    const fired = await runPmQueuePressureSweepOnce();
    expect(fired.sort()).toEqual(['p-1', 'p-2']);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenNthCalledWith(1, {
      projectId: 'p-1',
      cause: 'queue-pressure',
      eventRef: {
        queued: 6,
        threshold: 5,
        inFlightRuns: 0,
        oldestRunAgeSeconds: 0,
      },
    });
  });

  it('handles drivers that return rows directly (array result)', async () => {
    executeMock.mockResolvedValueOnce([{ project_id: 'p-1', queued: 6 }]);
    executeMock.mockResolvedValueOnce([]);
    const fired = await runPmQueuePressureSweepOnce();
    expect(fired).toEqual(['p-1']);
  });

  it('does nothing when no project exceeds threshold (empty result)', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [] });
    const fired = await runPmQueuePressureSweepOnce();
    expect(fired).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('omits projects whose spawn was deduped or rate-limited', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ project_id: 'p-1', queued: 6 }] });
    executeMock.mockResolvedValueOnce({ rows: [] });
    spawnMock.mockResolvedValueOnce({ ok: false, reason: 'already-active' } as never);
    const fired = await runPmQueuePressureSweepOnce();
    expect(fired).toEqual([]);
  });

  it('forwards in-flight run pressure to spawnPmSession when pipeline_runs has data', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [{ project_id: 'p-1', queued: 6 }],
    });
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          project_id: 'p-1',
          in_flight_runs: 3,
          oldest_run_age_seconds: 1800,
        },
      ],
    });
    await runPmQueuePressureSweepOnce();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const call = (spawnMock.mock.calls[0] as unknown[])[0] as {
      eventRef: { inFlightRuns: number; oldestRunAgeSeconds: number };
    };
    expect(call.eventRef.inFlightRuns).toBe(3);
    expect(call.eventRef.oldestRunAgeSeconds).toBe(1800);
  });

  it('defaults missing pipeline_runs pressure rows to zero per project', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        { project_id: 'p-1', queued: 6 },
        { project_id: 'p-2', queued: 7 },
      ],
    });
    executeMock.mockResolvedValueOnce({
      rows: [{ project_id: 'p-1', in_flight_runs: 2, oldest_run_age_seconds: 60 }],
    });
    await runPmQueuePressureSweepOnce();
    const second = (spawnMock.mock.calls[1] as unknown[])[0] as {
      eventRef: { inFlightRuns: number; oldestRunAgeSeconds: number };
    };
    expect(second.eventRef.inFlightRuns).toBe(0);
    expect(second.eventRef.oldestRunAgeSeconds).toBe(0);
  });
});
