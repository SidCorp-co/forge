/**
 * ISS-449 (ISS-442 C3 / I3) — closed-loop monitor coverage.
 *
 * Ports the reap contracts from the demoted sweepers (sweeper.test.ts /
 * stale-detector.test.ts kept only the alarm halves): CAS-race tolerance,
 * per-row error isolation, the ISS-321 pipeline/pm scoping + ISS-420
 * no-client predicate on the session hops, the ISS-258 result-event
 * false-positive guard, the new acked_at term on the ack hop, and the wedge
 * emission every miss-handler owes C6.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.fn(async (..._args: unknown[]) => [] as Array<Record<string, unknown>>);
// applyKernelTransition → db.update(...).set(...).where(...).returning()
const updateReturning = vi.fn();
const sweepWhereArgs: unknown[] = [];
// loop-monitor's lookupIssueForRun → db.select(...).from(...).where(...).limit(1)
const selectLimit = vi.fn(async () => [] as Array<{ issueId: string | null }>);

vi.mock('../db/client.js', () => ({
  db: {
    execute: (...args: unknown[]) => dbExecute(...(args as [])),
    update: () => ({
      set: () => ({
        where: (arg: unknown) => {
          sweepWhereArgs.push(arg);
          return { returning: () => updateReturning() };
        },
      }),
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

beforeEach(() => {
  vi.clearAllMocks();
  dbExecute.mockResolvedValue([]);
  updateReturning.mockReset();
  updateReturning.mockResolvedValue([]);
  selectLimit.mockReset();
  selectLimit.mockResolvedValue([]);
  sweepWhereArgs.length = 0;
  finalizeFailedJobMock.mockClear();
  finalizeFailedJobMock.mockResolvedValue({ scheduled: false });
});

describe('reapAckMisses — dispatch→ack hop', () => {
  it('candidate SELECT requires dispatched + acked_at IS NULL + zero events past the grace cutoff', async () => {
    dbExecute.mockResolvedValueOnce([]);
    const reaped = await reapAckMisses(new Date('2026-06-12T00:00:00Z'));

    expect(reaped).toBe(0);
    const text = sqlText(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/j\.status\s*=\s*'dispatched'/);
    expect(text).toMatch(/acked_at\s+IS\s+NULL/);
    expect(text).toMatch(/dispatched_at\s+IS\s+NOT\s+NULL/);
    // Zero events of ANY kind — NOT scoped to result events.
    expect(text).toMatch(/NOT\s+EXISTS[\s\S]*job_events/);
    expect(text).not.toMatch(/kind\s*=\s*'result'/);
  });

  it('reaps a miss through finalizeFailedJob with kind=infra and emits an ack wedge', async () => {
    dbExecute.mockResolvedValueOnce([{ id: 'unclaimed-1' }]);
    updateReturning.mockResolvedValueOnce([
      { id: 'unclaimed-1', projectId: 'p1', issueId: 'i1', status: 'failed' },
    ]);

    const reaped = await reapAckMisses(new Date('2026-06-12T00:00:00Z'));

    expect(reaped).toBe(1);
    expect(finalizeFailedJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'unclaimed-1' }),
      expect.objectContaining({ error: 'dispatch_unclaimed' }),
    );
    expect(emitWedgeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hop: 'ack',
        entity: 'job',
        entityId: 'unclaimed-1',
        issueId: 'i1',
      }),
    );
  });

  it('skips a CAS loser (the runner acked the same instant)', async () => {
    dbExecute.mockResolvedValueOnce([{ id: 'unclaimed-2' }]);
    updateReturning.mockResolvedValueOnce([]);

    const reaped = await reapAckMisses(new Date('2026-06-12T00:00:00Z'));

    expect(reaped).toBe(0);
    expect(finalizeFailedJobMock).not.toHaveBeenCalled();
    expect(emitWedgeMock).not.toHaveBeenCalled();
  });
});

describe('reapZombieSessions — claim/heartbeat hops (ISS-321 scoping preserved)', () => {
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
    // ISS-675 review fix: the heartbeat pass ALSO matches an escalation
    // session (metadata.escalation set, no metadata.type) so an
    // attached-then-hung runner (claudeSessionId already set, so the
    // no-client pass below can never claim it) still gets reaped instead of
    // running forever.
    expect(pass2).toMatch(/->\s*'escalation'\s+IS\s+NOT\s+NULL/);
    // ISS-727 review fix: the heartbeat pass ALSO matches an agent-chat
    // session (metadata.agentChat set, no metadata.type) for the same reason
    // escalation needed the clause above — an attached-then-hung runner
    // would otherwise never reap, wedging the room's dedup forever.
    expect(pass2).toMatch(/->\s*'agentChat'\s+IS\s+NOT\s+NULL/);
    // ISS-584 (C): the no-client pass carries the fast-ack branch — acked=true
    // session whose claudeSessionId never landed within the short grace.
    expect(pass3).toMatch(/->>\s*'acked'\s*=\s*'true'/);
    // FORGE-CORE-K regression: the fast-ack COALESCE comparison binds its cutoff
    // as an ISO STRING (`< ${ackFastCutoffIso}`), not a raw Date. The left
    // operand is a raw `sql` template, so drizzle has no column type to
    // serialise a Date against and postgres-js threw on bind, aborting the loop
    // monitor (the sweep's first pass). The literal surfaces in the SQL text.
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

  it('ISS-675: reaps an attached-then-hung escalation session via the heartbeat pass (no metadata.type, claudeSessionId already set)', async () => {
    updateReturning
      .mockResolvedValueOnce([]) // queue pass
      .mockResolvedValueOnce([
        { id: 'sess-esc', projectId: 'p1', deviceId: 'd1', pipelineRunId: 'run-esc' },
      ]) // heartbeat pass reaps the escalation session
      .mockResolvedValueOnce([]); // no-client pass never sees it (claudeSessionId set)
    selectLimit.mockResolvedValueOnce([{ issueId: null }]);

    const result = await reapZombieSessions(new Date('2026-06-05T00:00:00Z'), {});

    expect(result).toEqual({ queueTimedOut: 0, heartbeatTimedOut: 1, noClientAcked: 0 });
    expect(broadcastSessionEventMock).toHaveBeenCalledWith(
      'sess-esc',
      'p1',
      'd1',
      'agent-session.status',
      expect.objectContaining({ status: 'failed', failureReason: 'heartbeat_timeout' }),
    );
    expect(emitWedgeMock).toHaveBeenCalledWith(
      expect.objectContaining({ hop: 'heartbeat', entity: 'session', entityId: 'sess-esc' }),
    );
  });

  it('ISS-727: reaps an attached-then-hung agent-chat session via the heartbeat pass (no metadata.type, claudeSessionId already set)', async () => {
    updateReturning
      .mockResolvedValueOnce([]) // queue pass
      .mockResolvedValueOnce([
        { id: 'sess-chat', projectId: 'p1', deviceId: 'd1', pipelineRunId: 'run-chat' },
      ]) // heartbeat pass reaps the agent-chat session
      .mockResolvedValueOnce([]); // no-client pass never sees it (claudeSessionId set)
    selectLimit.mockResolvedValueOnce([{ issueId: null }]);

    const result = await reapZombieSessions(new Date('2026-06-05T00:00:00Z'), {});

    expect(result).toEqual({ queueTimedOut: 0, heartbeatTimedOut: 1, noClientAcked: 0 });
    expect(broadcastSessionEventMock).toHaveBeenCalledWith(
      'sess-chat',
      'p1',
      'd1',
      'agent-session.status',
      expect.objectContaining({ status: 'failed', failureReason: 'heartbeat_timeout' }),
    );
    expect(emitWedgeMock).toHaveBeenCalledWith(
      expect.objectContaining({ hop: 'heartbeat', entity: 'session', entityId: 'sess-chat' }),
    );
  });
});

describe('reapSessionLostJobs — heartbeat hop, job axis (was ISS-280)', () => {
  it('candidate SELECT covers active jobs + terminal sessions and skips result-event jobs', async () => {
    dbExecute.mockResolvedValueOnce([]);
    const reaped = await reapSessionLostJobs(new Date('2026-05-30T00:00:00Z'));

    expect(reaped).toBe(0);
    const text = sqlText(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/j\.status\s+IN\s*\(\s*'dispatched'\s*,\s*'running'\s*\)/);
    expect(text).toMatch(/s\.status\s+IN\s*\(\s*'failed'\s*,\s*'cancelled_stale'\s*\)/);
    expect(text).toMatch(/NOT\s+EXISTS[\s\S]*job_events[\s\S]*kind\s*=\s*'result'/);
  });

  it('reaps an orphan through finalizeFailedJob with the session_lost error', async () => {
    dbExecute.mockResolvedValueOnce([{ id: 'orphan-1' }]);
    updateReturning.mockResolvedValueOnce([
      { id: 'orphan-1', projectId: 'p1', issueId: 'i1', status: 'failed', failureKind: 'infra' },
    ]);

    const reaped = await reapSessionLostJobs(new Date('2026-05-30T00:00:00Z'));

    expect(reaped).toBe(1);
    expect(finalizeFailedJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'orphan-1' }),
      expect.objectContaining({ error: 'session_lost' }),
    );
    expect(emitWedgeMock).toHaveBeenCalledWith(
      expect.objectContaining({ hop: 'heartbeat', entity: 'job', entityId: 'orphan-1' }),
    );
  });

  it('skips a job that lost the CAS race (a late /complete already finalized it)', async () => {
    dbExecute.mockResolvedValueOnce([{ id: 'orphan-2' }]);
    updateReturning.mockResolvedValueOnce([]);

    const reaped = await reapSessionLostJobs(new Date('2026-05-30T00:00:00Z'));

    expect(reaped).toBe(0);
    expect(finalizeFailedJobMock).not.toHaveBeenCalled();
  });

  it('does not let one row failure abort the whole pass', async () => {
    dbExecute.mockResolvedValueOnce([{ id: 'orphan-3' }, { id: 'orphan-4' }]);
    updateReturning
      .mockResolvedValueOnce([{ id: 'orphan-3', projectId: 'p1', issueId: null }])
      .mockResolvedValueOnce([{ id: 'orphan-4', projectId: 'p1', issueId: null }]);
    finalizeFailedJobMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ scheduled: false });

    const reaped = await reapSessionLostJobs(new Date('2026-05-30T00:00:00Z'));

    // Both rows won their CAS so both counted; the first finalize threw but
    // was swallowed so the second still ran.
    expect(reaped).toBe(2);
    expect(finalizeFailedJobMock).toHaveBeenCalledTimes(2);
  });
});

describe('reapResultMisses — result hop (was ISS-258 runStaleSweep)', () => {
  it('SELECT covers dispatched+running at the 60-minute threshold and keeps the result-event guard', async () => {
    expect(RESULT_QUIET_MINUTES).toBe(60);
    dbExecute.mockResolvedValueOnce([]);
    await reapResultMisses(new Date('2026-06-12T00:00:00Z'));
    const text = sqlText(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/j\.status\s+IN\s*\(\s*'dispatched'\s*,\s*'running'\s*\)/);
    expect(text).toMatch(/interval\s+'\s*60\s*minutes'/);
    expect(text).toMatch(/COALESCE\(le\.max_ts,\s*j\.dispatched_at\)/);
    expect(text).toMatch(/NOT\s+EXISTS[\s\S]*job_events[\s\S]*kind\s*=\s*'result'/);
  });

  it('reaps a quiet job with kind=timeout through finalizeFailedJob + result wedge', async () => {
    dbExecute.mockResolvedValueOnce([{ id: 'stale-1' }]);
    updateReturning.mockResolvedValueOnce([
      { id: 'stale-1', projectId: 'p1', issueId: 'i1', status: 'failed' },
    ]);

    const reaped = await reapResultMisses(new Date('2026-06-12T00:00:00Z'));

    expect(reaped).toBe(1);
    expect(finalizeFailedJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'stale-1' }),
      expect.objectContaining({ error: expect.stringContaining('stale') }),
    );
    expect(emitWedgeMock).toHaveBeenCalledWith(
      expect.objectContaining({ hop: 'result', entity: 'job', entityId: 'stale-1' }),
    );
  });
});

describe('runLoopMonitor — one tick, hops in dependency order', () => {
  it('aggregates all hop results', async () => {
    // Every hop sees zero candidates by default.
    const result = await runLoopMonitor(new Date('2026-06-12T00:00:00Z'));
    expect(result).toEqual({
      ackMisses: 0,
      sessions: { queueTimedOut: 0, heartbeatTimedOut: 0, noClientAcked: 0 },
      sessionLostJobs: 0,
      resultMisses: 0,
    });
  });
});
