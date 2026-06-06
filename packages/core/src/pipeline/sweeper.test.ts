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
// Captures the WHERE expression of each agent_sessions UPDATE so a test can
// assert the metadata-type guard that keeps interactive chat off the sweeper.
const sweepWhereArgs: unknown[] = [];
const queuedProjectsRows: Array<{ projectId: string }> = [];

vi.mock('../db/client.js', () => ({
  db: {
    execute: (...args: unknown[]) => dbExecute(...(args as [])),
    update: () => ({
      set: () => ({
        where: (arg: unknown) => {
          sweepWhereArgs.push(arg);
          return { returning: () => sessionsWhere() };
        },
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

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  runPipelineSweep,
  reconcileOrphanedJobs,
  reconcileNeverClaimedDispatches,
  sweepZombieSessions,
} = await import('./sweeper.js');

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
  sweepWhereArgs.length = 0;
  dbExecute.mockResolvedValue([]);
  finalizeFailedJobMock.mockClear();
  finalizeFailedJobMock.mockResolvedValue({ scheduled: false });
});

describe('sweepZombieSessions — interactive chat exemption (ISS-321)', () => {
  it('scopes BOTH the queue-timeout and heartbeat-timeout passes to pipeline/pm sessions', async () => {
    sessionsWhere.mockResolvedValue([]); // no zombies

    await sweepZombieSessions(new Date('2026-06-05T00:00:00Z'), {});

    // Two UPDATE passes: queued-past-timeout + running-with-stale-heartbeat.
    expect(sweepWhereArgs.length).toBe(2);
    // Both passes must carry `metadata->>'type' IN ('pipeline','pm')` so a plain
    // chat session (created with metadata = {}) is never reaped while it sits
    // idle waiting on the user. This guards the AC that the stale-detector must
    // not kill a waiting chat — chat lives entirely off this predicate.
    for (const arg of sweepWhereArgs) {
      const text = sqlText(arg);
      expect(text).toMatch(/->>\s*'type'\s+IN\s*\(\s*'pipeline'\s*,\s*'pm'\s*\)/);
    }
  });
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

describe('reconcileNeverClaimedDispatches (ISS-378)', () => {
  it('candidate SELECT targets dispatched jobs with zero events past the grace cutoff', async () => {
    dbExecute.mockResolvedValueOnce([]); // no candidates
    const result = await reconcileNeverClaimedDispatches(new Date('2026-06-04T00:00:00Z'));

    expect(result.reconciled).toBe(0);
    const text = sqlText(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/j\.status\s*=\s*'dispatched'/);
    expect(text).toMatch(/dispatched_at\s+IS\s+NOT\s+NULL/);
    expect(text).toMatch(/dispatched_at\s*</);
    // Zero events of ANY kind — NOT scoped to result events (that is the
    // session-driven sibling pass's job).
    expect(text).toMatch(/NOT\s+EXISTS[\s\S]*job_events/);
    expect(text).not.toMatch(/kind\s*=\s*'result'/);
    expect(finalizeFailedJobMock).not.toHaveBeenCalled();
  });

  it('reaps an unclaimed dispatch through finalizeFailedJob with the dispatch_unclaimed error', async () => {
    dbExecute.mockResolvedValueOnce([{ id: 'unclaimed-1' }]);
    sessionsWhere.mockResolvedValueOnce([
      { id: 'unclaimed-1', projectId: 'p1', issueId: 'i1', status: 'failed' },
    ]);

    const result = await reconcileNeverClaimedDispatches(new Date('2026-06-04T00:00:00Z'));

    expect(result.reconciled).toBe(1);
    expect(finalizeFailedJobMock).toHaveBeenCalledTimes(1);
    expect(finalizeFailedJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'unclaimed-1' }),
      expect.objectContaining({ error: 'dispatch_unclaimed' }),
    );
  });

  it('skips a dispatch that lost the CAS race (runner claimed it the same instant)', async () => {
    dbExecute.mockResolvedValueOnce([{ id: 'unclaimed-2' }]);
    sessionsWhere.mockResolvedValueOnce([]); // CAS returned no row

    const result = await reconcileNeverClaimedDispatches(new Date('2026-06-04T00:00:00Z'));

    expect(result.reconciled).toBe(0);
    expect(finalizeFailedJobMock).not.toHaveBeenCalled();
  });
});

describe('runPipelineSweep — queue snapshots (ISS-381 2.2)', () => {
  it('emits a grouped per-project INSERT into queue_snapshots each tick', async () => {
    const result = await runPipelineSweep();
    expect(result.queueSnapshots).toBe(0); // default mock returns []
    const insertCall = dbExecute.mock.calls.find((c) =>
      sqlText(c[0]).includes('queue_snapshots'),
    );
    expect(insertCall).toBeDefined();
    const text = sqlText(insertCall?.[0]);
    expect(text).toContain('INSERT INTO queue_snapshots');
    expect(text).toContain('GROUP BY project_id');
    expect(text).toMatch(/FILTER\s*\(WHERE\s+status\s*=\s*'queued'\)/);
  });

  it('counts the rows written', async () => {
    dbExecute.mockImplementation(async (q: unknown) =>
      sqlText(q).includes('queue_snapshots') ? [{ project_id: 'p1' }, { project_id: 'p2' }] : [],
    );
    const result = await runPipelineSweep();
    expect(result.queueSnapshots).toBe(2);
  });

  it('is best-effort — a snapshot failure never aborts the tick', async () => {
    dbExecute.mockImplementation(async (q: unknown) => {
      if (sqlText(q).includes('queue_snapshots')) throw new Error('insert boom');
      return [];
    });
    const result = await runPipelineSweep();
    expect(result.queueSnapshots).toBe(0);
    expect(result).toHaveProperty('backstopProjects');
  });
});
