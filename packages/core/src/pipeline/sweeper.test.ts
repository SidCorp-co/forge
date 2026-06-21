import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test' },
}));

const dispatchTick = vi.fn(async (_projectId: string) => {});

vi.mock('../jobs/dispatch-tick.js', () => ({
  dispatchTickForProject: (projectId: string) => dispatchTick(projectId),
}));

// ISS-449 — the loop monitor is the primary pass; the sweeper only drives it.
// Mock it so these tests assert the sweeper's own contract (ordering, alarm
// passes, still-active reapers) without pulling in the loop's reap graph.
const runLoopMonitorMock = vi.fn(async (..._args: unknown[]) => ({
  ackMisses: 0,
  sessions: { queueTimedOut: 0, heartbeatTimedOut: 0, noClientAcked: 0 },
  sessionLostJobs: 0,
  resultMisses: 0,
}));
vi.mock('../jobs/loop-monitor.js', () => ({
  runLoopMonitor: (...args: unknown[]) => runLoopMonitorMock(...(args as [])),
  getLoopThresholds: () => ({ queueMs: 120_000, heartbeatMs: 180_000, ackMs: 180_000 }),
}));

const emitWedgeMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./wedge.js', () => ({
  emitPipelineWedge: (...args: unknown[]) => emitWedgeMock(...(args as [])),
}));

const dbExecute = vi.fn(async (..._args: unknown[]) => [] as Array<Record<string, unknown>>);
const sessionsWhere = vi.fn();
// ISS-445 — db.select(...).from(...).where(...) result, used by
// reapOrphanedOneShotRuns to read a run's session statuses for outcome.
const selectWhere = vi.fn(async () => [] as Array<{ status: string }>);
const queuedProjectsRows: Array<{ projectId: string }> = [];

vi.mock('../db/client.js', () => ({
  db: {
    execute: (...args: unknown[]) => dbExecute(...(args as [])),
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => sessionsWhere() }),
      }),
    }),
    // ISS-447 — applyKernelTransition writes the kernel_transitions audit row
    // on the same db handle after each terminal flip (one-shot run pass).
    insert: () => ({ values: async () => undefined }),
    select: () => ({
      from: () => ({
        where: () => selectWhere(),
      }),
    }),
    selectDistinct: () => ({
      from: () => ({
        where: () => queuedProjectsRows,
      }),
    }),
  },
}));

// ISS-445 — reapOrphanedOneShotRuns closes runs through the shared
// closeRunIfOneShot SSOT. Mock it so the sweeper test asserts the call
// contract without pulling in the runs.ts → hooks → cascade graph.
const closeRunIfOneShotMock = vi.fn(async (..._args: unknown[]) => {});
// ISS-461 — reapOrphanedIssueRuns closes issue runs through the shared
// closeOpenRunForIssue SSOT; mocked for the same reason as closeRunIfOneShot.
const closeOpenRunForIssueMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock('./runs.js', () => ({
  closeRunIfOneShot: (...args: unknown[]) => closeRunIfOneShotMock(...args),
  closeOpenRunForIssue: (...args: unknown[]) => closeOpenRunForIssueMock(...args),
}));

vi.mock('../queue/boss.js', () => ({ boss: {} }));

vi.mock('../jobs/pgboss-health.js', () => ({
  recordPipelineSweeperTick: vi.fn(),
}));

const broadcastSessionEventMock = vi.fn();
vi.mock('../jobs/agent-session-link.js', () => ({
  broadcastSessionEvent: (...args: unknown[]) => broadcastSessionEventMock(...args),
}));

const loggerWarn = vi.fn();
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: (...a: unknown[]) => loggerWarn(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const {
  runPipelineSweep,
  alarmZombieSessions,
  alarmOrphanedJobs,
  alarmNeverClaimedDispatches,
  reapOrphanedOneShotRuns,
  reapOrphanedIssueRuns,
  detectStalledDependencies,
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
  sessionsWhere.mockResolvedValue([]);
  selectWhere.mockReset();
  selectWhere.mockResolvedValue([]);
  closeRunIfOneShotMock.mockClear();
  closeRunIfOneShotMock.mockResolvedValue(undefined);
  closeOpenRunForIssueMock.mockClear();
  closeOpenRunForIssueMock.mockResolvedValue(undefined);
  queuedProjectsRows.length = 0;
  dbExecute.mockResolvedValue([]);
  emitWedgeMock.mockClear();
  runLoopMonitorMock.mockClear();
  runLoopMonitorMock.mockResolvedValue({
    ackMisses: 0,
    sessions: { queueTimedOut: 0, heartbeatTimedOut: 0, noClientAcked: 0 },
    sessionLostJobs: 0,
    resultMisses: 0,
  });
});

describe('runPipelineSweep — loop-first ordering (ISS-449)', () => {
  it('runs the loop monitor FIRST and reports its result', async () => {
    runLoopMonitorMock.mockResolvedValueOnce({
      ackMisses: 1,
      sessions: { queueTimedOut: 2, heartbeatTimedOut: 0, noClientAcked: 0 },
      sessionLostJobs: 3,
      resultMisses: 0,
    });
    const result = await runPipelineSweep();
    expect(runLoopMonitorMock).toHaveBeenCalledTimes(1);
    expect(result.loop).toEqual({
      ackMisses: 1,
      sessions: { queueTimedOut: 2, heartbeatTimedOut: 0, noClientAcked: 0 },
      sessionLostJobs: 3,
      resultMisses: 0,
    });
    // The loop ran before the alarm SELECTs hit the db (call order).
    const firstAlarmCall = dbExecute.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const loopCall = runLoopMonitorMock.mock.invocationCallOrder[0] ?? Number.NaN;
    expect(loopCall).toBeLessThan(firstAlarmCall);
  });
});

describe('alarmZombieSessions — demoted to alarm-only (ISS-449)', () => {
  it('keeps the pipeline/pm scoping + ISS-420 no-client predicate in the detection SELECTs', async () => {
    await alarmZombieSessions(new Date('2026-06-05T00:00:00Z'), {});

    // Three detection SELECTs: queued-past-timeout, running-with-stale-
    // heartbeat, and the no-client-ack detector for chat/schedule sessions.
    expect(dbExecute).toHaveBeenCalledTimes(3);
    const [pass1, pass2, pass3] = dbExecute.mock.calls.map((c) => sqlText(c[0]));

    expect(pass1).toMatch(/->>\s*'type'\s+IN\s*\(\s*'pipeline'\s*,\s*'pm'\s*\)/);
    expect(pass2).toMatch(/->>\s*'type'\s+IN\s*\(\s*'pipeline'\s*,\s*'pm'\s*\)/);
    expect(pass3).toMatch(/COALESCE/i);
    expect(pass3).toMatch(/NOT\s+IN\s*\(\s*'pipeline'\s*,\s*'pm'\s*\)/);
    expect(pass3).toMatch(/claude_session_id\s+IS\s+NULL/i);
    expect(pass1).not.toMatch(/NOT\s+IN\s*\(\s*'pipeline'/);
    expect(pass2).not.toMatch(/NOT\s+IN\s*\(\s*'pipeline'/);
  });

  it('a match is alarmed (loop-miss + wedge), never reaped', async () => {
    dbExecute
      .mockResolvedValueOnce([{ id: 's-q', project_id: 'p1', pipeline_run_id: null }]) // queued
      .mockResolvedValueOnce([]) // heartbeat
      .mockResolvedValueOnce([]); // no-client

    const result = await alarmZombieSessions(new Date('2026-06-05T00:00:00Z'), {});

    expect(result).toEqual({ queueTimedOut: 1, heartbeatTimedOut: 0, noClientAcked: 0 });
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ hop: 'claim', ids: ['s-q'] }),
      'loop-miss',
    );
    expect(emitWedgeMock).toHaveBeenCalledWith(
      expect.objectContaining({ hop: 'claim', entity: 'session', entityId: 's-q' }),
    );
  });
});

describe('alarmOrphanedJobs — demoted to alarm-only (was ISS-280 reconcile)', () => {
  it('candidate SELECT covers active jobs + terminal sessions and skips result-event jobs', async () => {
    dbExecute.mockResolvedValueOnce([]);
    const result = await alarmOrphanedJobs(new Date('2026-05-30T00:00:00Z'));

    expect(result.reconciled).toBe(0);
    const text = sqlText(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/j\.status\s+IN\s*\(\s*'dispatched'\s*,\s*'running'\s*\)/);
    expect(text).toMatch(/s\.status\s+IN\s*\(\s*'failed'\s*,\s*'cancelled_stale'\s*\)/);
    expect(text).toMatch(/NOT\s+EXISTS[\s\S]*job_events[\s\S]*kind\s*=\s*'result'/);
    expect(emitWedgeMock).not.toHaveBeenCalled();
  });

  it('alarms a match with a heartbeat-hop wedge, no terminal write', async () => {
    dbExecute.mockResolvedValueOnce([{ id: 'orphan-1', project_id: 'p1', issue_id: 'i1' }]);
    const result = await alarmOrphanedJobs(new Date('2026-05-30T00:00:00Z'));

    expect(result.reconciled).toBe(1);
    expect(sessionsWhere).not.toHaveBeenCalled(); // no UPDATE issued
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ hop: 'heartbeat', ids: ['orphan-1'] }),
      'loop-miss',
    );
    expect(emitWedgeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hop: 'heartbeat',
        entity: 'job',
        entityId: 'orphan-1',
        issueId: 'i1',
      }),
    );
  });
});

describe('alarmNeverClaimedDispatches — demoted to alarm-only (was ISS-378)', () => {
  it('candidate SELECT adds the acked_at IS NULL term (lockstep with the ack hop)', async () => {
    dbExecute.mockResolvedValueOnce([]);
    const result = await alarmNeverClaimedDispatches(new Date('2026-06-04T00:00:00Z'));

    expect(result.reconciled).toBe(0);
    const text = sqlText(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/j\.status\s*=\s*'dispatched'/);
    expect(text).toMatch(/acked_at\s+IS\s+NULL/);
    expect(text).toMatch(/dispatched_at\s+IS\s+NOT\s+NULL/);
    expect(text).toMatch(/NOT\s+EXISTS[\s\S]*job_events/);
    expect(text).not.toMatch(/kind\s*=\s*'result'/);
  });

  it('alarms a match with an ack-hop wedge, no terminal write', async () => {
    dbExecute.mockResolvedValueOnce([{ id: 'unclaimed-1', project_id: 'p1', issue_id: null }]);
    const result = await alarmNeverClaimedDispatches(new Date('2026-06-04T00:00:00Z'));

    expect(result.reconciled).toBe(1);
    expect(sessionsWhere).not.toHaveBeenCalled();
    expect(emitWedgeMock).toHaveBeenCalledWith(
      expect.objectContaining({ hop: 'ack', entity: 'job', entityId: 'unclaimed-1' }),
    );
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

describe('reapOrphanedOneShotRuns (ISS-445 — still an ACTIVE reaper)', () => {
  it('candidate SELECT scopes to job-less system/interactive runs with no live session past the age cutoff', async () => {
    dbExecute.mockResolvedValueOnce([]); // no candidates
    const result = await reapOrphanedOneShotRuns(new Date('2026-06-12T00:00:00Z'));

    expect(result.reaped).toBe(0);
    const text = sqlText(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/r\.kind\s+IN\s*\(\s*'system'\s*,\s*'interactive'\s*\)/);
    expect(text).toMatch(/r\.status\s+IN\s*\(\s*'running'\s*,\s*'paused'\s*\)/);
    expect(text).toMatch(/started_at\s*</);
    expect(text).toMatch(/NOT\s+EXISTS[\s\S]*FROM\s+jobs\s+j/);
    expect(text).toMatch(/NOT\s+EXISTS[\s\S]*FROM\s+agent_sessions\s+s/);
    expect(text).toMatch(/COALESCE/i);
    expect(closeRunIfOneShotMock).not.toHaveBeenCalled();
  });

  it('force-fails a lingering stale session then closes the run as failed', async () => {
    dbExecute.mockResolvedValueOnce([{ id: 'run-stale' }]); // one candidate
    sessionsWhere.mockResolvedValueOnce([{ id: 'sess-1', projectId: 'p1', deviceId: 'd1' }]);
    selectWhere.mockResolvedValueOnce([{ status: 'failed' }]);

    const result = await reapOrphanedOneShotRuns(new Date('2026-06-12T00:00:00Z'));

    expect(result.reaped).toBe(1);
    expect(broadcastSessionEventMock).toHaveBeenCalledWith(
      'sess-1',
      'p1',
      'd1',
      'agent-session.status',
      expect.objectContaining({ status: 'failed', failureReason: 'heartbeat_timeout' }),
    );
    expect(closeRunIfOneShotMock).toHaveBeenCalledTimes(1);
    expect(closeRunIfOneShotMock).toHaveBeenCalledWith('run-stale', 'failed');
  });

  it('closes a run as completed when the session already finished (missed /desktop/status)', async () => {
    dbExecute.mockResolvedValueOnce([{ id: 'run-done' }]);
    sessionsWhere.mockResolvedValueOnce([]); // nothing left to flip
    selectWhere.mockResolvedValueOnce([{ status: 'completed' }]);

    const result = await reapOrphanedOneShotRuns(new Date('2026-06-12T00:00:00Z'));

    expect(result.reaped).toBe(1);
    expect(closeRunIfOneShotMock).toHaveBeenCalledWith('run-done', 'completed');
  });

  it('does not let one failing run abort the pass', async () => {
    dbExecute.mockResolvedValueOnce([{ id: 'run-a' }, { id: 'run-b' }]);
    sessionsWhere.mockResolvedValue([]);
    selectWhere.mockResolvedValue([{ status: 'completed' }]);
    closeRunIfOneShotMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);

    const result = await reapOrphanedOneShotRuns(new Date('2026-06-12T00:00:00Z'));

    expect(result.reaped).toBe(1);
    expect(closeRunIfOneShotMock).toHaveBeenCalledTimes(2);
  });

  it('runs as part of runPipelineSweep and reports the count', async () => {
    const result = await runPipelineSweep();
    expect(result).toHaveProperty('orphanedOneShotRuns');
    expect(result.orphanedOneShotRuns.reaped).toBe(0); // default mock: no candidates
  });
});

describe('reapOrphanedIssueRuns (ISS-461 — issue runs leaked past a terminal issue)', () => {
  it('candidate SELECT scopes to issue runs whose backing issue is terminal, past the age cutoff', async () => {
    dbExecute.mockResolvedValueOnce([]); // no candidates
    const result = await reapOrphanedIssueRuns(new Date('2026-06-12T00:00:00Z'));

    expect(result.reaped).toBe(0);
    const text = sqlText(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/r\.kind\s*=\s*'issue'/);
    expect(text).toMatch(/r\.status\s+IN\s*\(\s*'running'\s*,\s*'paused'\s*\)/);
    expect(text).toMatch(/i\.status\s+IN\s*\(\s*'closed'\s*,\s*'released'\s*\)/);
    expect(text).toMatch(/JOIN\s+issues\s+i/);
    expect(text).toMatch(/started_at\s*</);
    expect(closeOpenRunForIssueMock).not.toHaveBeenCalled();
  });

  it('closes each candidate via closeOpenRunForIssue(issueId, "completed")', async () => {
    dbExecute.mockResolvedValueOnce([
      { id: 'run-1', issue_id: 'iss-1' },
      { id: 'run-2', issue_id: 'iss-2' },
    ]);

    const result = await reapOrphanedIssueRuns(new Date('2026-06-12T00:00:00Z'));

    expect(result.reaped).toBe(2);
    expect(closeOpenRunForIssueMock).toHaveBeenCalledTimes(2);
    expect(closeOpenRunForIssueMock).toHaveBeenNthCalledWith(1, 'iss-1', 'completed');
    expect(closeOpenRunForIssueMock).toHaveBeenNthCalledWith(2, 'iss-2', 'completed');
  });

  it('does not let one failing close abort the pass', async () => {
    dbExecute.mockResolvedValueOnce([
      { id: 'run-a', issue_id: 'iss-a' },
      { id: 'run-b', issue_id: 'iss-b' },
    ]);
    closeOpenRunForIssueMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    const result = await reapOrphanedIssueRuns(new Date('2026-06-12T00:00:00Z'));

    expect(result.reaped).toBe(1);
    expect(closeOpenRunForIssueMock).toHaveBeenCalledTimes(2);
  });

  it('runs as part of runPipelineSweep and reports the count', async () => {
    const result = await runPipelineSweep();
    expect(result).toHaveProperty('orphanedIssueRuns');
    expect(result.orphanedIssueRuns.reaped).toBe(0); // default mock: no candidates
  });
});

describe('runPipelineSweep — queue snapshots (ISS-381 2.2)', () => {
  it('emits a grouped per-project INSERT into queue_snapshots each tick', async () => {
    const result = await runPipelineSweep();
    expect(result.queueSnapshots).toBe(0); // default mock returns []
    const insertCall = dbExecute.mock.calls.find((c) => sqlText(c[0]).includes('queue_snapshots'));
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

describe('detectStalledDependencies — never-clearing gate (ISS-442)', () => {
  const stalledRow = {
    job_id: '11111111-1111-4111-8111-111111111111',
    project_id: '22222222-2222-4222-8222-222222222222',
    job_type: 'code',
    issue_id: '33333333-3333-4333-8333-333333333333',
    blocker_id: '44444444-4444-4444-8444-444444444444',
    blocker_status: 'tested',
    kind: 'blocks',
    queued_secs: 7200,
  };

  it('emits a deduped dispatch-hop wedge per parked-blocker deadlock', async () => {
    dbExecute.mockResolvedValueOnce([stalledRow]);
    const res = await detectStalledDependencies(new Date());
    expect(res.detected).toBe(1);
    expect(emitWedgeMock).toHaveBeenCalledTimes(1);
    expect(emitWedgeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hop: 'dispatch',
        entity: 'job',
        entityId: stalledRow.job_id,
        issueId: stalledRow.issue_id,
        projectId: stalledRow.project_id,
      }),
    );
  });

  it('dedupes multiple rows for the same job (two blockers → one wedge)', async () => {
    dbExecute.mockResolvedValueOnce([
      stalledRow,
      { ...stalledRow, blocker_id: '55555555-5555-4555-8555-555555555555' },
    ]);
    const res = await detectStalledDependencies(new Date());
    expect(res.detected).toBe(1);
    expect(emitWedgeMock).toHaveBeenCalledTimes(1);
  });

  it('no rows → no wedge, detected 0', async () => {
    dbExecute.mockResolvedValueOnce([]);
    const res = await detectStalledDependencies(new Date());
    expect(res.detected).toBe(0);
    expect(emitWedgeMock).not.toHaveBeenCalled();
  });

  it('swallows a query error (best-effort, returns 0)', async () => {
    dbExecute.mockRejectedValueOnce(new Error('boom'));
    const res = await detectStalledDependencies(new Date());
    expect(res.detected).toBe(0);
  });
});
