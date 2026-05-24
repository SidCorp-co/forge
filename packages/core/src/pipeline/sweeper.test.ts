import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchTick = vi.fn(async (_projectId: string) => {});

vi.mock('../jobs/dispatch-tick.js', () => ({
  dispatchTickForProject: (projectId: string) => dispatchTick(projectId),
}));

const sessionsWhere = vi.fn();
const queuedProjectsRows: Array<{ projectId: string }> = [];

vi.mock('../db/client.js', () => ({
  db: {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => sessionsWhere(),
        }),
      }),
    }),
    selectDistinct: () => ({
      from: () => ({
        where: () => queuedProjectsRows,
      }),
    }),
  },
}));

vi.mock('../jobs/agent-session-link.js', () => ({
  broadcastSessionEvent: vi.fn(),
}));

vi.mock('../jobs/pgboss-health.js', () => ({
  recordPipelineSweeperTick: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../queue/boss.js', () => ({
  boss: {},
}));

const { runPipelineSweep } = await import('./sweeper.js');

beforeEach(() => {
  dispatchTick.mockReset();
  sessionsWhere.mockReset();
  sessionsWhere.mockResolvedValue([]); // no zombies by default
  queuedProjectsRows.length = 0;
});

describe('runPipelineSweep — dispatcher backstop', () => {
  it('fires dispatchTickForProject for every project with queued jobs', async () => {
    queuedProjectsRows.push({ projectId: 'p1' }, { projectId: 'p2' });

    const result = await runPipelineSweep();

    expect(result.backstopProjects).toBe(2);
    expect(dispatchTick).toHaveBeenCalledTimes(2);
    expect(dispatchTick).toHaveBeenCalledWith('p1');
    expect(dispatchTick).toHaveBeenCalledWith('p2');
  });

  it('is a no-op when no projects have queued jobs', async () => {
    const result = await runPipelineSweep();

    expect(result.backstopProjects).toBe(0);
    expect(dispatchTick).not.toHaveBeenCalled();
  });

  it('propagates backstop errors so pgboss-health sees the missed tick', async () => {
    queuedProjectsRows.push({ projectId: 'p1' });
    const { db } = await import('../db/client.js');
    const original = db.selectDistinct;
    (db as unknown as { selectDistinct: () => unknown }).selectDistinct = () => {
      throw new Error('boom');
    };

    try {
      await expect(runPipelineSweep()).rejects.toThrow('boom');
      expect(dispatchTick).not.toHaveBeenCalled();
    } finally {
      (db as unknown as { selectDistinct: typeof original }).selectDistinct = original;
    }
  });
});
