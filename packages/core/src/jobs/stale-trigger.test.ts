/**
 * ISS-789 — `discardStaleTriggerJobs`. The gate in dispatch-gates.ts decides
 * WHICH jobs are stale (covered there); this file covers what happens to them:
 * a CAS-guarded terminal flip through the kernel, and nothing at all for a job
 * the gate reported under any other reason.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (...args: unknown[]) => ({ _eq: args }),
  inArray: (...args: unknown[]) => ({ _inArray: args }),
}));

vi.mock('../db/schema.js', () => ({ jobs: { id: 'jobs.id', status: 'jobs.status' } }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../ws/rooms.js', () => ({ projectRoom: (id: string) => `project:${id}` }));

const publishMock = vi.fn();
vi.mock('../ws/server.js', () => ({ roomManager: { publish: publishMock } }));

const syncAgentSessionLifecycleMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./agent-session-link.js', () => ({
  syncAgentSessionLifecycle: (...args: unknown[]) => syncAgentSessionLifecycleMock(...args),
}));

const gateReasonsMock = vi.fn(async (_projectId: string) => new Map<string, string>());
const assertDispatchableMock = vi.fn(async (_jobId: string) => ({
  ok: false as const,
  reason: 'stale_trigger' as const,
}));
vi.mock('./dispatch-gates.js', () => ({
  gateReasonsForQueuedJobs: (projectId: string) => gateReasonsMock(projectId),
  assertDispatchable: (jobId: string) => assertDispatchableMock(jobId),
}));

const applyKernelTransitionMock = vi.fn();
vi.mock('../lifecycle/transition.js', () => ({
  applyKernelTransition: (...args: unknown[]) => applyKernelTransitionMock(...args),
}));

let queuedRows: Record<string, unknown>[] = [];
const whereSpy = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (predicate: unknown) => {
          whereSpy(predicate);
          return Promise.resolve(queuedRows);
        },
      }),
    }),
  },
}));

const { discardStaleTriggerJobs, STALE_TRIGGER_REASON } = await import('./stale-trigger.js');

const PROJECT_ID = 'proj-1';

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-stale',
    projectId: PROJECT_ID,
    issueId: 'iss-1',
    type: 'fix',
    status: 'queued',
    agentSessionId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queuedRows = [];
  gateReasonsMock.mockResolvedValue(new Map());
  assertDispatchableMock.mockResolvedValue({ ok: false, reason: 'stale_trigger' });
  applyKernelTransitionMock.mockImplementation(async () => [jobRow({ status: 'cancelled' })]);
});

describe('discardStaleTriggerJobs', () => {
  it('reads nothing and writes nothing when no job is gated', async () => {
    expect(await discardStaleTriggerJobs(PROJECT_ID)).toEqual([]);
    expect(whereSpy).not.toHaveBeenCalled();
    expect(applyKernelTransitionMock).not.toHaveBeenCalled();
  });

  // cm:guard the discard must key on `stale_trigger` ALONE — `gateReasonsForQueuedJobs` returns the most specific gate, so every other reason means the job is waiting for something that can still arrive, and cancelling one of those destroys work the queue was going to run
  it('leaves a job the gate reported under any other reason alone', async () => {
    gateReasonsMock.mockResolvedValue(
      new Map([
        ['job-busy', 'issue_busy'],
        ['job-dep', 'blocked_by'],
        ['job-pool', 'runner_stale'],
      ]),
    );
    expect(await discardStaleTriggerJobs(PROJECT_ID)).toEqual([]);
    expect(applyKernelTransitionMock).not.toHaveBeenCalled();
  });

  it('cancels a stale job as permanent, naming the cause, guarded on still being queued', async () => {
    gateReasonsMock.mockResolvedValue(new Map([['job-stale', 'stale_trigger']]));
    queuedRows = [jobRow()];

    expect(await discardStaleTriggerJobs(PROJECT_ID)).toEqual(['job-stale']);

    expect(applyKernelTransitionMock).toHaveBeenCalledTimes(1);
    const args = applyKernelTransitionMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.entity).toBe('job');
    expect(args.to).toBe('cancelled');
    expect(args.fromStatus).toBe('queued');
    expect(args.reason).toBe(STALE_TRIGGER_REASON);
    expect(args.source).toBe('stale-trigger');
    expect(args.actor).toEqual({ type: 'system' });
    // cm:guard `terminal` action and NO failureKind — every kind in the taxonomy (code/infra/transient-cc/timeout) blames something for a job that simply answers a question nobody is asking any more, and a retryable kind would feed the discard back to the retry engine
    const set = args.set as Record<string, unknown>;
    expect(set.failureAction).toBe('terminal');
    expect(set.failureKind).toBeUndefined();
    expect(set.failureReason).toBe(STALE_TRIGGER_REASON);
    expect(set.finishedAt).toBeInstanceOf(Date);
    // cm:why the status guard, not just the id — the sweep runs concurrently with the dispatcher, so an id-only predicate would cancel a job that went `dispatched` between the gate read and this write
    expect(JSON.stringify(args.where)).toContain('jobs.status');
  });

  it('closes the linked session and announces the cancel so no UI shows it queued', async () => {
    gateReasonsMock.mockResolvedValue(new Map([['job-stale', 'stale_trigger']]));
    queuedRows = [jobRow()];

    await discardStaleTriggerJobs(PROJECT_ID);

    expect(syncAgentSessionLifecycleMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-stale' }),
      'cancelled',
    );
    expect(publishMock).toHaveBeenCalledWith(`project:${PROJECT_ID}`, {
      event: 'job.cancelled',
      data: { jobId: 'job-stale', status: 'cancelled', reason: STALE_TRIGGER_REASON },
    });
  });

  // cm:guard a lost CAS must not be reported as discarded and must not broadcast — the tick runs concurrently with the dispatcher, so the row can go `dispatched` between the gate read and the write, and announcing a cancel for a job that is now running is the state-never-lies violation this whole issue is about
  it('reports nothing when the CAS loses the race to a concurrent dispatch', async () => {
    gateReasonsMock.mockResolvedValue(new Map([['job-stale', 'stale_trigger']]));
    queuedRows = [jobRow()];
    applyKernelTransitionMock.mockImplementation(async () => []);

    expect(await discardStaleTriggerJobs(PROJECT_ID)).toEqual([]);
    expect(syncAgentSessionLifecycleMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('discards every stale job in the sweep, not just the first', async () => {
    gateReasonsMock.mockResolvedValue(
      new Map([
        ['job-a', 'stale_trigger'],
        ['job-keep', 'project_cap'],
        ['job-b', 'stale_trigger'],
      ]),
    );
    queuedRows = [jobRow({ id: 'job-a' }), jobRow({ id: 'job-b' })];
    applyKernelTransitionMock.mockImplementation(
      async (_db: unknown, args: { where: unknown; set: unknown }) => {
        const id = JSON.stringify(args.where).includes('job-a') ? 'job-a' : 'job-b';
        return [jobRow({ id, status: 'cancelled' })];
      },
    );

    expect(await discardStaleTriggerJobs(PROJECT_ID)).toEqual(['job-a', 'job-b']);
  });

  // cm:guard the re-check must go through `assertDispatchable`, not a local copy of the staleness test — the batch gate read and the write are separate statements, so a human moving the issue back onto this job's trigger in between must leave the job alone, and routing through the asserter is what stops the re-check drifting from the gate
  it.each([
    ['the job became dispatchable again', { ok: true } as const],
    ['another gate now holds it', { ok: false, reason: 'issue_busy' } as const],
  ])('writes nothing when the re-check says %s', async (_label, verdict) => {
    gateReasonsMock.mockResolvedValue(new Map([['job-stale', 'stale_trigger']]));
    queuedRows = [jobRow()];
    assertDispatchableMock.mockResolvedValue(verdict as never);

    expect(await discardStaleTriggerJobs(PROJECT_ID)).toEqual([]);
    expect(applyKernelTransitionMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('re-checks each candidate by id before writing', async () => {
    gateReasonsMock.mockResolvedValue(new Map([['job-stale', 'stale_trigger']]));
    queuedRows = [jobRow()];

    await discardStaleTriggerJobs(PROJECT_ID);

    expect(assertDispatchableMock).toHaveBeenCalledWith('job-stale');
  });

  it('keeps sweeping when closing the linked session throws', async () => {
    gateReasonsMock.mockResolvedValue(new Map([['job-stale', 'stale_trigger']]));
    queuedRows = [jobRow()];
    syncAgentSessionLifecycleMock.mockRejectedValueOnce(new Error('session gone'));

    expect(await discardStaleTriggerJobs(PROJECT_ID)).toEqual(['job-stale']);
    expect(publishMock).toHaveBeenCalled();
  });
});
