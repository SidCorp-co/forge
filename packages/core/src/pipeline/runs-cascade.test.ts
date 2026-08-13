/**
 * ISS-352 — the cascade must NOT mark a successfully-completed run's leftover
 * sessions `failed`. A terminal pipeline step (forge-test → released,
 * forge-release → closed) sets the issue terminal as its last action while its
 * own session is still `running`; the cascade then reaps that session. A
 * `pipeline_completed` close must land those sessions on `completed`
 * (failureReason null); only genuine `pipeline_failed` / `pipeline_cancelled`
 * closes keep `failed`. The CAS WHERE-clause (queued|running|idle) is preserved
 * so already-terminal rows are never stomped.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  cascadeCancelChildJobs,
  reasonForOutcome,
  requestKillsForCascade,
} from './runs-cascade.js';

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (...args: unknown[]) => ({ _eq: args }),
  inArray: (...args: unknown[]) => ({ _inArray: args }),
}));

// Schema identities are plain strings so makeTx can branch on `table ===`.
vi.mock('../db/schema.js', () => ({
  agentSessions: 'agent_sessions-table',
  jobs: 'jobs-table',
  // ISS-447 — applyKernelTransition writes the audit row here; the tx double's
  // insert() ignores the table identity, so a marker string suffices.
  kernelTransitions: 'kernel_transitions-table',
}));

vi.mock('../logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn() } }));
// cm:why stub jobs/kill-gate.js so importing this module doesn't pull in the real db/client.js (env-validated) at collection time — cascadeCancelChildJobs itself never calls requestJobKill
const requestJobKillMock = vi.fn(
  async (..._args: unknown[]): Promise<'requested' | 'no_device'> => 'requested',
);
vi.mock('../jobs/kill-gate.js', () => ({
  requestJobKill: (...args: unknown[]) => requestJobKillMock(...args),
}));

interface UpdateCapture {
  table: unknown;
  set: Record<string, unknown>;
  where?: unknown;
}

/**
 * Minimal drizzle-tx double. The first `.update(jobs)` chain returns the
 * cancelled-job rows (so the session update branch runs); the second
 * `.update(agentSessions)` chain captures the `.set()` payload under test.
 */
function makeTx(cancelledJobRows: Array<Record<string, unknown>>) {
  const captures: UpdateCapture[] = [];
  const tx = {
    update(table: unknown) {
      const isJobs = table === 'jobs-table';
      const capture: UpdateCapture = { table, set: {} };
      captures.push(capture);
      const chain = {
        set(values: Record<string, unknown>) {
          capture.set = values;
          return chain;
        },
        // ISS-447 — both axes now flow through applyKernelTransition, which
        // always calls `.returning()`. The jobs chain returns the cancelled
        // rows (so the session branch + audit run); the session chain returns
        // the same ids so its audit insert fires too.
        where(arg: unknown) {
          capture.where = arg;
          return {
            returning: async () =>
              isJobs ? cancelledJobRows : cancelledJobRows.map((r) => ({ id: r.agentSessionId })),
          };
        },
      };
      return chain;
    },
    // applyKernelTransition writes one audit row per flipped entity.
    insert() {
      return { values: async () => undefined };
    },
  };
  return { tx, captures };
}

const sessionUpdate = (captures: UpdateCapture[]) =>
  captures.find((c) => c.table === 'agent_sessions-table')?.set;

describe('cascadeCancelChildJobs — session-status mapping (ISS-352)', () => {
  const jobRows = [
    { id: 'job-1', agentSessionId: 'sess-1', deviceId: 'dev-1' },
    { id: 'job-2', agentSessionId: 'sess-2', deviceId: 'dev-1' },
  ];

  it('maps pipeline_completed → session completed with failureReason null', async () => {
    const { tx, captures } = makeTx(jobRows);
    await cascadeCancelChildJobs(tx as never, 'run-1', 'pipeline_completed');
    const set = sessionUpdate(captures);
    expect(set?.status).toBe('completed');
    expect(set?.failureReason).toBeNull();
  });

  it('maps pipeline_failed → session failed with failureReason preserved', async () => {
    const { tx, captures } = makeTx(jobRows);
    await cascadeCancelChildJobs(tx as never, 'run-1', 'pipeline_failed');
    const set = sessionUpdate(captures);
    expect(set?.status).toBe('failed');
    expect(set?.failureReason).toBe('pipeline_failed');
  });

  it('maps pipeline_cancelled → session failed with failureReason preserved', async () => {
    const { tx, captures } = makeTx(jobRows);
    await cascadeCancelChildJobs(tx as never, 'run-1', 'pipeline_cancelled');
    const set = sessionUpdate(captures);
    expect(set?.status).toBe('failed');
    expect(set?.failureReason).toBe('pipeline_cancelled');
  });

  it('ISS-444: pipeline_completed resolves orphan jobs to done (success), not cancelled', async () => {
    const { tx, captures } = makeTx(jobRows);
    const res = await cascadeCancelChildJobs(tx as never, 'run-1', 'pipeline_completed');
    const jobSet = captures.find((c) => c.table === 'jobs-table')?.set;
    expect(jobSet?.status).toBe('done');
    expect(jobSet?.failureReason).toBeNull();
    expect(res.cancelledJobIds).toEqual(['job-1', 'job-2']);
    expect(res.abortedSessionIds).toEqual(['sess-1', 'sess-2']);
  });

  it('ISS-785: returns the cancelled job rows with a deviceId as killableJobs, for a post-commit job.cancel — not just the ones with a linked session', async () => {
    const { tx } = makeTx([
      { id: 'job-1', agentSessionId: 'sess-1', deviceId: 'dev-1' },
      { id: 'job-2', agentSessionId: null, deviceId: 'dev-1' },
      { id: 'job-3', agentSessionId: 'sess-3', deviceId: null },
    ]);
    const res = await cascadeCancelChildJobs(tx as never, 'run-1', 'pipeline_cancelled');
    expect(res.killableJobs.map((j) => j.id)).toEqual(['job-1', 'job-2']);
  });

  it('genuine cancel/fail closes still cancel orphan jobs', async () => {
    const { tx, captures } = makeTx(jobRows);
    await cascadeCancelChildJobs(tx as never, 'run-1', 'pipeline_failed');
    const jobSet = captures.find((c) => c.table === 'jobs-table')?.set;
    expect(jobSet?.status).toBe('cancelled');
    expect(jobSet?.failureReason).toBe('pipeline_failed');
  });

  it('skips the session update entirely when no jobs were cancelled', async () => {
    const { tx, captures } = makeTx([]);
    await cascadeCancelChildJobs(tx as never, 'run-1', 'pipeline_completed');
    expect(sessionUpdate(captures)).toBeUndefined();
  });

  // cm:guard `held` must stay in this CAS list (RFC 0002) — it is the one non-terminal status no reaper ever visits, so if the cascade skips it too, a held job under a closed run has no cleanup path left at all and survives as an orphan forever
  it('the CAS WHERE covers held alongside queued/dispatched/running', async () => {
    const { tx, captures } = makeTx(jobRows);
    await cascadeCancelChildJobs(tx as never, 'run-1', 'pipeline_cancelled');
    const where = JSON.stringify(captures.find((c) => c.table === 'jobs-table')?.where);
    expect(where).toContain('queued');
    expect(where).toContain('held');
  });

  it('reasonForOutcome maps outcomes to cascade reasons', () => {
    expect(reasonForOutcome('completed')).toBe('pipeline_completed');
    expect(reasonForOutcome('failed')).toBe('pipeline_failed');
    expect(reasonForOutcome('cancelled')).toBe('pipeline_cancelled');
  });
});

describe('requestKillsForCascade (ISS-785)', () => {
  it('requests a kill for every killable job and returns the notified devices', async () => {
    requestJobKillMock.mockReset();
    requestJobKillMock
      .mockResolvedValueOnce('requested')
      .mockResolvedValueOnce('requested')
      .mockResolvedValueOnce('no_device');

    const notified = await requestKillsForCascade(
      [
        { id: 'job-1', deviceId: 'dev-1' } as never,
        { id: 'job-2', deviceId: 'dev-1' } as never,
        { id: 'job-3', deviceId: null } as never,
      ],
      'pipeline_cancelled',
    );

    expect(requestJobKillMock).toHaveBeenCalledTimes(3);
    expect(requestJobKillMock).toHaveBeenCalledWith(
      { id: 'job-1', deviceId: 'dev-1' },
      'pipeline_cancelled',
    );
    expect(notified).toEqual(['dev-1']);
  });

  it('is a no-op on an empty list', async () => {
    requestJobKillMock.mockReset();
    const notified = await requestKillsForCascade([], 'pipeline_failed');
    expect(notified).toEqual([]);
    expect(requestJobKillMock).not.toHaveBeenCalled();
  });

  it('one job.cancel request throwing does not stop the rest', async () => {
    requestJobKillMock.mockReset();
    requestJobKillMock
      .mockRejectedValueOnce(new Error('publish boom'))
      .mockResolvedValueOnce('requested');

    const notified = await requestKillsForCascade(
      [{ id: 'job-1', deviceId: 'dev-1' } as never, { id: 'job-2', deviceId: 'dev-2' } as never],
      'pipeline_cancelled',
    );

    expect(notified).toEqual(['dev-2']);
  });
});
