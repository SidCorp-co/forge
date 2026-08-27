/**
 * ISS-102 — unit tests for the pause/resume/cancel transition helpers.
 * Mocks drizzle and the ws roomManager so the contract under test is
 * "what does each helper write + broadcast under which preconditions?".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
// ISS-411 — parkIssueOnCancel runs `select().from(issues).innerJoin(projects)
// .where().limit(1)`, so the `from` stub must offer both the `where` (run
// lookup) and `innerJoin` (issue+owner lookup) chains.
const selectInnerJoin = vi.fn(() => ({ where: selectWhere }));
const selectFrom = vi.fn(() => ({ where: selectWhere, innerJoin: selectInnerJoin }));

vi.mock('../db/client.js', () => {
  const dbStub = {
    select: vi.fn(() => ({ from: selectFrom })),
    update: vi.fn(() => ({ set: updateSet })),
    // ISS-447 — applyKernelTransition writes the kernel_transitions audit row
    // on the same executor after the run flip.
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(dbStub)),
  };
  return { db: dbStub };
});

// ISS-411 — observe the operator-cancel → issue `on_hold` park without the
// real state-machine. parkIssueOnCancel is best-effort, so the spy resolves.
const transitionIssueStatusSpy = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../issues/apply-transition.js', () => ({
  transitionIssueStatus: (...args: unknown[]) => transitionIssueStatusSpy(...args),
}));

const publishSpy = vi.fn();
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: publishSpy },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { pausePipelineRun, resumePipelineRun, cancelPipelineRun } = await import(
  './runs-control.js'
);

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ISSUE_ID = '33333333-3333-4333-8333-333333333333';

function runRow(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    issueId: ISSUE_ID,
    kind: 'issue' as const,
    status,
    currentStep: null,
    startedAt: new Date('2026-05-12T00:00:00Z'),
    finishedAt: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateReturning.mockReset();
  selectLimit.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('pausePipelineRun', () => {
  it('flips running → paused and broadcasts pipeline_run.status_changed once', async () => {
    updateReturning.mockResolvedValueOnce([runRow('paused')]);
    const result = await pausePipelineRun(RUN_ID);
    expect(result.status).toBe('paused');
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const envelope = publishSpy.mock.calls[0]?.[1] as { event: string; data: { status: string } };
    expect(envelope.event).toBe('pipeline_run.status_changed');
    expect(envelope.data.status).toBe('paused');
  });

  it('is idempotent on already-paused (no broadcast)', async () => {
    updateReturning.mockResolvedValueOnce([]); // CAS lost
    selectLimit.mockResolvedValueOnce([runRow('paused')]);
    const result = await pausePipelineRun(RUN_ID);
    expect(result.status).toBe('paused');
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('throws CONFLICT on a terminal run', async () => {
    updateReturning.mockResolvedValueOnce([]);
    selectLimit.mockResolvedValueOnce([runRow('completed')]);
    await expect(pausePipelineRun(RUN_ID)).rejects.toThrow(/CONFLICT: run already completed/);
  });

  it('throws CONFLICT on cancelled', async () => {
    updateReturning.mockResolvedValueOnce([]);
    selectLimit.mockResolvedValueOnce([runRow('cancelled')]);
    await expect(pausePipelineRun(RUN_ID)).rejects.toThrow(/CONFLICT: run already cancelled/);
  });

  it('throws NOT_FOUND when no row exists', async () => {
    updateReturning.mockResolvedValueOnce([]);
    selectLimit.mockResolvedValueOnce([]);
    await expect(pausePipelineRun(RUN_ID)).rejects.toThrow(/NOT_FOUND/);
  });
});

describe('resumePipelineRun', () => {
  it('flips paused → running and broadcasts once', async () => {
    updateReturning.mockResolvedValueOnce([runRow('running')]);
    const result = await resumePipelineRun(RUN_ID);
    expect(result.status).toBe('running');
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it('is idempotent on already-running (no broadcast)', async () => {
    updateReturning.mockResolvedValueOnce([]);
    selectLimit.mockResolvedValueOnce([runRow('running')]);
    const result = await resumePipelineRun(RUN_ID);
    expect(result.status).toBe('running');
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('throws CONFLICT on failed', async () => {
    updateReturning.mockResolvedValueOnce([]);
    selectLimit.mockResolvedValueOnce([runRow('failed')]);
    await expect(resumePipelineRun(RUN_ID)).rejects.toThrow(/CONFLICT: run already failed/);
  });
});

describe('cancelPipelineRun', () => {
  function jobsCancelledReturning(rows: Array<Record<string, unknown>>) {
    updateReturning.mockResolvedValueOnce(rows);
  }

  it('cancels run + cascades jobs + transitions sessions + fans out job.cancel to kill the actual runner process (ISS-785)', async () => {
    updateReturning.mockResolvedValueOnce([runRow('cancelled', { finishedAt: new Date() })]);
    jobsCancelledReturning([
      { id: 'job-1', agentSessionId: 'sess-1', deviceId: 'dev-A' },
      { id: 'job-2', agentSessionId: null, deviceId: 'dev-A' },
      { id: 'job-3', agentSessionId: 'sess-2', deviceId: 'dev-B' },
    ]);
    // ISS-447 — the session cascade now also flows through applyKernelTransition,
    // which calls `.returning()`; supply the flipped session rows it audits.
    updateReturning.mockResolvedValueOnce([{ id: 'sess-1' }, { id: 'sess-2' }]);

    const result = await cancelPipelineRun(RUN_ID);

    expect(result.run.status).toBe('cancelled');
    expect(result.cancelledJobIds).toEqual(['job-1', 'job-2', 'job-3']);
    expect(result.abortedSessionIds).toEqual(['sess-1', 'sess-2']);
    expect(result.deviceIdsNotified.sort()).toEqual(['dev-A', 'dev-B']);

    const events = publishSpy.mock.calls.map((c) => (c[1] as { event: string }).event);
    expect(events.filter((e) => e === 'pipeline_run.status_changed')).toHaveLength(1);
    // cm:why job.cancel fans out ONE PER JOB (not per session) — job-1/job-2 share device dev-A but are different processes, each needs its own kill request
    expect(events.filter((e) => e === 'agent:abort')).toHaveLength(0);
    const kills = publishSpy.mock.calls.filter(
      (c) => (c[1] as { event: string }).event === 'job.cancel',
    );
    expect(kills).toHaveLength(3);
    expect(kills.map((c) => (c[1] as { data: { jobId: string } }).data.jobId).sort()).toEqual([
      'job-1',
      'job-2',
      'job-3',
    ]);
    for (const call of kills) {
      const data = (call[1] as { data: { reason: string } }).data;
      expect(data.reason).toBe('pipeline_cancelled');
    }
  });

  it('still fans out job.cancel for a job with no linked session — that class was ALWAYS a no-op abort before ISS-785, silently leaving the process alive', async () => {
    updateReturning.mockResolvedValueOnce([runRow('cancelled')]);
    jobsCancelledReturning([{ id: 'job-1', agentSessionId: null, deviceId: 'dev-X' }]);
    // No third updateReturning consumed — confirms agent_sessions update was skipped.

    const result = await cancelPipelineRun(RUN_ID);

    expect(result.cancelledJobIds).toEqual(['job-1']);
    expect(result.abortedSessionIds).toEqual([]);
    const kills = publishSpy.mock.calls.filter(
      (c) => (c[1] as { event: string }).event === 'job.cancel',
    );
    expect(kills).toHaveLength(1);
    expect((kills[0]?.[1] as { data: { jobId: string } }).data.jobId).toBe('job-1');
  });

  it('is idempotent on an already-cancelled run', async () => {
    updateReturning.mockResolvedValueOnce([]); // CAS lost
    selectLimit.mockResolvedValueOnce([runRow('cancelled')]);

    const result = await cancelPipelineRun(RUN_ID);

    expect(result.run.status).toBe('cancelled');
    expect(result.cancelledJobIds).toEqual([]);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('throws CONFLICT on a completed run', async () => {
    updateReturning.mockResolvedValueOnce([]);
    selectLimit.mockResolvedValueOnce([runRow('completed')]);
    await expect(cancelPipelineRun(RUN_ID)).rejects.toThrow(/CONFLICT: run already completed/);
  });

  it('throws NOT_FOUND for a missing run', async () => {
    updateReturning.mockResolvedValueOnce([]);
    selectLimit.mockResolvedValueOnce([]);
    await expect(cancelPipelineRun(RUN_ID)).rejects.toThrow(/NOT_FOUND/);
  });

  // ISS-411 — operator cancel must be authoritative: the linked issue is parked
  // at `on_hold` so the orchestrator does not silently re-dispatch a fresh run.
  it('parks the linked issue at on_hold after cancelling an issue-kind run', async () => {
    updateReturning.mockResolvedValueOnce([runRow('cancelled', { finishedAt: new Date() })]); // run
    updateReturning.mockResolvedValueOnce([]); // jobs cascade — no child jobs
    selectLimit.mockResolvedValueOnce([
      {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        status: 'in_progress',
        reopenCount: 0,
        createdBy: 'owner-1',
      },
    ]);

    const result = await cancelPipelineRun(RUN_ID);

    expect(result.issueParked).toBe(true);
    expect(transitionIssueStatusSpy).toHaveBeenCalledTimes(1);
    const [issueArg, toStatus, actorArg, opts] = transitionIssueStatusSpy.mock.calls[0] as [
      { id: string; status: string },
      string,
      { type: string; id: string; ownerId?: string },
      { skip?: boolean },
    ];
    expect(issueArg).toMatchObject({ id: ISSUE_ID, status: 'in_progress' });
    expect(toStatus).toBe('on_hold');
    expect(actorArg).toMatchObject({ type: 'device', id: 'owner-1', ownerId: 'owner-1' });
    expect(opts).toMatchObject({ skip: true });
  });

  // cm:guard the park must be attributed to the caller, not to `projects.createdBy` — a device actor stamps `isAi: true` and the interventions metric (VISION §1 ②) counts only user-actor transitions, so a park recorded as a device is an intervention nobody can measure
  it('attributes the park to the human who cancelled, not to the project creator', async () => {
    updateReturning.mockResolvedValueOnce([runRow('cancelled', { finishedAt: new Date() })]);
    updateReturning.mockResolvedValueOnce([]);
    selectLimit.mockResolvedValueOnce([
      {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        status: 'in_progress',
        reopenCount: 0,
        createdBy: 'owner-1',
      },
    ]);

    await cancelPipelineRun(RUN_ID, { actorUserId: 'human-7' });

    const [, , actorArg] = transitionIssueStatusSpy.mock.calls[0] as [
      unknown,
      string,
      { type: string; id: string },
    ];
    expect(actorArg).toEqual({ type: 'user', id: 'human-7' });
  });

  // cm:guard `parkIssue: false` is the "kill this run so a clean one starts" intent — leaving the issue actionable IS the point there, so this must never be "fixed" by parking anyway (the replacement run within seconds is the requested outcome, not the ISS-411 bug)
  it('leaves the issue alone when the caller asks for a clean restart', async () => {
    updateReturning.mockResolvedValueOnce([runRow('cancelled', { finishedAt: new Date() })]);
    updateReturning.mockResolvedValueOnce([]);

    const result = await cancelPipelineRun(RUN_ID, { parkIssue: false });

    expect(result.issueParked).toBe(false);
    expect(transitionIssueStatusSpy).not.toHaveBeenCalled();
  });

  it('does NOT re-park an issue already on_hold/terminal on cancel', async () => {
    updateReturning.mockResolvedValueOnce([runRow('cancelled', { finishedAt: new Date() })]);
    updateReturning.mockResolvedValueOnce([]);
    selectLimit.mockResolvedValueOnce([
      {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        status: 'closed',
        reopenCount: 0,
        createdBy: 'owner-1',
      },
    ]);

    await cancelPipelineRun(RUN_ID);

    expect(transitionIssueStatusSpy).not.toHaveBeenCalled();
  });

  it('does NOT park for a non-issue (pm/interactive/system) run', async () => {
    updateReturning.mockResolvedValueOnce([
      runRow('cancelled', { finishedAt: new Date(), kind: 'pm', issueId: null }),
    ]);
    updateReturning.mockResolvedValueOnce([]);

    await cancelPipelineRun(RUN_ID);

    expect(transitionIssueStatusSpy).not.toHaveBeenCalled();
  });
});
