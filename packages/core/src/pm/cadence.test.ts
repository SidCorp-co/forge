import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
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
    unschedule: vi.fn(async () => {}),
    offWork: vi.fn(async () => {}),
  },
}));

const { runPmCadenceTickOnce, _resetPmCadenceCacheForTest } = await import('./cadence.js');

function queueConfigs(rows: Array<{ projectId: string; cadenceCron: string }>): void {
  selectMock.mockImplementationOnce(() => ({
    from: () => ({
      where: async () => rows,
    }),
  }));
}

beforeEach(() => {
  selectMock.mockReset();
  spawnMock.mockClear();
  _resetPmCadenceCacheForTest();
});

describe('runPmCadenceTickOnce', () => {
  it('fires for projects whose cron matches the just-elapsed minute window', async () => {
    queueConfigs([
      { projectId: 'p-hourly', cadenceCron: '0 * * * *' },
      { projectId: 'p-five-min', cadenceCron: '*/5 * * * *' },
    ]);
    // 12:00:30 — both top-of-hour and */5 fire at 12:00.
    const fired = await runPmCadenceTickOnce(new Date('2026-05-04T12:00:30Z'));
    expect(fired.sort()).toEqual(['p-five-min', 'p-hourly']);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenCalledWith({ projectId: 'p-hourly', cause: 'tick' });
  });

  it('skips projects whose cron does not fire in the window', async () => {
    queueConfigs([{ projectId: 'p-five-min', cadenceCron: '*/5 * * * *' }]);
    const fired = await runPmCadenceTickOnce(new Date('2026-05-04T12:03:30Z'));
    expect(fired).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('caches configs across calls within 5 minutes', async () => {
    queueConfigs([{ projectId: 'p-1', cadenceCron: '* * * * *' }]);
    await runPmCadenceTickOnce(new Date('2026-05-04T12:00:30Z'));
    // Second call within 5 min: no new select, cache hit. If selectMock is
    // called again it will throw (no impl queued).
    await runPmCadenceTickOnce(new Date('2026-05-04T12:01:30Z'));
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('logs and continues on a bad cron expression', async () => {
    queueConfigs([
      { projectId: 'p-bad', cadenceCron: 'not a cron' },
      { projectId: 'p-good', cadenceCron: '* * * * *' },
    ]);
    const fired = await runPmCadenceTickOnce(new Date('2026-05-04T12:00:30Z'));
    expect(fired).toEqual(['p-good']);
  });

  it('does not include projects where spawn returns ok:false', async () => {
    queueConfigs([{ projectId: 'p-1', cadenceCron: '* * * * *' }]);
    spawnMock.mockResolvedValueOnce({ ok: false, reason: 'already-active' } as never);
    const fired = await runPmCadenceTickOnce(new Date('2026-05-04T12:00:30Z'));
    expect(fired).toEqual([]);
  });
});
