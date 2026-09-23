import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));

const zeroAxis = { reaped: 0, killRequested: 0, awaitingKill: 0 };

const zeroLoopResult = {
  ackMisses: zeroAxis,
  sessions: { queueTimedOut: 0, turnNeverReported: 0, heartbeatTimedOut: 0, noClientAcked: 0 },
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
const alarmStalledQueuedJobsMock = vi.fn(async (_now?: Date) => ({ alerted: 0 }));
const alarmPausedRunsWithQueuedWorkMock = vi.fn(async (_now?: Date) => ({ alerted: 0 }));
const alarmRejectionStreaksMock = vi.fn(async () => ({ alerted: 0 }));
vi.mock('./inv7-alarms.js', () => ({
  alarmAgedHolds: (now?: Date) => alarmAgedHoldsMock(now),
  alarmPausedRunsWithQueuedWork: (now?: Date) => alarmPausedRunsWithQueuedWorkMock(now),
  alarmRejectionStreaks: () => alarmRejectionStreaksMock(),
  alarmStalledQueuedJobs: (now?: Date) => alarmStalledQueuedJobsMock(now),
}));

const resumeOrphanedPausesMock = vi.fn(async () => ({ detected: 0, resumed: 0 }));
vi.mock('./run-pause.js', () => ({ resumeOrphanedPauses: () => resumeOrphanedPausesMock() }));

const nameOverdueRunnerReleasesMock = vi.fn(async (_now?: Date) => ({ overdue: 0, named: 0 }));
vi.mock('./runner-release-deadline.js', () => ({
  nameOverdueRunnerReleases: (now?: Date) => nameOverdueRunnerReleasesMock(now),
}));

const reapConcludedRunsMock = vi.fn(async (_now?: Date) => ({ reaped: 0 }));
const reapJoblessRunsMock = vi.fn(async (_now?: Date) => ({ reaped: 0 }));
vi.mock('./runs-concluded.js', () => ({
  reapConcludedRuns: (now?: Date) => reapConcludedRunsMock(now),
  reapJoblessRuns: (now?: Date) => reapJoblessRunsMock(now),
}));

const detectOrphanedRunAssertionsMock = vi.fn(async (_now?: Date) => ({
  detected: 0,
  reported: 0,
}));
vi.mock('./issue-run-invariant.js', () => ({
  detectOrphanedRunAssertions: (now?: Date) => detectOrphanedRunAssertionsMock(now),
}));

const detectRetryRescueThresholdsMock = vi.fn(async (_now?: Date) => ({
  detected: 0,
  notified: 0,
}));
vi.mock('./retry-rescue-alert.js', () => ({
  detectRetryRescueThresholds: (now?: Date) => detectRetryRescueThresholdsMock(now),
}));

const alertsMock = vi.fn(async (_now?: Date) => ({ evaluated: 0, notified: 0, resolved: 0 }));
vi.mock('../admin/alert-sweeper.js', () => ({ runAlertSweep: (now?: Date) => alertsMock(now) }));

const dbExecute = vi.fn(async (..._args: unknown[]) => [] as Array<Record<string, unknown>>);
const sessionsWhere = vi.fn();
const selectWhere = vi.fn(async () => [] as Array<{ status: string }>);
const dbInsertValues = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock('../db/client.js', () => {
  const dbStub: Record<string, unknown> = {
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(dbStub),
    execute: (...args: unknown[]) => dbExecute(...(args as [])),
    update: () => ({ set: () => ({ where: () => ({ returning: () => sessionsWhere() }) }) }),
    insert: () => ({ values: (...args: unknown[]) => dbInsertValues(...args) }),
    select: () => ({
      from: () => ({
        where: () => selectWhere(),
      }),
    }),
  };
  return { db: dbStub };
});

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

const closeRunIfOneShotMock = vi.fn(async (..._args: unknown[]) => {});
const closeOpenRunForIssueMock = vi.fn(async (..._args: unknown[]) => 'settled' as const);
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
  closeOpenRunForIssueMock.mockResolvedValue('settled');
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
  it('runs each alarm pass and exposes its count', async () => {
    const passes = [
      [alarmAgedHoldsMock, 'agedHolds', 2],
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
      sessions: { queueTimedOut: 2, turnNeverReported: 0, heartbeatTimedOut: 0, noClientAcked: 0 },
      sessionLostJobs,
      resultMisses: zeroAxis,
    });
    const result = await runPipelineSweep();
    expect(runLoopMonitorMock).toHaveBeenCalledTimes(1);
    expect(result.loop).toEqual({
      ackMisses,
      sessions: { queueTimedOut: 2, turnNeverReported: 0, heartbeatTimedOut: 0, noClientAcked: 0 },
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

    expect(dbExecute).toHaveBeenCalledTimes(4);
    const [pass1, pass2, pass3, pass4] = dbExecute.mock.calls.map((c) => sqlText(c[0]));

    expect(pass1).toMatch(/\bs\.kind\s+IN\s*\(\s*pipeline\s*,\s*pm\s*\)/);
    expect(pass2).toMatch(/\bs\.kind\s+IN\s*\(\s*pipeline\s*,\s*pm\s*\)/);
    expect(pass3).toMatch(/\bs\.kind\s+IN\s*\(\s*pipeline\s*,\s*pm\s*\)/);
    expect(
      pass4,
      'this arm and the no-client hop it alarms for are ONE predicate, and both must see ONLY the kind that reports a `claude_session_id`. It used to say so by excluding the other four; it now names the one, which is the same rule written the way round that cannot silently admit a sixth kind. A run session is reaped by `devices/run-session-reaper.ts` — two sweeps over one row is two writers on one fact — and a master is a tmux pane that matches every other term of this arm and survives only on the daemon re-registering it (ISS-933 criteria 21 and 25a)',
    ).toMatch(/\bs\.kind\s+IN\s*\(\s*chat\s*\)/);
    expect(pass4).not.toMatch(/\bmaster\b|\brun_session\b/);
    expect(pass4).toMatch(/claude_session_id\s+IS\s+NULL/i);
    expect(pass1).not.toMatch(/\bchat\b/);
    expect(pass3).not.toMatch(/\bchat\b/);
  });

  it("mirrors the loop's two queue arms, split on last_heartbeat_at in opposite senses", async () => {
    await alarmZombieSessions(new Date('2026-06-05T00:00:00Z'), {});

    const [neverHeard, heardThenSilent] = dbExecute.mock.calls.map((c) => sqlText(c[0]));
    expect(neverHeard).toMatch(/s\.last_heartbeat_at\s+IS\s+NULL/i);
    expect(neverHeard).not.toMatch(/s\.last_heartbeat_at\s+IS\s+NOT\s+NULL/i);
    expect(heardThenSilent).toMatch(/s\.last_heartbeat_at\s+IS\s+NOT\s+NULL/i);
    expect(heardThenSilent).toMatch(/s\.status\s*=\s*'queued'/i);
  });

  it('alarms a heard-then-silent queued session on the heartbeat hop, not the claim hop', async () => {
    dbExecute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 's-n', project_id: 'p1', pipeline_run_id: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await alarmZombieSessions(new Date('2026-06-05T00:00:00Z'), {});

    expect(result.turnNeverReported).toBe(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ hop: 'heartbeat', ids: ['s-n'] }),
      'loop-miss',
    );
    expect(loggerWarn).not.toHaveBeenCalledWith(
      expect.objectContaining({ hop: 'claim', ids: ['s-n'] }),
      'loop-miss',
    );
  });

  it('a match is alarmed (loop-miss + wedge), never reaped', async () => {
    dbExecute
      .mockResolvedValueOnce([{ id: 's-q', project_id: 'p1', pipeline_run_id: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await alarmZombieSessions(new Date('2026-06-05T00:00:00Z'), {});

    expect(result).toEqual({
      queueTimedOut: 1,
      turnNeverReported: 0,
      heartbeatTimedOut: 0,
      noClientAcked: 0,
    });
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
    expect(sessionsWhere).not.toHaveBeenCalled();
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

    await expect(runPipelineSweep()).rejects.toThrow('loop boom');

    const ranOneShotReaper = dbExecute.mock.calls.some((c) =>
      /r\.kind\s+IN\s*\(\s*'system'\s*,\s*'interactive'\s*\)/.test(sqlText(c[0])),
    );
    expect(ranOneShotReaper).toBe(true);

    expect(recordTickMock).not.toHaveBeenCalled();
    expect(sentryCapture).toHaveBeenCalled();
  });
});

describe('reapOrphanedOneShotRuns (ISS-445 — still an ACTIVE reaper)', () => {
  it('candidate SELECT scopes to job-less system/interactive runs with no live session past the age cutoff', async () => {
    dbExecute.mockResolvedValueOnce([]);
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
    dbExecute.mockResolvedValueOnce([{ id: 'run-stale' }]);
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
    sessionsWhere.mockResolvedValueOnce([]);
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
    expect(result.orphanedOneShotRuns.reaped).toBe(0);
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
    dbExecute.mockResolvedValueOnce([]);
    const result = await reapOrphanedIssueRuns(new Date('2026-06-12T00:00:00Z'));

    expect(result.reaped).toBe(0);
    const text = sqlText(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/r\.kind\s*=\s*'issue'/);
    expect(text).toMatch(/r\.status\s+IN\s*\(\s*'running'\s*,\s*'paused'\s*\)/);
    expect(text).toMatch(/i\.status\s+IN\s*\(\s*'closed'\s*,\s*'dropped'\s*\)/);
    expect(text).not.toMatch(/released/);
    expect(text).toMatch(/JOIN\s+issues\s+i/);
    expect(text).toMatch(/started_at\s*</);
    expect(closeOpenRunForIssueMock).not.toHaveBeenCalled();
  });

  it('does not reap a run whose issue is `awaiting_release` (ISS-669 — release runs inside the open run)', async () => {
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
      .mockResolvedValueOnce('settled');

    const result = await reapOrphanedIssueRuns(new Date('2026-06-12T00:00:00Z'));

    expect(result.reaped).toBe(1);
    expect(closeOpenRunForIssueMock).toHaveBeenCalledTimes(2);
  });

  it('runs as part of runPipelineSweep and reports the count', async () => {
    const result = await runPipelineSweep();
    expect(result).toHaveProperty('orphanedIssueRuns');
    expect(result.orphanedIssueRuns.reaped).toBe(0);
  });
});

describe('reapConcludedRuns wiring (ISS-923 — the inverse orphan direction)', () => {
  it('runs as part of runPipelineSweep and reports the count', async () => {
    reapConcludedRunsMock.mockResolvedValueOnce({ reaped: 3 });

    const result = await runPipelineSweep();

    expect(reapConcludedRunsMock).toHaveBeenCalledTimes(1);
    expect(result.concludedRuns.reaped).toBe(3);
  });

  it('runs AFTER reapOrphanedIssueRuns', async () => {
    const order: string[] = [];
    dbExecute.mockResolvedValue([{ id: 'run-a', issue_id: 'iss-a' }]);
    closeOpenRunForIssueMock.mockImplementation(async () => {
      order.push('orphanedIssueRuns');
      return 'settled' as const;
    });
    reapConcludedRunsMock.mockImplementation(async () => {
      order.push('concludedRuns');
      return { reaped: 0 };
    });

    await runPipelineSweep();

    expect(order.indexOf('orphanedIssueRuns')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('concludedRuns')).toBeGreaterThan(order.indexOf('orphanedIssueRuns'));
  });
});

describe('detectOrphanedRunAssertions wiring (ISS-1050 — the inverse of the run-to-issue edge)', () => {
  it('runs as part of runPipelineSweep and reports what it named', async () => {
    detectOrphanedRunAssertionsMock.mockResolvedValueOnce({ detected: 4, reported: 1 });

    const result = await runPipelineSweep();

    expect(detectOrphanedRunAssertionsMock).toHaveBeenCalledTimes(1);
    expect(result.orphanedRunAssertions).toEqual({ detected: 4, reported: 1 });
  });

  it('runs AFTER the reaping passes, not before them', async () => {
    const order: string[] = [];
    reapConcludedRunsMock.mockImplementation(async () => {
      order.push('concludedRuns');
      return { reaped: 0 };
    });
    reapJoblessRunsMock.mockImplementation(async () => {
      order.push('joblessRuns');
      return { reaped: 0 };
    });
    detectOrphanedRunAssertionsMock.mockImplementation(async () => {
      order.push('orphanedRunAssertions');
      return { detected: 0, reported: 0 };
    });

    await runPipelineSweep();

    expect(order.indexOf('orphanedRunAssertions')).toBeGreaterThan(order.indexOf('concludedRuns'));
    expect(order.indexOf('orphanedRunAssertions')).toBeGreaterThan(order.indexOf('joblessRuns'));
  });
});

describe('reapJoblessRuns wiring (ISS-654 — the job-less issue-run phantom)', () => {
  it('runs as part of runPipelineSweep and reports the count', async () => {
    reapJoblessRunsMock.mockResolvedValueOnce({ reaped: 2 });

    const result = await runPipelineSweep();

    expect(reapJoblessRunsMock).toHaveBeenCalledTimes(1);
    expect(result.joblessRuns.reaped).toBe(2);
  });

  it('runs AFTER reapConcludedRuns', async () => {
    const order: string[] = [];
    reapConcludedRunsMock.mockImplementation(async () => {
      order.push('concludedRuns');
      return { reaped: 0 };
    });
    reapJoblessRunsMock.mockImplementation(async () => {
      order.push('joblessRuns');
      return { reaped: 0 };
    });

    await runPipelineSweep();

    expect(order).toEqual(['concludedRuns', 'joblessRuns']);
  });

  it('a throw leaves the later passes running and still fails the tick', async () => {
    reapJoblessRunsMock.mockRejectedValueOnce(new Error('boom'));

    await expect(runPipelineSweep()).rejects.toThrow();
    expect(alertsMock).toHaveBeenCalled();
  });
});

describe('runPipelineSweep — queue snapshots (ISS-381 2.2)', () => {
  it('emits a grouped per-project INSERT into queue_snapshots each tick', async () => {
    const result = await runPipelineSweep();
    expect(result.queueSnapshots).toBe(0);
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

  it('runs the overdue runner-release pass and reports it', async () => {
    nameOverdueRunnerReleasesMock.mockResolvedValueOnce({ overdue: 3, named: 2 });
    const result = await runPipelineSweep();
    expect(nameOverdueRunnerReleasesMock).toHaveBeenCalledTimes(1);
    expect(result.overdueRunnerReleases).toEqual({ overdue: 3, named: 2 });
  });

  it('is best-effort — a snapshot failure never aborts the tick', async () => {
    dbExecute.mockImplementation(async (q: unknown) => {
      if (sqlText(q).includes('queue_snapshots')) throw new Error('insert boom');
      return [];
    });
    const result = await runPipelineSweep();
    expect(result.queueSnapshots).toBe(0);
    expect(result).toHaveProperty('alerts');
  });
});
