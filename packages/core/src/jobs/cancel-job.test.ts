/**
 * ISS-808 — cancelling a `queued` job must close its orphaned reconcile run.
 *
 * `failReconcileRunForFailedJob` internally no-ops for non-reconcile job
 * types (see reconcile-service.ts), so these tests pin cancel-job.ts's half
 * of the contract only: the queued→cancelled path always invokes the hook,
 * and a hook rejection never breaks the cancel itself.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (...args: unknown[]) => ({ _eq: args }),
  sql: (strings: unknown, ...values: unknown[]) => ({ strings, values }),
}));

vi.mock('../db/schema.js', () => ({
  jobEvents: 'job_events-table',
  jobs: 'jobs-table',
}));

vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('../ws/rooms.js', () => ({
  deviceRoom: (id: string) => `device:${id}`,
  projectRoom: (id: string) => `project:${id}`,
}));
vi.mock('../ws/server.js', () => ({ roomManager: { publish: vi.fn() } }));
vi.mock('./dispatch-tick.js', () => ({ dispatchTickForProject: vi.fn() }));
vi.mock('../issues/pipeline-health.js', () => ({ publishPipelineHealthChanged: vi.fn() }));

const syncAgentSessionLifecycleMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./agent-session-link.js', () => ({
  syncAgentSessionLifecycle: (...args: unknown[]) => syncAgentSessionLifecycleMock(...args),
}));

const failReconcileRunForFailedJobMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../skills/reconcile-service.js', () => ({
  failReconcileRunForFailedJob: (...args: unknown[]) => failReconcileRunForFailedJobMock(...args),
}));

const applyKernelTransitionMock = vi.fn();
vi.mock('../lifecycle/transition.js', () => ({
  applyKernelTransition: (...args: unknown[]) => applyKernelTransitionMock(...args),
}));

let queuedJobRow: Record<string, unknown> | undefined;
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (queuedJobRow ? [queuedJobRow] : []),
        }),
      }),
    }),
    transaction: async (cb: (tx: unknown) => unknown) =>
      cb({
        execute: async () => [{ max_seq: 0 }],
        insert: () => ({ values: async () => undefined }),
      }),
  },
}));

const { cancelJob } = await import('./cancel-job.js');

function updatedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    projectId: 'proj-1',
    issueId: null,
    deviceId: null,
    type: 'reconcile',
    payload: { reconcileRunId: 'run-1' },
    status: 'cancelled',
    cancellationRequested: true,
    agentSessionId: null,
    ...overrides,
  };
}

describe('cancelJob — queued path closes orphaned reconcile runs (ISS-808)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queuedJobRow = { id: 'job-1', status: 'queued', issueId: null };
  });

  it('invokes failReconcileRunForFailedJob with the updated job for a queued reconcile job', async () => {
    applyKernelTransitionMock.mockResolvedValueOnce([updatedRow()]);

    await cancelJob('job-1', { actorUserId: 'u1', reason: 'stuck', source: 'rest' });

    expect(failReconcileRunForFailedJobMock).toHaveBeenCalledTimes(1);
    expect(failReconcileRunForFailedJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reconcile', payload: { reconcileRunId: 'run-1' } }),
    );
  });

  it('still cancels a non-reconcile queued job (no regression)', async () => {
    applyKernelTransitionMock.mockResolvedValueOnce([updatedRow({ type: 'code', payload: {} })]);

    const result = await cancelJob('job-1', { actorUserId: 'u1', reason: 'stuck', source: 'rest' });

    expect(result.status).toBe('cancelled');
    expect(failReconcileRunForFailedJobMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a hook rejection break the cancel', async () => {
    applyKernelTransitionMock.mockResolvedValueOnce([updatedRow()]);
    failReconcileRunForFailedJobMock.mockRejectedValueOnce(new Error('run already terminal'));

    const result = await cancelJob('job-1', { actorUserId: 'u1', reason: 'stuck', source: 'rest' });

    expect(result.status).toBe('cancelled');
  });
});
