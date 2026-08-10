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
import { cascadeCancelChildJobs, reasonForOutcome } from './runs-cascade.js';

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
vi.mock('../ws/rooms.js', () => ({ deviceRoom: (id: string) => `device:${id}` }));

interface UpdateCapture {
  table: unknown;
  set: Record<string, unknown>;
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
        where() {
          return {
            returning: async () =>
              isJobs
                ? cancelledJobRows
                : cancelledJobRows.map((r) => ({ id: r.agentSessionId })),
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

  it('reasonForOutcome maps outcomes to cascade reasons', () => {
    expect(reasonForOutcome('completed')).toBe('pipeline_completed');
    expect(reasonForOutcome('failed')).toBe('pipeline_failed');
    expect(reasonForOutcome('cancelled')).toBe('pipeline_cancelled');
  });
});
