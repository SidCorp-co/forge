import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test' },
}));

const dispatchTick = vi.fn(async (_projectId: string) => {});

vi.mock('../jobs/dispatch-tick.js', () => ({
  dispatchTickForProject: (projectId: string) => dispatchTick(projectId),
}));

const dbExecute = vi.fn(async (..._args: unknown[]) => [] as Array<Record<string, unknown>>);
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

// ISS-280 — reconcileOrphanedJobs routes reaped orphans through the shared
// finalize path. Mock it so the sweeper test doesn't pull in the retry /
// manual-hold / hooks graph; assert the call contract instead.
const finalizeFailedJobMock = vi.fn(async (..._args: unknown[]) => ({ scheduled: false }));
vi.mock('../jobs/finalize-failure.js', () => ({
  finalizeFailedJob: (...args: unknown[]) => finalizeFailedJobMock(...args),
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

const { runPipelineSweep, sweepExpiredHolds, reconcileOrphanedJobs } = await import('./sweeper.js');

/** Flatten a drizzle `sql` template into its raw text for fragment assertions. */
function sqlText(arg: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (typeof n === 'string') {
      out.push(n);
      return;
    }
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (n && typeof n === 'object') {
      const v = (n as { value?: unknown }).value;
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v)) walk(v);
      const c = (n as { queryChunks?: unknown }).queryChunks;
      if (c) walk(c);
    }
  };
  walk(arg);
  return out.join(' ');
}

beforeEach(() => {
  vi.clearAllMocks();
  dispatchTick.mockReset();
  sessionsWhere.mockReset();
  sessionsWhere.mockResolvedValue([]); // no zombies by default
  queuedProjectsRows.length = 0;
  dbExecute.mockResolvedValue([]);
  finalizeFailedJobMock.mockClear();
  finalizeFailedJobMock.mockResolvedValue({ scheduled: false });
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

describe('reconcileOrphanedJobs (ISS-280)', () => {
  it('candidate SELECT covers active jobs + terminal sessions and skips result-event jobs', async () => {
    dbExecute.mockResolvedValueOnce([]); // no candidates → no CAS updates
    const result = await reconcileOrphanedJobs(new Date('2026-05-30T00:00:00Z'));

    expect(result.reconciled).toBe(0);
    const text = sqlText(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/j\.status\s+IN\s*\(\s*'dispatched'\s*,\s*'running'\s*\)/);
    expect(text).toMatch(/s\.status\s+IN\s*\(\s*'failed'\s*,\s*'cancelled_stale'\s*\)/);
    expect(text).toMatch(/NOT\s+EXISTS[\s\S]*job_events[\s\S]*kind\s*=\s*'result'/);
    expect(finalizeFailedJobMock).not.toHaveBeenCalled();
  });

  it('reaps an orphan (session failed, job dispatched, no result) through finalizeFailedJob', async () => {
    // SELECT returns one candidate id.
    dbExecute.mockResolvedValueOnce([{ id: 'orphan-1' }]);
    // CAS UPDATE … RETURNING wins and returns the now-failed row.
    const updatedRow = {
      id: 'orphan-1',
      projectId: 'p1',
      issueId: 'i1',
      status: 'failed',
      failureKind: 'transient',
    };
    sessionsWhere.mockResolvedValueOnce([updatedRow]);

    const result = await reconcileOrphanedJobs(new Date('2026-05-30T00:00:00Z'));

    expect(result.reconciled).toBe(1);
    expect(finalizeFailedJobMock).toHaveBeenCalledTimes(1);
    expect(finalizeFailedJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'orphan-1' }),
      expect.objectContaining({ error: 'session_lost' }),
    );
  });

  it('skips a job that lost the CAS race (a late /complete already finalized it)', async () => {
    dbExecute.mockResolvedValueOnce([{ id: 'orphan-2' }]);
    sessionsWhere.mockResolvedValueOnce([]); // CAS returned no row

    const result = await reconcileOrphanedJobs(new Date('2026-05-30T00:00:00Z'));

    expect(result.reconciled).toBe(0);
    expect(finalizeFailedJobMock).not.toHaveBeenCalled();
  });

  it('does not let one row failure abort the whole pass', async () => {
    dbExecute.mockResolvedValueOnce([{ id: 'orphan-3' }, { id: 'orphan-4' }]);
    sessionsWhere
      .mockResolvedValueOnce([{ id: 'orphan-3', projectId: 'p1', issueId: null }])
      .mockResolvedValueOnce([{ id: 'orphan-4', projectId: 'p1', issueId: null }]);
    finalizeFailedJobMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ scheduled: false });

    const result = await reconcileOrphanedJobs(new Date('2026-05-30T00:00:00Z'));

    // Both rows won their CAS so both counted as reconciled; the first
    // finalize threw but was swallowed so the second still ran.
    expect(result.reconciled).toBe(2);
    expect(finalizeFailedJobMock).toHaveBeenCalledTimes(2);
  });
});
