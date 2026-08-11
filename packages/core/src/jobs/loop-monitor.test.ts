/**
 * ISS-449 (ISS-442 C3 / I3) — closed-loop monitor coverage.
 *
 * Ports the reap contracts from the demoted sweepers (sweeper.test.ts /
 * stale-detector.test.ts kept only the alarm halves): CAS-race tolerance,
 * per-row error isolation, the ISS-321 pipeline/pm scoping + ISS-420
 * no-client predicate on the session hops, the ISS-258 result-event
 * false-positive guard, the new acked_at term on the ack hop, and the wedge
 * emission every miss-handler owes C6.
 *
 * ISS-785 — the three job-axis hops (ack / session-lost / result) are now
 * two-phase via `jobs/kill-gate.ts` (mocked here): tick 1 requests a kill and
 * leaves the job active; tick 2 either waits out the grace, or resolves
 * confirmation and finalizes exactly as the pre-ISS-785 single-phase code
 * did. `killGraceMsValue`/`resolveKillConfirmationMock` drive which branch a
 * given "already requested" candidate takes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.fn(async (..._args: unknown[]) => [] as Array<Record<string, unknown>>);
// applyKernelTransition → db.update(...).set(...).where(...).returning()
const updateReturning = vi.fn();
const sweepWhereArgs: unknown[] = [];
const sweepSetArgs: Array<Record<string, unknown>> = [];
// loop-monitor's lookupIssueForRun → db.select(...).from(...).where(...).limit(1)
const selectLimit = vi.fn(async () => [] as Array<{ issueId: string | null }>);

vi.mock('../db/client.js', () => ({
  db: {
    execute: (...args: unknown[]) => dbExecute(...(args as [])),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        sweepSetArgs.push(patch);
        return {
          where: (arg: unknown) => {
            sweepWhereArgs.push(arg);
            return { returning: () => updateReturning() };
          },
        };
      },
    }),
    insert: () => ({ values: async () => undefined }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => selectLimit() }),
      }),
    }),
  },
}));

const finalizeFailedJobMock = vi.fn(async (..._args: unknown[]) => ({ scheduled: false }));
vi.mock('./finalize-failure.js', () => ({
  finalizeFailedJob: (...args: unknown[]) => finalizeFailedJobMock(...args),
}));

const emitWedgeMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../pipeline/wedge.js', () => ({
  emitPipelineWedge: (...args: unknown[]) => emitWedgeMock(...(args as [])),
}));

const broadcastSessionEventMock = vi.fn();
vi.mock('./agent-session-link.js', () => ({
  broadcastSessionEvent: (...args: unknown[]) => broadcastSessionEventMock(...args),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// cm:why kill-gate primitives are unit-tested on their own (kill-gate.test.ts) — mocked here so loop-monitor tests stay focused on hop wiring without pulling in the real ws/server graph (env validation)
const requestJobKillMock = vi.fn(async (..._args: unknown[]) => 'requested' as const);
let resolveKillConfirmationResult: { confirmed: boolean; outcome: string | null } = {
  confirmed: false,
  outcome: null,
};
const resolveKillConfirmationMock = vi.fn(
  async (..._args: unknown[]) => resolveKillConfirmationResult,
);
let killGraceMsValue = 90_000;
vi.mock('./kill-gate.js', () => ({
  requestJobKill: (...args: unknown[]) => requestJobKillMock(...args),
  resolveKillConfirmation: (...args: unknown[]) => resolveKillConfirmationMock(...args),
  killGraceMs: () => killGraceMsValue,
  killEpisodeWindowMs: () => killGraceMsValue * 2,
  isKillEpisodeLive: (job: { killRequestedAt: Date | null }) =>
    job.killRequestedAt !== null &&
    Date.now() - job.killRequestedAt.getTime() <= killGraceMsValue * 2,
}));

const {
  runLoopMonitor,
  reapAckMisses,
  reapZombieSessions,
  reapSessionLostJobs,
  reapResultMisses,
  RESULT_QUIET_MINUTES,
} = await import('./loop-monitor.js');

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

/** A raw-execute candidate row for a job-axis hop — id + the kill-gate
 *  columns every hop now selects. */
function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    project_id: 'p1',
    issue_id: 'i1',
    device_id: 'device-1',
    runner_id: 'runner-1',
    kill_requested_at: null,
    kill_confirmed_at: null,
    kill_outcome: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbExecute.mockResolvedValue([]);
  updateReturning.mockReset();
  updateReturning.mockResolvedValue([]);
  selectLimit.mockReset();
  selectLimit.mockResolvedValue([]);
  sweepWhereArgs.length = 0;
  sweepSetArgs.length = 0;
  finalizeFailedJobMock.mockClear();
  finalizeFailedJobMock.mockResolvedValue({ scheduled: false });
  requestJobKillMock.mockClear();
  requestJobKillMock.mockResolvedValue('requested');
  resolveKillConfirmationResult = { confirmed: false, outcome: null };
  resolveKillConfirmationMock.mockClear();
  killGraceMsValue = 90_000;
});

describe('reapAckMisses — dispatch→ack hop', () => {
  it('candidate SELECT requires dispatched + acked_at IS NULL + zero events past the grace cutoff, and pulls the kill-gate columns', async () => {
    dbExecute.mockResolvedValueOnce([]);
    const result = await reapAckMisses(new Date('2026-06-12T00:00:00Z'));

    expect(result).toEqual({ reaped: 0, killRequested: 0, awaitingKill: 0 });
    const text = sqlText(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/j\.status\s*=\s*'dispatched'/);
    expect(text).toMatch(/acked_at\s+IS\s+NULL/);
    expect(text).toMatch(/dispatched_at\s+IS\s+NOT\s+NULL/);
    expect(text).toMatch(/kill_requested_at/);
    // Zero events of ANY kind — NOT scoped to result events.
    expect(text).toMatch(/NOT\s+EXISTS[\s\S]*job_events/);
    expect(text).not.toMatch(/kind\s*=\s*'result'/);
  });

  it('tick 1 (no kill requested yet): requests the kill and does NOT touch job status or wedge', async () => {
    dbExecute.mockResolvedValueOnce([candidateRow()]);

    const result = await reapAckMisses(new Date('2026-06-12T00:00:00Z'));

    expect(result).toEqual({ reaped: 0, killRequested: 1, awaitingKill: 0 });
    expect(requestJobKillMock).toHaveBeenCalledTimes(1);
    expect(updateReturning).not.toHaveBeenCalled();
    expect(finalizeFailedJobMock).not.toHaveBeenCalled();
    expect(emitWedgeMock).not.toHaveBeenCalled();
  });

  it('tick 2 within the grace: re-publishes the kill (idempotent), waits, no status change', async () => {
    dbExecute.mockResolvedValueOnce([
      candidateRow({ kill_requested_at: new Date(Date.now() - 1_000) }),
    ]);

    const result = await reapAckMisses(new Date('2026-06-12T00:00:00Z'));

    expect(result).toEqual({ reaped: 0, killRequested: 0, awaitingKill: 1 });
    expect(requestJobKillMock).toHaveBeenCalledTimes(1);
    expect(updateReturning).not.toHaveBeenCalled();
  });

  it('tick 2 past the grace: never-claimed dispatch is confirmed dead by construction (forceConfirmAfterGrace) — fails + retries without consulting resolveKillConfirmation', async () => {
    dbExecute.mockResolvedValueOnce([
      candidateRow({ kill_requested_at: new Date(Date.now() - killGraceMsValue - 1_000) }),
    ]);
    updateReturning.mockResolvedValueOnce([
      { id: 'job-1', projectId: 'p1', issueId: 'i1', status: 'failed' },
    ]);

    const result = await reapAckMisses(new Date('2026-06-12T00:00:00Z'));

    expect(result).toEqual({ reaped: 1, killRequested: 0, awaitingKill: 0 });
    expect(resolveKillConfirmationMock).not.toHaveBeenCalled();
    expect(finalizeFailedJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1' }),
      expect.objectContaining({ error: 'dispatch_unclaimed' }),
    );
    expect(finalizeFailedJobMock.mock.calls[0]?.[1]).not.toHaveProperty('precomputedRetry');
  });

  it('records the forced confirmation as never_claimed, not a not_found no runner ever sent', async () => {
    dbExecute.mockResolvedValueOnce([
      candidateRow({ kill_requested_at: new Date(Date.now() - killGraceMsValue - 1_000) }),
    ]);
    updateReturning.mockResolvedValueOnce([
      { id: 'job-1', projectId: 'p1', issueId: 'i1', status: 'failed' },
    ]);

    await reapAckMisses(new Date('2026-06-12T00:00:00Z'));

    expect(sweepSetArgs.at(-1)).toEqual(
      expect.objectContaining({ killOutcome: 'never_claimed', killConfirmedAt: expect.any(Date) }),
    );
  });

  it('skips a CAS loser (the runner acked the same instant)', async () => {
    dbExecute.mockResolvedValueOnce([
      candidateRow({ id: 'job-2', kill_requested_at: new Date(Date.now() - killGraceMsValue - 1) }),
    ]);
    updateReturning.mockResolvedValueOnce([]);

    const result = await reapAckMisses(new Date('2026-06-12T00:00:00Z'));

    expect(result).toEqual({ reaped: 0, killRequested: 0, awaitingKill: 0 });
    expect(finalizeFailedJobMock).not.toHaveBeenCalled();
    expect(emitWedgeMock).not.toHaveBeenCalled();
  });
});

describe('reapZombieSessions — claim/heartbeat hops (ISS-321 scoping preserved, unaffected by the kill gate)', () => {
  it('scopes the queue/heartbeat passes to pipeline/pm, and reaps only never-acked non-pipeline sessions (ISS-420)', async () => {
    updateReturning.mockResolvedValue([]);

    await reapZombieSessions(new Date('2026-06-05T00:00:00Z'), {});

    expect(sweepWhereArgs.length).toBe(3);
    const [pass1, pass2, pass3] = sweepWhereArgs.map(sqlText);

    expect(pass1).toMatch(/->>\s*'type'\s+IN\s*\(\s*'pipeline'\s*,\s*'pm'\s*\)/);
    expect(pass2).toMatch(/->>\s*'type'\s+IN\s*\(\s*'pipeline'\s*,\s*'pm'\s*\)/);
    expect(pass3).toMatch(/COALESCE/i);
    expect(pass3).toMatch(/NOT\s+IN\s*\(\s*'pipeline'\s*,\s*'pm'\s*\)/);
    expect(pass3).toMatch(/IS\s+NULL/i);
    expect(pass1).not.toMatch(/NOT\s+IN\s*\(\s*'pipeline'/);
    expect(pass2).not.toMatch(/NOT\s+IN\s*\(\s*'pipeline'/);
    expect(pass2).toMatch(/->\s*'escalation'\s+IS\s+NOT\s+NULL/);
    expect(pass2).toMatch(/->\s*'agentChat'\s+IS\s+NOT\s+NULL/);
    expect(pass3).toMatch(/->>\s*'acked'\s*=\s*'true'/);
    expect(pass3).toMatch(/COALESCE[\s\S]*<\s*['"]?\d{4}-\d{2}-\d{2}T/i);
  });

  it('broadcasts + emits a wedge per reaped session, resolving the issue via the run', async () => {
    updateReturning
      .mockResolvedValueOnce([
        { id: 'sess-q', projectId: 'p1', deviceId: 'd1', pipelineRunId: 'run-1' },
      ]) // queue pass
      .mockResolvedValueOnce([]) // heartbeat pass
      .mockResolvedValueOnce([]); // no-client pass
    selectLimit.mockResolvedValueOnce([{ issueId: 'i-9' }]);

    const result = await reapZombieSessions(new Date('2026-06-05T00:00:00Z'), {});

    expect(result).toEqual({ queueTimedOut: 1, heartbeatTimedOut: 0, noClientAcked: 0 });
    expect(broadcastSessionEventMock).toHaveBeenCalledWith(
      'sess-q',
      'p1',
      'd1',
      'agent-session.status',
      expect.objectContaining({ status: 'failed', failureReason: 'queue_timeout' }),
    );
    expect(emitWedgeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hop: 'claim',
        entity: 'session',
        entityId: 'sess-q',
        issueId: 'i-9',
      }),
    );
  });
});

describe('reapSessionLostJobs — heartbeat hop, job axis (was ISS-280), now kill-gated (ISS-785)', () => {
  it('candidate SELECT covers active jobs + terminal sessions, skips result-event jobs, and pulls the kill-gate columns', async () => {
    dbExecute.mockResolvedValueOnce([]);
    const result = await reapSessionLostJobs(new Date('2026-05-30T00:00:00Z'));

    expect(result).toEqual({ reaped: 0, killRequested: 0, awaitingKill: 0 });
    const text = sqlText(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/j\.status\s+IN\s*\(\s*'dispatched'\s*,\s*'running'\s*\)/);
    expect(text).toMatch(/s\.status\s+IN\s*\(\s*'failed'\s*,\s*'cancelled_stale'\s*\)/);
    expect(text).toMatch(/NOT\s+EXISTS[\s\S]*job_events[\s\S]*kind\s*=\s*'result'/);
    expect(text).toMatch(/kill_requested_at/);
  });

  it('tick 1: requests the kill instead of failing the job outright — this is the ISS-37 fix (no same-tick failure while the process may still be alive)', async () => {
    dbExecute.mockResolvedValueOnce([candidateRow({ id: 'orphan-1' })]);

    const result = await reapSessionLostJobs(new Date('2026-05-30T00:00:00Z'));

    expect(result).toEqual({ reaped: 0, killRequested: 1, awaitingKill: 0 });
    expect(requestJobKillMock).toHaveBeenCalledTimes(1);
    expect(finalizeFailedJobMock).not.toHaveBeenCalled();
  });

  it('tick 2, kill confirmed: fails the job and allows the normal retry', async () => {
    dbExecute.mockResolvedValueOnce([
      candidateRow({
        id: 'orphan-1',
        kill_requested_at: new Date(Date.now() - killGraceMsValue - 1_000),
      }),
    ]);
    resolveKillConfirmationResult = { confirmed: true, outcome: 'killed' };
    updateReturning.mockResolvedValueOnce([
      { id: 'orphan-1', projectId: 'p1', issueId: 'i1', status: 'failed', failureKind: 'infra' },
    ]);

    const result = await reapSessionLostJobs(new Date('2026-05-30T00:00:00Z'));

    expect(result).toEqual({ reaped: 1, killRequested: 0, awaitingKill: 0 });
    expect(finalizeFailedJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'orphan-1' }),
      expect.objectContaining({ error: 'session_lost' }),
    );
    expect(finalizeFailedJobMock.mock.calls[0]?.[1]).not.toHaveProperty('precomputedRetry');
    expect(emitWedgeMock).toHaveBeenCalledWith(
      expect.objectContaining({ hop: 'heartbeat', entity: 'job', entityId: 'orphan-1' }),
    );
  });

  it('tick 2, kill unconfirmed (runner online + silent): fails the job with NO retry — this is the two-agent guard', async () => {
    dbExecute.mockResolvedValueOnce([
      candidateRow({
        id: 'orphan-2',
        kill_requested_at: new Date(Date.now() - killGraceMsValue - 1_000),
      }),
    ]);
    resolveKillConfirmationResult = { confirmed: false, outcome: null };
    updateReturning.mockResolvedValueOnce([
      { id: 'orphan-2', projectId: 'p1', issueId: 'i1', status: 'failed', failureKind: 'infra' },
    ]);

    const result = await reapSessionLostJobs(new Date('2026-05-30T00:00:00Z'));

    expect(result).toEqual({ reaped: 1, killRequested: 0, awaitingKill: 0 });
    expect(finalizeFailedJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'orphan-2' }),
      expect.objectContaining({
        error: 'session_lost',
        precomputedRetry: { scheduled: false, reason: 'kill_unconfirmed' },
      }),
    );
  });

  it('the unconfirmed park gets its OWN wedge text — never the confirmed branch\'s "routed to retry"', async () => {
    dbExecute.mockResolvedValueOnce([
      candidateRow({
        id: 'orphan-2',
        kill_requested_at: new Date(Date.now() - killGraceMsValue - 1_000),
      }),
    ]);
    resolveKillConfirmationResult = { confirmed: false, outcome: null };
    updateReturning.mockResolvedValueOnce([
      { id: 'orphan-2', projectId: 'p1', issueId: 'i1', status: 'failed' },
    ]);

    await reapSessionLostJobs(new Date('2026-05-30T00:00:00Z'));

    const wedge = emitWedgeMock.mock.calls[0]?.[0] as { reason: string; action: string };
    expect(wedge.reason).toMatch(/never confirmed the kill/i);
    expect(wedge.action).toMatch(/kill any agent process still running/i);
    expect(wedge.action).toMatch(/NO retry/);
    expect(wedge.action).not.toMatch(/routed to retry/i);
  });

  it('a kill request left over from an EARLIER episode never counts as phase 1 — the job is re-killed, not failed (ISS-785 review round 2, BLOCKER A)', async () => {
    dbExecute.mockResolvedValueOnce([
      candidateRow({
        id: 'survivor-1',
        // cm:why an ack-hop episode the job then survived — the runner answered not_found about a process that had not started yet
        kill_requested_at: new Date(Date.now() - 60 * 60_000),
        kill_confirmed_at: new Date(Date.now() - 60 * 60_000 + 1_000),
        kill_outcome: 'not_found',
      }),
    ]);

    const result = await reapSessionLostJobs(new Date('2026-05-30T00:00:00Z'));

    expect(result).toEqual({ reaped: 0, killRequested: 1, awaitingKill: 0 });
    expect(requestJobKillMock).toHaveBeenCalledTimes(1);
    expect(resolveKillConfirmationMock).not.toHaveBeenCalled();
    expect(updateReturning).not.toHaveBeenCalled();
    expect(finalizeFailedJobMock).not.toHaveBeenCalled();
  });

  it('skips a job that lost the CAS race (a late /complete already finalized it)', async () => {
    dbExecute.mockResolvedValueOnce([
      candidateRow({
        id: 'orphan-3',
        kill_requested_at: new Date(Date.now() - killGraceMsValue - 1_000),
      }),
    ]);
    updateReturning.mockResolvedValueOnce([]);

    const result = await reapSessionLostJobs(new Date('2026-05-30T00:00:00Z'));

    expect(result).toEqual({ reaped: 0, killRequested: 0, awaitingKill: 0 });
    expect(finalizeFailedJobMock).not.toHaveBeenCalled();
  });

  it('does not let one row failure abort the whole pass', async () => {
    dbExecute.mockResolvedValueOnce([
      candidateRow({
        id: 'orphan-3',
        kill_requested_at: new Date(Date.now() - killGraceMsValue - 1_000),
      }),
      candidateRow({
        id: 'orphan-4',
        kill_requested_at: new Date(Date.now() - killGraceMsValue - 1_000),
      }),
    ]);
    updateReturning
      .mockResolvedValueOnce([{ id: 'orphan-3', projectId: 'p1', issueId: null }])
      .mockResolvedValueOnce([{ id: 'orphan-4', projectId: 'p1', issueId: null }]);
    finalizeFailedJobMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ scheduled: false });

    const result = await reapSessionLostJobs(new Date('2026-05-30T00:00:00Z'));

    // Both rows won their CAS so both counted; the first finalize threw but
    // was swallowed so the second still ran.
    expect(result).toEqual({ reaped: 2, killRequested: 0, awaitingKill: 0 });
    expect(finalizeFailedJobMock).toHaveBeenCalledTimes(2);
  });
});

describe('reapResultMisses — result hop (was ISS-258 runStaleSweep), now kill-gated (ISS-785)', () => {
  it('SELECT covers dispatched+running at the 60-minute threshold, keeps the result-event guard, and pulls the kill-gate columns', async () => {
    expect(RESULT_QUIET_MINUTES).toBe(60);
    dbExecute.mockResolvedValueOnce([]);
    await reapResultMisses(new Date('2026-06-12T00:00:00Z'));
    const text = sqlText(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/j\.status\s+IN\s*\(\s*'dispatched'\s*,\s*'running'\s*\)/);
    expect(text).toMatch(/interval\s+'\s*60\s*minutes'/);
    expect(text).toMatch(/COALESCE\(le\.max_ts,\s*j\.dispatched_at\)/);
    expect(text).toMatch(/NOT\s+EXISTS[\s\S]*job_events[\s\S]*kind\s*=\s*'result'/);
    expect(text).toMatch(/kill_requested_at/);
  });

  it('tick 1: requests the kill instead of failing outright', async () => {
    dbExecute.mockResolvedValueOnce([candidateRow({ id: 'stale-1' })]);

    const result = await reapResultMisses(new Date('2026-06-12T00:00:00Z'));

    expect(result).toEqual({ reaped: 0, killRequested: 1, awaitingKill: 0 });
    expect(finalizeFailedJobMock).not.toHaveBeenCalled();
  });

  it('tick 2, confirmed: fails with kind=timeout through finalizeFailedJob + result wedge, retry allowed', async () => {
    dbExecute.mockResolvedValueOnce([
      candidateRow({
        id: 'stale-1',
        kill_requested_at: new Date(Date.now() - killGraceMsValue - 1_000),
      }),
    ]);
    resolveKillConfirmationResult = { confirmed: true, outcome: 'runner_gone' };
    updateReturning.mockResolvedValueOnce([
      { id: 'stale-1', projectId: 'p1', issueId: 'i1', status: 'failed' },
    ]);

    const result = await reapResultMisses(new Date('2026-06-12T00:00:00Z'));

    expect(result).toEqual({ reaped: 1, killRequested: 0, awaitingKill: 0 });
    expect(finalizeFailedJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'stale-1' }),
      expect.objectContaining({ error: expect.stringContaining('stale') }),
    );
    expect(finalizeFailedJobMock.mock.calls[0]?.[1]).not.toHaveProperty('precomputedRetry');
    expect(emitWedgeMock).toHaveBeenCalledWith(
      expect.objectContaining({ hop: 'result', entity: 'job', entityId: 'stale-1' }),
    );
  });

  it('tick 2, unconfirmed: fails with no retry (kill_unconfirmed)', async () => {
    dbExecute.mockResolvedValueOnce([
      candidateRow({
        id: 'stale-2',
        kill_requested_at: new Date(Date.now() - killGraceMsValue - 1_000),
      }),
    ]);
    resolveKillConfirmationResult = { confirmed: false, outcome: null };
    updateReturning.mockResolvedValueOnce([
      { id: 'stale-2', projectId: 'p1', issueId: 'i1', status: 'failed' },
    ]);

    const result = await reapResultMisses(new Date('2026-06-12T00:00:00Z'));

    expect(result).toEqual({ reaped: 1, killRequested: 0, awaitingKill: 0 });
    expect(finalizeFailedJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'stale-2' }),
      expect.objectContaining({
        precomputedRetry: { scheduled: false, reason: 'kill_unconfirmed' },
      }),
    );
  });
});

describe('runLoopMonitor — one tick, hops in dependency order', () => {
  it('aggregates all hop results', async () => {
    // Every hop sees zero candidates by default.
    const result = await runLoopMonitor(new Date('2026-06-12T00:00:00Z'));
    expect(result).toEqual({
      ackMisses: { reaped: 0, killRequested: 0, awaitingKill: 0 },
      sessions: { queueTimedOut: 0, heartbeatTimedOut: 0, noClientAcked: 0 },
      sessionLostJobs: { reaped: 0, killRequested: 0, awaitingKill: 0 },
      resultMisses: { reaped: 0, killRequested: 0, awaitingKill: 0 },
    });
  });
});
