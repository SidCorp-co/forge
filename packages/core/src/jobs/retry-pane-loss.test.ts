// ISS-1415 c3: a job whose box reports "the job's pane … ended without reporting an outcome" several
// times in a row is placed again no sooner than a growing interval, and not at all past the cap.
// forge's release run 6c42685e went out 7 times in 12 minutes on 2026-11-22, one retry every 2
// minutes, each failed the same way; the pool's retry is the place a release attempt is re-placed.
//
// @direct-test-of packages/core/src/jobs/retry.ts
// @direct-test-of packages/core/src/jobs/pane-loss.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

const inserted = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('../db/client.js', () => {
  const chain = {
    from: () => chain,
    where: async () => [],
  };
  const tx = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { returning: async () => [{ id: `retry-${inserted.length}` }] };
      },
    }),
  };
  return {
    db: {
      select: () => chain,
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});
vi.mock('../pipeline/index.js', async () => {
  const classifier = await import('../pipeline/failure-classifier.js');
  return {
    classifyFailure: classifier.classifyFailure,
    deriveActionFromKind: classifier.deriveActionFromKind,
    assertRunAcceptsWork: async () => undefined,
    capacityWedgeEntityId: () => 'capacity',
    emitPipelineWedge: async () => undefined,
    releaseRunParked: async () => null,
    resolvePipelineWedge: async () => undefined,
    verifyRecovery: async () => 'pending',
  };
});
vi.mock('../runners/index.js', () => ({ onlineCapableDeviceIds: async () => ['box-1'] }));
vi.mock('../agent-sessions/index.js', () => ({
  incrementAutoRetryCount: async () => undefined,
  incrementRecoveryStats: async () => undefined,
  markSessionTerminal: async () => undefined,
  publishSessionRecoveryChanged: async () => undefined,
}));
vi.mock('./hold.js', () => ({ RUN_CLOSED: 'run_not_accepting_work' }));

const { scheduleAutoRetryWithVerify } = await import('./retry.js');

type Job = Parameters<typeof scheduleAutoRetryWithVerify>[0];

const PANE_ENDED = (id: string) =>
  `the job's pane \`forge-job-${id}\` ended without reporting an outcome`;

function releaseJob(over: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    projectId: 'p-1',
    issueId: null,
    pipelineRunId: 'run-1',
    createdBy: 'u-1',
    type: 'release_batch',
    payload: { promptString: 'release it' },
    modelTier: null,
    status: 'failed',
    attempts: 1,
    retryOf: null,
    cancellationRequested: false,
    agentSessionId: null,
    runnerId: null,
    failureKind: 'infra',
    failureAction: 'retry',
    failureReason: PANE_ENDED('job-1'),
    failureMeta: null,
    error: PANE_ENDED('job-1'),
    ...over,
  } as Job;
}

/** The job the last retry inserted, failed the way `error` says. */
function failedRetry(n: number, error: string): Job {
  const v = lastRetry();
  return releaseJob({
    id: `retry-${n}`,
    attempts: v.attempts as number,
    payload: v.payload as Job['payload'],
    retryOf: v.retryOf as string,
    error,
    failureReason: error,
  });
}

/** The newest retry inserted. */
function lastRetry(): Record<string, unknown> {
  const v = inserted.at(-1);
  if (!v) throw new Error('no retry was inserted');
  return v;
}

/** How long after the call the inserted retry may first be placed. */
const waitOf = (before: number) => (lastRetry().retryAfterAt as Date).getTime() - before;

/** The pane losses the newest retry carries. */
const carriedLosses = () =>
  (lastRetry().payload as Record<string, { paneLosses?: number }>)._autoRetry?.paneLosses ?? 0;

beforeEach(() => {
  inserted.length = 0;
});

describe('a job whose pane the box keeps losing is re-placed after a growing wait, then not at all (ISS-1415)', () => {
  it('waits at least 2, 4 and 8 minutes after the first three losses, and places no fourth', async () => {
    let job = releaseJob();
    const waits: number[] = [];
    for (let n = 1; n <= 3; n += 1) {
      const before = Date.now();
      const out = await scheduleAutoRetryWithVerify(job, job.error ?? '');
      expect(out.scheduled, `loss ${n} was not retried at all`).toBe(true);
      waits.push(waitOf(before));
      job = failedRetry(n, PANE_ENDED(`retry-${n}`));
    }
    expect(waits[0]).toBeGreaterThanOrEqual(2 * 60_000);
    expect(waits[1]).toBeGreaterThanOrEqual(4 * 60_000);
    expect(waits[2]).toBeGreaterThanOrEqual(8 * 60_000);
    const fourth = await scheduleAutoRetryWithVerify(job, job.error ?? '');
    expect(fourth).toEqual({ scheduled: false, reason: 'pane_lost_repeatedly' });
    expect(inserted).toHaveLength(3);
  });

  it('carries the count on the retry, where its next placement time is read', async () => {
    const before = Date.now();
    await scheduleAutoRetryWithVerify(releaseJob(), PANE_ENDED('job-1'));
    expect(carriedLosses()).toBe(1);
    expect(lastRetry().attempts).toBe(2);
    expect(waitOf(before)).toBeLessThan(3 * 60_000);
  });

  it('counts a pane the box did not keep over a daemon restart as the same loss', async () => {
    const restart = "the job's pane `forge-job-x` did not survive a restart of the runner daemon";
    const before = Date.now();
    await scheduleAutoRetryWithVerify(releaseJob({ error: restart }), restart);
    expect(waitOf(before)).toBeGreaterThanOrEqual(2 * 60_000);
  });

  it('starts the count again after a failure of another kind: the losses must be in a row', async () => {
    let job = releaseJob();
    for (let n = 1; n <= 2; n += 1) {
      await scheduleAutoRetryWithVerify(job, job.error ?? '');
      job = failedRetry(n, PANE_ENDED(`retry-${n}`));
    }
    // the third job fails on a provider blip instead: the uniform cooldown, and no count carried
    job = { ...job, error: 'stream error: 529 overloaded', failureReason: 'overloaded' };
    const before = Date.now();
    await scheduleAutoRetryWithVerify(job, job.error ?? '');
    expect(waitOf(before)).toBeLessThan(2 * 60_000);
    expect(carriedLosses()).toBe(0);
    // and a loss after it is the first again
    job = failedRetry(3, PANE_ENDED('retry-3'));
    const after = Date.now();
    await scheduleAutoRetryWithVerify(job, job.error ?? '');
    expect(waitOf(after)).toBeGreaterThanOrEqual(2 * 60_000);
    expect(waitOf(after)).toBeLessThan(3 * 60_000);
  });

  it('keeps the uniform cooldown for a failure that is no pane loss', async () => {
    const before = Date.now();
    const out = await scheduleAutoRetryWithVerify(
      releaseJob({ error: 'stream error: 529 overloaded' }),
      'overloaded',
    );
    expect(out.scheduled).toBe(true);
    expect(waitOf(before)).toBeLessThanOrEqual(61_000);
  });
});
