import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));

const zeroAxis = { reaped: 0, killRequested: 0, awaitingKill: 0 };

// ISS-449 — the loop monitor is the primary pass; the sweeper only drives it.
// Mock it so these tests assert the sweeper's own contract (ordering, alarm
// passes, still-active reapers) without pulling in the loop's reap graph.
const zeroLoopResult = {
  ackMisses: zeroAxis,
  sessions: { queueTimedOut: 0, heartbeatTimedOut: 0, noClientAcked: 0 },
  sessionLostJobs: zeroAxis,
  resultMisses: zeroAxis,
};
const runLoopMonitorMock = vi.fn(async (..._args: unknown[]) => zeroLoopResult);
vi.mock('../jobs/loop-monitor.js', () => ({
  runLoopMonitor: (...args: unknown[]) => runLoopMonitorMock(...(args as [])),
  getLoopThresholds: () => ({ queueMs: 120_000, heartbeatMs: 180_000, ackMs: 180_000 }),
}));

const emitWedgeMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./wedge.js', () => ({
  emitPipelineWedge: (...args: unknown[]) => emitWedgeMock(...(args as [])),
}));

const alarmAgedHoldsMock = vi.fn(async (_now?: Date) => ({ alerted: 0 }));
const alarmChurningIssuesMock = vi.fn(async () => ({ alerted: 0 }));
const alarmStalledQueuedJobsMock = vi.fn(async (_now?: Date) => ({ alerted: 0 }));
const alarmPausedRunsWithQueuedWorkMock = vi.fn(async (_now?: Date) => ({ alerted: 0 }));
const alarmRejectionStreaksMock = vi.fn(async () => ({ alerted: 0 }));
vi.mock('./inv7-alarms.js', () => ({
  alarmAgedHolds: (now?: Date) => alarmAgedHoldsMock(now),
  alarmChurningIssues: () => alarmChurningIssuesMock(),
  alarmPausedRunsWithQueuedWork: (now?: Date) => alarmPausedRunsWithQueuedWorkMock(now),
  alarmRejectionStreaks: () => alarmRejectionStreaksMock(),
  alarmStalledQueuedJobs: (now?: Date) => alarmStalledQueuedJobsMock(now),
}));

const resumeOrphanedPausesMock = vi.fn(async () => ({ detected: 0, resumed: 0 }));
vi.mock('./run-pause.js', () => ({ resumeOrphanedPauses: () => resumeOrphanedPausesMock() }));

const detectRetryRescueThresholdsMock = vi.fn(async (_now?: Date) => ({
  detected: 0,
  notified: 0,
}));
vi.mock('./retry-rescue-alert.js', () => ({
  detectRetryRescueThresholds: (now?: Date) => detectRetryRescueThresholdsMock(now),
}));

// cm:why ISS-652 — alertSweep issues its own real db.execute calls (alert-queries.ts); this suite's db.execute mock is a single shared mockResolvedValueOnce queue, so an unmocked pass would silently consume another pass's queued result
const alertsMock = vi.fn(async (_now?: Date) => ({ evaluated: 0, notified: 0, resolved: 0 }));
vi.mock('../admin/alert-sweeper.js', () => ({ runAlertSweep: (now?: Date) => alertsMock(now) }));

const dbExecute = vi.fn(async (..._args: unknown[]) => [] as Array<Record<string, unknown>>);
const sessionsWhere = vi.fn();
const selectWhere = vi.fn(async () => [] as Array<{ status: string }>);
// cm:why two unrelated writers land in this one mock — the park-comment pass and `applyKernelTransition`'s audit row — so a test that asserts on call count instead of filtering by `body` passes or fails on the other one's behaviour.
const dbInsertValues = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock('../db/client.js', () => ({
  db: {
    execute: (...args: unknown[]) => dbExecute(...(args as [])),
    update: () => ({ set: () => ({ where: () => ({ returning: () => sessionsWhere() }) }) }),
    insert: () => ({ values: (...args: unknown[]) => dbInsertValues(...args) }),
    select: () => ({
      from: () => ({
        where: () => selectWhere(),
      }),
    }),
  },
}));

// cm:why mocked rather than exercised: resolveGateSettings ends in `.limit()`, which this file's `db.select` double does not model
const resolveGateSettingsMock = vi.fn(async (_projectId: string) => ({
  cap: 1,
  baseStampable: true,
}));
vi.mock('../jobs/queued-gates.js', () => ({
  resolveGateSettings: (...args: unknown[]) => resolveGateSettingsMock(...(args as [string])),
}));

const applyStatusTransitionMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../issues/apply-transition.js', () => ({
  applyStatusTransition: (...args: unknown[]) => applyStatusTransitionMock(...args),
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

const recordTickMock = vi.fn();
vi.mock('../jobs/pgboss-health.js', () => ({
  recordPipelineSweeperTick: (...a: unknown[]) => recordTickMock(...a),
}));

const sentryCapture = vi.fn();
vi.mock('../observability/sentry.js', () => ({
  Sentry: { captureException: (...a: unknown[]) => sentryCapture(...a) },
  isSentryEnabled: () => true,
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
  closeIdleChatSessions,
  CHAT_IDLE_CLOSE_MS,
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
  sessionsWhere.mockReset();
  sessionsWhere.mockResolvedValue([]);
  selectWhere.mockReset();
  selectWhere.mockResolvedValue([]);
  closeRunIfOneShotMock.mockResolvedValue(undefined);
  closeOpenRunForIssueMock.mockResolvedValue(undefined);
  dbExecute.mockResolvedValue([]);
  dbInsertValues.mockResolvedValue(undefined);
  resolveGateSettingsMock.mockResolvedValue({ cap: 1, baseStampable: true });
  applyStatusTransitionMock.mockResolvedValue(undefined);
  detectRetryRescueThresholdsMock.mockResolvedValue({ detected: 0, notified: 0 });
  runLoopMonitorMock.mockResolvedValue(zeroLoopResult);
});

describe('runPipelineSweep — retry rescue thresholds', () => {
  it('runs the detector and exposes its result', async () => {
    detectRetryRescueThresholdsMock.mockResolvedValueOnce({ detected: 1, notified: 1 });

    const result = await runPipelineSweep();

    expect(detectRetryRescueThresholdsMock).toHaveBeenCalledTimes(1);
    expect(result.retryRescueThresholds).toEqual({ detected: 1, notified: 1 });
  });
});

describe('runPipelineSweep — watch-only alarm passes', () => {
  // cm:guard every pass here must stay in the sweep AND in SweepResult — a pass wired into the driver but dropped from the result is invisible to every caller, which is how a defence stops being noticed before it stops working
  it('runs each alarm pass and exposes its count', async () => {
    const passes = [
      [alarmAgedHoldsMock, 'agedHolds', 2],
      [alarmChurningIssuesMock, 'churningIssues', 1],
      [alarmStalledQueuedJobsMock, 'stalledQueuedJobs', 3],
      [alarmRejectionStreaksMock, 'rejectionStreaks', 4],
      [alarmPausedRunsWithQueuedWorkMock, 'pausedRunsWithQueuedWork', 5],
    ] as const;
    for (const [mock, , alerted] of passes) mock.mockResolvedValueOnce({ alerted });

    const result = await runPipelineSweep();

    for (const [mock, key, alerted] of passes) {
      expect(mock).toHaveBeenCalledTimes(1);
      expect(result[key]).toEqual({ alerted });
    }
  });

  // cm:guard this pass must stay in the sweep AND in SweepResult — it is the only thing that frees a run paused by a mechanism a later build deleted, and the reopen_cap residue it exists for produced no alarm anywhere for 3 days
  it('runs the orphaned-pause reaper and exposes its counts', async () => {
    resumeOrphanedPausesMock.mockResolvedValueOnce({ detected: 2, resumed: 2 });

    const result = await runPipelineSweep();

    expect(resumeOrphanedPausesMock).toHaveBeenCalledTimes(1);
    expect(result.orphanedPauses).toEqual({ detected: 2, resumed: 2 });
  });
});

describe('runPipelineSweep — alert sweep (ISS-652)', () => {
  it('runs the alert sweep and exposes its result', async () => {
    alertsMock.mockResolvedValueOnce({ evaluated: 5, notified: 2, resolved: 1 });
    const result = await runPipelineSweep();
    expect(alertsMock).toHaveBeenCalledTimes(1);
    expect(result.alerts).toEqual({ evaluated: 5, notified: 2, resolved: 1 });
  });
});

describe('runPipelineSweep — loop-first ordering (ISS-449)', () => {
  it('runs the loop monitor FIRST and reports its result', async () => {
    const ackMisses = { reaped: 1, killRequested: 0, awaitingKill: 0 };
    const sessionLostJobs = { reaped: 3, killRequested: 0, awaitingKill: 0 };
    runLoopMonitorMock.mockResolvedValueOnce({
      ackMisses,
      sessions: { queueTimedOut: 2, heartbeatTimedOut: 0, noClientAcked: 0 },
      sessionLostJobs,
      resultMisses: zeroAxis,
    });
    const result = await runPipelineSweep();
    expect(runLoopMonitorMock).toHaveBeenCalledTimes(1);
    expect(result.loop).toEqual({
      ackMisses,
      sessions: { queueTimedOut: 2, heartbeatTimedOut: 0, noClientAcked: 0 },
      sessionLostJobs,
      resultMisses: zeroAxis,
    });
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
  it('candidate SELECT covers active jobs + terminal sessions, skips result-event jobs, and excludes rows still inside the kill-gate grace', async () => {
    dbExecute.mockResolvedValueOnce([]);
    const result = await alarmOrphanedJobs(new Date('2026-05-30T00:00:00Z'));

    expect(result.reconciled).toBe(0);
    const text = sqlText(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/j\.status\s+IN\s*\(\s*'dispatched'\s*,\s*'running'\s*\)/);
    expect(text).toMatch(/s\.status\s+IN\s*\(\s*'failed'\s*,\s*'cancelled_stale'\s*\)/);
    expect(text).toMatch(/NOT\s+EXISTS[\s\S]*job_events[\s\S]*kind\s*=\s*'result'/);
    expect(text).toMatch(/kill_requested_at\s+IS\s+NULL\s+OR\s+j\.kill_requested_at\s*<=/);
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
  it('candidate SELECT adds the acked_at IS NULL term (lockstep with the ack hop) and excludes rows still inside the kill-gate grace', async () => {
    dbExecute.mockResolvedValueOnce([]);
    const result = await alarmNeverClaimedDispatches(new Date('2026-06-04T00:00:00Z'));

    expect(result.reconciled).toBe(0);
    const text = sqlText(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/j\.status\s*=\s*'dispatched'/);
    expect(text).toMatch(/acked_at\s+IS\s+NULL/);
    expect(text).toMatch(/dispatched_at\s+IS\s+NOT\s+NULL/);
    expect(text).toMatch(/NOT\s+EXISTS[\s\S]*job_events/);
    expect(text).not.toMatch(/kind\s*=\s*'result'/);
    expect(text).toMatch(/kill_requested_at\s+IS\s+NULL\s+OR\s+j\.kill_requested_at\s*<=/);
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

describe('runPipelineSweep — per-pass fault isolation', () => {
  it('still runs the reapers when an upstream pass (loop monitor) throws, and re-throws to keep the missed-tick alarm', async () => {
    runLoopMonitorMock.mockRejectedValueOnce(new Error('loop boom'));

    // The sweep still rejects (pgboss-health missed-tick contract preserved)…
    await expect(runPipelineSweep()).rejects.toThrow('loop boom');

    // …but the one-shot reaper pass DID run despite the upstream throw — proven
    // by its distinctive candidate SELECT reaching the db. This is the
    // regression guard for the global schedule.run / interactive run leak.
    const ranOneShotReaper = dbExecute.mock.calls.some((c) =>
      /r\.kind\s+IN\s*\(\s*'system'\s*,\s*'interactive'\s*\)/.test(sqlText(c[0])),
    );
    expect(ranOneShotReaper).toBe(true);

    // A failed tick must NOT record a clean heartbeat (so the alarm fires)…
    expect(recordTickMock).not.toHaveBeenCalled();
    // …and the failing pass is captured individually for triage.
    expect(sentryCapture).toHaveBeenCalled();
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

describe('closeIdleChatSessions — quiet chat sessions are closed, not left live', () => {
  it('is a 2h threshold', () => {
    expect(CHAT_IDLE_CLOSE_MS).toBe(2 * 60 * 60_000);
  });

  it('excludes job-linked and schedule.run sessions, and rows that never started', async () => {
    dbExecute.mockResolvedValueOnce([]);
    const result = await closeIdleChatSessions(new Date('2026-08-13T00:00:00Z'));

    expect(result.closed).toBe(0);
    const text = sqlText(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/s\.status\s+IN\s*\(\s*'queued'\s*,\s*'running'\s*,\s*'idle'\s*\)/);
    expect(text).toMatch(/s\.started_at\s+IS\s+NOT\s+NULL/);
    expect(text).toMatch(/NOT\s+EXISTS[\s\S]*FROM\s+jobs\s+j/);
    expect(text).toMatch(/schedule\.run/);
    expect(sessionsWhere).not.toHaveBeenCalled();
  });

  it('settles a quiet session completed with no failure reason and broadcasts it', async () => {
    dbExecute.mockResolvedValueOnce([{ id: 'sess-idle' }]);
    sessionsWhere.mockResolvedValueOnce([
      { id: 'sess-idle', projectId: 'p1', deviceId: 'd1', status: 'completed' },
    ]);

    const result = await closeIdleChatSessions(new Date('2026-08-13T00:00:00Z'));

    expect(result.closed).toBe(1);
    expect(broadcastSessionEventMock).toHaveBeenCalledWith(
      'sess-idle',
      'p1',
      'd1',
      'agent-session.status',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('runs as part of runPipelineSweep and reports the count', async () => {
    const result = await runPipelineSweep();
    expect(result.idleChatSessions).toEqual({ closed: 0 });
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
    // cm:guard the status list here IS `RUN_CLOSING_STATUSES` in issues/apply-transition.ts — assert every member, because this pass is that block's only backstop and a member missing here leaks its runs forever with no reaper on any axis (`dropped` was exactly that drift until 2026-08-30)
    expect(text).toMatch(/i\.status\s+IN\s*\(\s*'closed'\s*,\s*'dropped'\s*\)/);
    expect(text).not.toMatch(/released/);
    expect(text).toMatch(/JOIN\s+issues\s+i/);
    expect(text).toMatch(/started_at\s*</);
    expect(closeOpenRunForIssueMock).not.toHaveBeenCalled();
  });

  it('does not reap a run whose issue is `released` (ISS-669 — release runs inside the open run)', async () => {
    // cm:guard `released` must never join the status list above — the release step runs INSIDE the still-open run (ISS-669), so reaping there would cancel the very job doing the release; the SQL-shape assertion above is what actually holds it, this asserts the behaviour that follows
    dbExecute.mockResolvedValueOnce([]);
    const result = await reapOrphanedIssueRuns(new Date('2026-06-12T00:00:00Z'));

    expect(result.reaped).toBe(0);
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
    // cm:guard assert a LATER pass reported — that is what shows the tick reached its end rather than unwinding out of the snapshot failure; asserting only `queueSnapshots` would pass on a tick that died right after it.
    expect(result).toHaveProperty('alerts');
  });
});
