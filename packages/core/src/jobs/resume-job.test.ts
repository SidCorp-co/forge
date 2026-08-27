/**
 * The resume service's refusals and its audit row, isolated from the DB.
 *
 * The interesting cases are all negative: a job that is not held, and a CAS
 * that lost. Both must leave nothing behind — no enqueue, no audit row — since
 * a resume that half-happens is a job the dispatcher has been told about twice.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateSet = vi.fn();
const selectRows = vi.fn<() => unknown[]>(() => []);
const returningRows = vi.fn<() => unknown[]>(() => [{ id: 'j1', type: 'code', issueId: 'i1' }]);
const auditInserts = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => selectRows() }) }) }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        update: () => ({
          set: (v: unknown) => {
            updateSet(v);
            return { where: () => ({ returning: async () => returningRows() }) };
          },
        }),
      }),
  },
}));

vi.mock('./intervention-event.js', () => ({
  insertInterventionEvent: (_tx: unknown, input: unknown) => {
    auditInserts(input);
    return Promise.resolve();
  },
}));

// cm:guard these six stubs exist ONLY to keep hold.ts's import chain from validating DB env at load time (the same set hold.test.ts carries, and the same reason) — do not add behaviour to them, or this suite starts testing the stubs
vi.mock('../pipeline/wedge.js', () => ({ resolvePipelineWedge: async () => 0 }));
vi.mock('./enqueue.js', () => ({
  enqueueJob: async () => undefined,
  enqueueReconcileJob: async () => undefined,
}));
vi.mock('./retry.js', () => ({ AUTO_RETRY_PAYLOAD_KEY: '_autoRetry' }));
vi.mock('./budget-check.js', () => ({ checkMonthlyBudget: async () => ({ action: 'allow' }) }));
vi.mock('../runners/select.js', () => ({ onlineCapableDeviceIds: async () => [] }));
vi.mock('./stage-overrides.js', () => ({
  resolveStageOverrides: async () => ({ deviceIds: null }),
}));

const dispatchMock = vi.fn(async (..._args: unknown[]) => undefined);
// cm:edge contract -> packages/core/src/jobs/hold.ts — `buildRequeueUpdate` is deliberately NOT stubbed: the whole point of the service is that it applies that exact patch, and a stub here would let a hand-rolled UPDATE pass this suite
vi.mock('./hold.js', async () => {
  const real = await vi.importActual<typeof import('./hold.js')>('./hold.js');
  return { ...real, dispatchRequeuedJob: (...a: unknown[]) => dispatchMock(...a) };
});

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const publishHealthMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../issues/pipeline-health.js', () => ({
  publishPipelineHealthChanged: (...a: unknown[]) => publishHealthMock(...a),
}));

const wsPublish = vi.fn();
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: (...a: unknown[]) => wsPublish(...a) },
}));
vi.mock('../ws/rooms.js', () => ({ projectRoom: (p: string) => `project:${p}` }));

const { JobResumeError, resumeHeldJob } = await import('./resume-job.js');
const { HOLD_PAYLOAD_KEY } = await import('./hold.js');

const heldJob = (over: Record<string, unknown> = {}) => ({
  id: 'j1',
  projectId: 'p1',
  issueId: 'i1',
  type: 'code',
  status: 'held',
  failureReason: 'non_retryable_terminal',
  payload: {
    [HOLD_PAYLOAD_KEY]: {
      reason: 'non_retryable_terminal',
      heldAt: '2026-08-14T06:00:00.000Z',
      autoRelease: false,
    },
  },
  ...over,
});

const opts = { actorUserId: 'u1', reason: 'workspace re-provisioned', source: 'rest' as const };

beforeEach(() => {
  vi.clearAllMocks();
  returningRows.mockReturnValue([{ id: 'j1', type: 'code', issueId: 'i1' }]);
});

describe('resumeHeldJob', () => {
  it('re-queues a held job and reports the reason it overrode', async () => {
    selectRows.mockReturnValue([heldJob()]);

    const res = await resumeHeldJob('j1', opts);

    expect(res).toEqual({ jobId: 'j1', status: 'queued', heldReason: 'non_retryable_terminal' });
    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({ status: 'queued', failureReason: null });
    expect(dispatchMock).toHaveBeenCalledWith({ id: 'j1', type: 'code', issueId: 'i1' });
  });

  // cm:guard the audit row is the ONLY record that a human overrode a condition no code would clear — a resume without it is indistinguishable from the job never having held, and VISION §1 metric ② undercounts by exactly the interventions that worked
  it('writes one audit row naming the actor, the reason and the action', async () => {
    selectRows.mockReturnValue([heldJob()]);

    await resumeHeldJob('j1', opts);

    expect(auditInserts).toHaveBeenCalledTimes(1);
    expect(auditInserts.mock.calls[0]?.[0]).toEqual({
      jobId: 'j1',
      issueId: 'i1',
      action: 'resume',
      actorUserId: 'u1',
      reason: 'workspace re-provisioned',
      source: 'rest',
      previousStatus: 'held',
    });
  });

  it('refuses a job that does not exist', async () => {
    selectRows.mockReturnValue([]);
    await expect(resumeHeldJob('nope', opts)).rejects.toThrow(JobResumeError);
    expect(updateSet).not.toHaveBeenCalled();
  });

  // cm:guard resuming a RUNNING job must fail, not no-op — the CAS below would miss and the caller would get a success for a job it never moved, which is the state-lies failure VISION principle №10 forbids
  it('refuses any status other than held, naming what it found', async () => {
    selectRows.mockReturnValue([heldJob({ status: 'running' })]);
    await expect(resumeHeldJob('j1', opts)).rejects.toThrow(/job is running, not held/);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  // cm:guard a lost CAS must NOT enqueue — two operators pressing resume, or a resume racing releaseHeldJobs, would otherwise hand the dispatcher the same job twice and the second copy runs with no slot accounting
  it('a CAS that matched nothing enqueues nothing', async () => {
    selectRows.mockReturnValue([heldJob()]);
    returningRows.mockReturnValue([]);

    await expect(resumeHeldJob('j1', opts)).rejects.toThrow(/state changed mid-request/);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(wsPublish).not.toHaveBeenCalled();
  });

  it('tells the project room so a watching UI stops showing the hold', async () => {
    selectRows.mockReturnValue([heldJob()]);

    await resumeHeldJob('j1', opts);

    expect(wsPublish).toHaveBeenCalledWith('project:p1', {
      event: 'job.resumed',
      data: { jobId: 'j1', status: 'queued' },
    });
    expect(publishHealthMock).toHaveBeenCalledWith('p1', ['i1']);
  });

  it('falls back to the column when the payload carries no hold state', async () => {
    selectRows.mockReturnValue([heldJob({ payload: {} })]);
    const res = await resumeHeldJob('j1', opts);
    expect(res.heldReason).toBe('non_retryable_terminal');
  });
});
