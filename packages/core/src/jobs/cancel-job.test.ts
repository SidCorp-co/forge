/**
 * ISS-808 — D3: cancelling a queued reconcile/verify_skill job must close the
 * associated reconcile_runs row via failReconcileRunForFailedJob so the
 * unique-active-per-project slot is freed immediately.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// cm:edge contract -> packages/core/src/skills/reconcile-service.ts — static import chain reaches queue/boss.ts whose top-level env import throws without DB env (BLOCKER AA)
const failReconcileRunMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../skills/reconcile-service.js', () => ({
  failReconcileRunForFailedJob: (...args: unknown[]) => failReconcileRunMock(...args),
}));

const applyTransitionMock = vi.fn(async (..._args: unknown[]) => [
  {
    id: 'j1',
    projectId: 'p1',
    issueId: 'i1',
    type: 'reconcile',
    status: 'cancelled',
    cancellationRequested: true,
    payload: { reconcileRunId: 'run-1' },
    deviceId: null,
  },
]);
vi.mock('../lifecycle/transition.js', () => ({
  applyKernelTransition: (...args: unknown[]) => applyTransitionMock(...args),
}));

function buildTx(jobType = 'reconcile') {
  const updated = {
    id: 'j1',
    projectId: 'p1',
    issueId: 'i1',
    type: jobType,
    status: 'cancelled',
    cancellationRequested: true,
    payload: { reconcileRunId: 'run-1' },
    deviceId: null,
  };
  return {
    execute: vi.fn(async () => [{ max_seq: 0 }]),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    // applyKernelTransition is mocked globally; this just provides the tx arg
    _updated: updated,
  };
}

let txMock = buildTx();

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              id: 'j1',
              projectId: 'p1',
              issueId: 'i1',
              type: 'reconcile',
              status: 'queued',
              cancellationRequested: false,
              payload: { reconcileRunId: 'run-1' },
              deviceId: null,
            },
          ],
        }),
      }),
    }),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      // applyKernelTransition mock returns the updated row; the tx itself just
      // needs execute() + insert() for insertInterventionEvent.
      return cb(txMock);
    },
  },
}));

const syncSessionMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./agent-session-link.js', () => ({
  syncAgentSessionLifecycle: (...args: unknown[]) => syncSessionMock(...args),
}));

const dispatchTickMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./dispatch-tick.js', () => ({
  dispatchTickForProject: (...args: unknown[]) => dispatchTickMock(...args),
}));

const publishHealthMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../issues/pipeline-health.js', () => ({
  publishPipelineHealthChanged: (...args: unknown[]) => publishHealthMock(...args),
}));

const wsPublishMock = vi.fn((..._args: unknown[]) => 0);
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: (...args: unknown[]) => wsPublishMock(...args) },
}));

vi.mock('../ws/rooms.js', () => ({
  projectRoom: (id: string) => `project:${id}`,
  deviceRoom: (id: string) => `device:${id}`,
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { cancelJob } = await import('./cancel-job.js');

beforeEach(() => {
  txMock = buildTx();
  vi.clearAllMocks();
  // Default: applyKernelTransition returns the updated row (as array — destructured by cancelJob)
  applyTransitionMock.mockResolvedValue([{
    id: 'j1',
    projectId: 'p1',
    issueId: 'i1',
    type: 'reconcile',
    status: 'cancelled',
    cancellationRequested: true,
    payload: { reconcileRunId: 'run-1' },
    deviceId: null,
  }]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('cancelJob — D3 reconcile orphan cleanup (ISS-808)', () => {
  it('calls failReconcileRunForFailedJob when cancelling a queued reconcile job', async () => {
    await cancelJob('j1', { actorUserId: 'u1', reason: 'manual', source: 'rest' });

    expect(failReconcileRunMock).toHaveBeenCalledTimes(1);
    expect(failReconcileRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reconcile' }),
    );
  });

  it('calls failReconcileRunForFailedJob when cancelling a queued verify_skill job', async () => {
    applyTransitionMock.mockResolvedValueOnce([{
      id: 'j1',
      projectId: 'p1',
      issueId: 'i1',
      type: 'verify_skill',
      status: 'cancelled',
      cancellationRequested: true,
      payload: { reconcileRunId: 'run-1' },
      deviceId: null,
    }]);

    await cancelJob('j1', { actorUserId: 'u1', reason: 'manual', source: 'rest' });

    expect(failReconcileRunMock).toHaveBeenCalledTimes(1);
    expect(failReconcileRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'verify_skill' }),
    );
  });

  it('still calls failReconcileRunForFailedJob for pipeline jobs (it is a no-op inside the helper)', async () => {
    // The gate is inside failReconcileRunForFailedJob, not in cancelJob itself.
    // cancelJob always calls it; the helper skips non-reconcile job types safely.
    applyTransitionMock.mockResolvedValueOnce([{
      id: 'j1',
      projectId: 'p1',
      issueId: 'i1',
      type: 'code',
      status: 'cancelled',
      cancellationRequested: true,
      payload: {},
      deviceId: null,
    }]);

    await cancelJob('j1', { actorUserId: 'u1', reason: 'manual', source: 'rest' });

    // The call always happens; failReconcileRunForFailedJob.type guard handles it.
    expect(failReconcileRunMock).toHaveBeenCalledTimes(1);
    expect(failReconcileRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'code' }),
    );
  });

  it('swallows errors from failReconcileRunForFailedJob so cancel still succeeds', async () => {
    failReconcileRunMock.mockRejectedValueOnce(new Error('DB down'));

    const result = await cancelJob('j1', { actorUserId: 'u1', reason: 'manual', source: 'rest' });

    expect(result.status).toBe('cancelled');
  });

  it('returns the cancelled job status', async () => {
    const result = await cancelJob('j1', { actorUserId: 'u1', reason: 'manual', source: 'rest' });

    expect(result.jobId).toBe('j1');
    expect(result.status).toBe('cancelled');
    expect(result.cancellationRequested).toBe(true);
  });
});
