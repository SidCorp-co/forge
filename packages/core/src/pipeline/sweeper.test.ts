import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test' },
}));

const dispatchTick = vi.fn(async (_projectId: string) => {});

vi.mock('../jobs/dispatch-tick.js', () => ({
  dispatchTickForProject: (projectId: string) => dispatchTick(projectId),
}));

const dbExecute = vi.fn(async () => [] as Array<Record<string, unknown>>);
const sessionsWhere = vi.fn();
const queuedProjectsRows: Array<{ projectId: string }> = [];

vi.mock('../db/client.js', () => ({
  db: {
    execute: (...args: unknown[]) => dbExecute(...(args as [])),
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

vi.mock('../queue/boss.js', () => ({ boss: {} }));

vi.mock('../jobs/pgboss-health.js', () => ({
  recordPipelineSweeperTick: vi.fn(),
}));

vi.mock('../jobs/agent-session-link.js', () => ({
  broadcastSessionEvent: vi.fn(),
}));

const wsPublish = vi.fn();
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: (...args: unknown[]) => wsPublish(...args) },
}));

const addBreadcrumbMock = vi.fn();
vi.mock('../observability/sentry.js', () => ({
  Sentry: { addBreadcrumb: addBreadcrumbMock },
  isSentryEnabled: () => true,
}));

const recordHoldAutoClearMock = vi.fn();
vi.mock('../observability/hold-metrics.js', () => ({
  recordHoldAutoClear: (...args: unknown[]) => recordHoldAutoClearMock(...args),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { runPipelineSweep, sweepExpiredHolds } = await import('./sweeper.js');

beforeEach(() => {
  vi.clearAllMocks();
  dispatchTick.mockReset();
  sessionsWhere.mockReset();
  sessionsWhere.mockResolvedValue([]); // no zombies by default
  queuedProjectsRows.length = 0;
  dbExecute.mockResolvedValue([]);
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

describe('sweepExpiredHolds', () => {
  it('clears no rows when the UPDATE finds none', async () => {
    dbExecute.mockResolvedValueOnce([]);
    const result = await sweepExpiredHolds(new Date('2026-05-23T00:00:00Z'));
    expect(result.cleared).toBe(0);
    expect(wsPublish).not.toHaveBeenCalled();
    expect(addBreadcrumbMock).not.toHaveBeenCalled();
  });

  it('emits WS + Sentry breadcrumb + counter for each cleared row', async () => {
    dbExecute.mockResolvedValueOnce([
      {
        id: 'i1',
        project_id: 'p1',
        held_at: new Date('2026-05-23T00:00:00Z'),
        failure_kind: 'transient_network',
      },
      {
        id: 'i2',
        project_id: 'p1',
        held_at: new Date('2026-05-23T00:00:00Z'),
        failure_kind: null,
      },
    ]);
    const result = await sweepExpiredHolds(new Date('2026-05-23T00:30:00Z'));

    expect(result.cleared).toBe(2);
    expect(wsPublish).toHaveBeenCalledTimes(2);
    const [room, envelope] = wsPublish.mock.calls[0] as [
      string,
      { event: string; data: Record<string, unknown> },
    ];
    expect(room).toBe('project:p1');
    expect(envelope.event).toBe('issue.holdCleared');
    expect(envelope.data).toMatchObject({ issueId: 'i1', reason: 'auto_clear' });

    expect(addBreadcrumbMock).toHaveBeenCalledTimes(2);
    expect(addBreadcrumbMock.mock.calls[0]?.[0]).toMatchObject({
      category: 'pipeline.reconciler.hold_auto_cleared',
    });

    expect(recordHoldAutoClearMock).toHaveBeenCalledTimes(2);
    expect(recordHoldAutoClearMock).toHaveBeenNthCalledWith(1, { kind: 'transient_network' });
    expect(recordHoldAutoClearMock).toHaveBeenNthCalledWith(2, { kind: 'unknown_no_context' });
  });
});
