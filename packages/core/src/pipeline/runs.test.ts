/**
 * ISS-101 — unit tests for the pipeline_runs lifecycle helpers. The helpers
 * are thin wrappers over `db.insert/update`, so the contract under test is
 * "what shape of write does each helper issue, under which preconditions?".
 * Heavy integration coverage (migration backfill, picker ordering against a
 * real DB) lives in dispatch-tick.test.ts and the migration smoke tests.
 *
 * ISS-104 — extended to assert that lifecycle helpers emit
 * `pipelineRunStatusChanged` exactly when the underlying write produced a
 * row.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type InsertCall = {
  values: Record<string, unknown>;
  conflict?: { target?: unknown; where?: unknown };
  returningRows: Record<string, unknown>[];
};
type UpdateCall = { set: Record<string, unknown>; returnedRows: Record<string, unknown>[] };

const insertCalls: InsertCall[] = [];
const updateCalls: UpdateCall[] = [];
const selectResponses: Array<Record<string, unknown>[]> = [];
let nextInsertReturnsEmpty = false;
// cm:guard the queue defaults to one canonical row when empty, so a test that forgets to push still sees a close that "worked" — push explicitly whenever the assertion is about whether the write happened at all.
const nextUpdateReturning: Array<Record<string, unknown>[]> = [];

const emitMock = vi.fn(async (..._args: unknown[]) => {});

// cm:edge contract -> packages/core/src/pipeline/deploy-confirmations.test.ts — the gate's own verdicts are proved there; here it is pinned CLEAR so these tests keep asserting the write shapes they were written for rather than the gate's logic twice.
const deployGateMock = vi.fn(() => ({ verdict: 'clear' }) as const);
const readHoldsMock = vi.fn(async () => ({}) as Record<string, unknown>);
const markDeferredMock = vi.fn();
vi.mock('./deploy-confirmations.js', () => ({
  readDeployHolds: (...a: unknown[]) => readHoldsMock(...(a as [])),
  resolveDeployGate: (...a: unknown[]) => deployGateMock(...(a as [])),
  markCloseDeferred: (...a: unknown[]) => markDeferredMock(...(a as [])),
}));

vi.mock('./hooks.js', () => ({
  hooks: {
    emit: (topic: unknown, payload: unknown) => emitMock(topic, payload),
  },
}));

const cascadeMock = vi.fn(async (_tx: unknown, _runId: string, _reason: string) => ({
  cancelledJobIds: [] as string[],
  abortedSessionIds: [] as string[],
  deviceBySession: new Map<string, string>(),
  killableJobs: [] as Array<Record<string, unknown>>,
}));
const requestKillsMock = vi.fn(async (_jobs: unknown, _reason: string) => [] as string[]);

vi.mock('./runs-cascade.js', () => ({
  cascadeCancelChildJobs: (...args: unknown[]) =>
    (cascadeMock as unknown as (...a: unknown[]) => unknown)(...args),
  requestKillsForCascade: (...args: unknown[]) =>
    (requestKillsMock as unknown as (...a: unknown[]) => unknown)(...args),
  reasonForOutcome: (outcome: string) =>
    outcome === 'completed'
      ? 'pipeline_completed'
      : outcome === 'failed'
        ? 'pipeline_failed'
        : 'pipeline_cancelled',
}));

vi.mock('../db/schema.js', () => ({
  pipelineRuns: {
    name: 'pipeline_runs',
    id: 'id',
    projectId: 'project_id',
    issueId: 'issue_id',
    kind: 'kind',
    currentStep: 'current_step',
    startedAt: 'started_at',
  },
  // ISS-447 — applyKernelTransition writes the audit row into this table; the
  // insert double below ignores the table identity, so a marker object suffices.
  kernelTransitions: { name: 'kernel_transitions' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (...args: unknown[]) => ({ _eq: args }),
  inArray: (...args: unknown[]) => ({ _inArray: args }),
  sql: ((strings: TemplateStringsArray, ...values: unknown[]) => ({
    _sql: strings.join('?'),
    values,
  })) as never,
}));

vi.mock('../db/client.js', () => {
  const mockDb: Record<string, unknown> = {};
  Object.assign(mockDb, {
    insert: () => {
      const call: InsertCall = { values: {}, returningRows: [] };
      const captured: InsertCall = call;
      const chain = {
        values(v: Record<string, unknown>) {
          captured.values = v;
          return chain;
        },
        onConflictDoNothing(opts: { target?: unknown; where?: unknown }) {
          captured.conflict = opts;
          return chain;
        },
        returning(_cols?: unknown) {
          const rows = nextInsertReturnsEmpty
            ? []
            : [{ id: 'run-new', startedAt: new Date('2026-05-12T08:00:00Z') }];
          captured.returningRows = rows;
          insertCalls.push(captured);
          return Promise.resolve(rows);
        },
      };
      return chain;
    },
    update: () => {
      let setCapture: Record<string, unknown> = {};
      const chain = {
        set(s: Record<string, unknown>) {
          setCapture = s;
          return {
            where: () => {
              // Record the UPDATE immediately so the no-`.returning()`
              // callers (setCurrentStep) still produce an updateCalls entry.
              const idx = updateCalls.length;
              updateCalls.push({ set: setCapture, returnedRows: [] });
              const p = Promise.resolve(undefined) as Promise<unknown> & {
                returning: (cols?: unknown) => Promise<Record<string, unknown>[]>;
              };
              p.returning = (_cols?: unknown) => {
                const rows = nextUpdateReturning.shift() ?? [
                  {
                    id: 'run-1',
                    projectId: 'p-1',
                    issueId: 'i-1',
                    kind: 'issue',
                    currentStep: 'plan',
                  },
                ];
                const entry = updateCalls[idx];
                if (entry) entry.returnedRows = rows;
                return Promise.resolve(rows);
              };
              return p;
            },
          };
        },
      };
      return chain;
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectResponses.shift() ?? []),
        }),
      }),
    }),
    // ISS-258 — close paths now wrap their UPDATE pipelineRuns in
    // db.transaction so the cascade UPDATE on jobs/agent_sessions rides
    // on the same tx. The mock simply invokes the callback with the same
    // db handle — drizzle's tx surface is structurally identical to db
    // for the calls these helpers issue (update/select/execute).
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(mockDb),
  });
  return { db: mockDb };
});

const {
  openIssueRun,
  openOneShotRun,
  setCurrentStep,
  setCurrentStepForOpenIssueRun,
  closeRun,
  closeRunIfOneShot,
  closeOpenRunForIssue,
} = await import('./runs.js');

beforeEach(() => {
  insertCalls.length = 0;
  updateCalls.length = 0;
  selectResponses.length = 0;
  nextUpdateReturning.length = 0;
  nextInsertReturnsEmpty = false;
  emitMock.mockClear();
  cascadeMock.mockClear();
  requestKillsMock.mockClear();
  deployGateMock.mockClear();
  readHoldsMock.mockClear();
  readHoldsMock.mockResolvedValue({ 'target:del-1': {} });
  markDeferredMock.mockClear();
});

describe('openIssueRun', () => {
  it('returns the existing open run when one is already present (no INSERT)', async () => {
    selectResponses.push([{ id: 'run-existing', startedAt: new Date('2026-05-10T00:00:00Z') }]);
    const r = await openIssueRun({ projectId: 'p-1', issueId: 'i-1' });
    expect(r.id).toBe('run-existing');
    expect(insertCalls).toHaveLength(0);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('INSERTs with ON CONFLICT DO NOTHING + returning when no open run exists', async () => {
    selectResponses.push([]);
    const r = await openIssueRun({ projectId: 'p-1', issueId: 'i-1' });
    expect(r.id).toBe('run-new');
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]?.values).toMatchObject({
      projectId: 'p-1',
      issueId: 'i-1',
      kind: 'issue',
      status: 'running',
    });
    expect(insertCalls[0]?.conflict).toBeDefined();
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith('pipelineRunStatusChanged', {
      runId: 'run-new',
      projectId: 'p-1',
      issueId: 'i-1',
      kind: 'issue',
      fromStatus: null,
      toStatus: 'running',
      currentStep: null,
    });
  });

  it('re-selects on ON CONFLICT loss and returns the winner (race-safe, no emit)', async () => {
    selectResponses.push([]);
    selectResponses.push([{ id: 'run-winner', startedAt: new Date('2026-05-12T07:00:00Z') }]);
    nextInsertReturnsEmpty = true;
    const r = await openIssueRun({ projectId: 'p-1', issueId: 'i-1' });
    expect(r.id).toBe('run-winner');
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('throws when ON CONFLICT loses AND the winner cannot be re-selected (defensive)', async () => {
    selectResponses.push([]);
    selectResponses.push([]);
    nextInsertReturnsEmpty = true;
    await expect(openIssueRun({ projectId: 'p-1', issueId: 'i-1' })).rejects.toThrow(
      /no row after ON CONFLICT DO NOTHING/,
    );
    expect(emitMock).not.toHaveBeenCalled();
  });
});

describe('openOneShotRun', () => {
  it('inserts a kind=pm run with issueId NULL and metadata, emits hook', async () => {
    const r = await openOneShotRun({ projectId: 'p-1', kind: 'pm', metadata: { src: 'unit' } });
    expect(r.id).toBe('run-new');
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]?.values).toMatchObject({
      projectId: 'p-1',
      issueId: null,
      kind: 'pm',
      status: 'running',
      metadata: { src: 'unit' },
    });
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith('pipelineRunStatusChanged', {
      runId: 'run-new',
      projectId: 'p-1',
      issueId: null,
      kind: 'pm',
      fromStatus: null,
      toStatus: 'running',
      currentStep: null,
    });
  });

  it('defaults metadata to empty object when omitted', async () => {
    await openOneShotRun({ projectId: 'p-1', kind: 'interactive' });
    expect(insertCalls[0]?.values.metadata).toEqual({});
  });

  it('supports kind=system for project-scoped one-shots without an issue', async () => {
    await openOneShotRun({ projectId: 'p-1', kind: 'system' });
    expect(insertCalls[0]?.values.kind).toBe('system');
  });
});

describe('setCurrentStep / setCurrentStepForOpenIssueRun', () => {
  it('setCurrentStep updates current_step and bumps updatedAt', async () => {
    await setCurrentStep('run-1', 'plan');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.set.currentStep).toBe('plan');
    expect(updateCalls[0]?.set.updatedAt).toBeInstanceOf(Date);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('setCurrentStepForOpenIssueRun issues an UPDATE filtered to running/paused issue runs', async () => {
    await setCurrentStepForOpenIssueRun('i-1', 'developed');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.set.currentStep).toBe('developed');
    expect(emitMock).not.toHaveBeenCalled();
  });
});

describe('closeRun / closeRunIfOneShot / closeOpenRunForIssue', () => {
  it('closeRun stamps status, finishedAt, updatedAt and emits one hook per returned row', async () => {
    nextUpdateReturning.push([
      {
        id: 'run-1',
        projectId: 'p-1',
        issueId: 'i-1',
        kind: 'issue',
        currentStep: 'code',
      },
    ]);
    await closeRun('run-1', 'completed');
    const closeCall = updateCalls.find((c) => c.returnedRows.length > 0);
    expect(closeCall?.set).toMatchObject({ status: 'completed' });
    expect(closeCall?.set.finishedAt).toBeInstanceOf(Date);
    expect(closeCall?.set.updatedAt).toBeInstanceOf(Date);
    expect(cascadeMock).toHaveBeenCalledWith(expect.anything(), 'run-1', 'pipeline_completed');
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith('pipelineRunStatusChanged', {
      runId: 'run-1',
      projectId: 'p-1',
      issueId: 'i-1',
      kind: 'issue',
      fromStatus: 'running',
      toStatus: 'completed',
      currentStep: 'code',
      cascadedJobIds: [],
    });
  });

  it('closeRun cascade-cancels orphan child jobs and requests a job.cancel kill for each (ISS-785)', async () => {
    nextUpdateReturning.push([
      {
        id: 'run-1',
        projectId: 'p-1',
        issueId: 'i-1',
        kind: 'issue',
        currentStep: 'triage',
      },
    ]);
    cascadeMock.mockResolvedValueOnce({
      cancelledJobIds: ['job-orphan'],
      abortedSessionIds: ['sess-orphan'],
      deviceBySession: new Map([['sess-orphan', 'dev-1']]),
      killableJobs: [{ id: 'job-orphan', deviceId: 'dev-1' }],
    });
    await closeRun('run-1', 'completed');
    expect(cascadeMock).toHaveBeenCalledTimes(1);
    expect(requestKillsMock).toHaveBeenCalledTimes(1);
    const [killableJobs, reason] = requestKillsMock.mock.calls[0] ?? [];
    expect(reason).toBe('pipeline_completed');
    expect(killableJobs).toEqual([{ id: 'job-orphan', deviceId: 'dev-1' }]);
    expect(emitMock).toHaveBeenCalledWith('pipelineRunStatusChanged', {
      runId: 'run-1',
      projectId: 'p-1',
      issueId: 'i-1',
      kind: 'issue',
      fromStatus: 'running',
      toStatus: 'completed',
      currentStep: 'triage',
      cascadedJobIds: ['job-orphan'],
    });
  });

  it('closeRun skips cascade + kill request when the UPDATE was a no-op (already terminal)', async () => {
    nextUpdateReturning.push([]);
    await closeRun('run-1', 'completed');
    expect(cascadeMock).not.toHaveBeenCalled();
    expect(requestKillsMock).not.toHaveBeenCalled();
  });

  it('closeRun emits zero hooks when the UPDATE was a no-op (already-terminal row)', async () => {
    nextUpdateReturning.push([]);
    await closeRun('run-1', 'completed');
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('closeRunIfOneShot supports all three terminal outcomes', async () => {
    nextUpdateReturning.push([
      { id: 'r1', projectId: 'p-1', issueId: null, kind: 'pm', currentStep: null },
    ]);
    nextUpdateReturning.push([
      { id: 'r1', projectId: 'p-1', issueId: null, kind: 'pm', currentStep: null },
    ]);
    nextUpdateReturning.push([
      { id: 'r1', projectId: 'p-1', issueId: null, kind: 'pm', currentStep: null },
    ]);
    await closeRunIfOneShot('r1', 'completed');
    await closeRunIfOneShot('r1', 'failed');
    await closeRunIfOneShot('r1', 'cancelled');
    const closes = updateCalls.filter((c) => c.returnedRows.length > 0);
    expect(closes.map((c) => c.set.status)).toEqual(['completed', 'failed', 'cancelled']);
    expect(emitMock).toHaveBeenCalledTimes(3);
  });

  it('closeOpenRunForIssue closes by issueId for kind=issue runs and emits', async () => {
    selectResponses.push([{ id: 'run-1', startedAt: new Date() }]);
    nextUpdateReturning.push([
      {
        id: 'run-1',
        projectId: 'p-1',
        issueId: 'i-1',
        kind: 'issue',
        currentStep: null,
      },
    ]);
    await closeOpenRunForIssue('i-1', 'completed');
    const closeCall = updateCalls.find((c) => c.returnedRows.length > 0);
    expect(closeCall?.set.status).toBe('completed');
    expect(cascadeMock).toHaveBeenCalledWith(expect.anything(), 'run-1', 'pipeline_completed');
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenLastCalledWith('pipelineRunStatusChanged', {
      runId: 'run-1',
      projectId: 'p-1',
      issueId: 'i-1',
      kind: 'issue',
      fromStatus: 'running',
      toStatus: 'completed',
      currentStep: null,
      cascadedJobIds: [],
    });
  });

  it('a run with no deploy hold is not asked, and pays no extra write', async () => {
    readHoldsMock.mockResolvedValue({});
    nextUpdateReturning.push([
      { id: 'run-1', projectId: 'p-1', issueId: 'i-1', kind: 'issue', currentStep: null },
    ]);

    expect(await closeRun('run-1', 'completed')).toBe('settled');

    expect(deployGateMock).not.toHaveBeenCalled();
    expect(markDeferredMock).not.toHaveBeenCalled();
  });

  // cm:guard this asserts ORDER, not that both happened — the marker must be written before the verdict is read, or a confirmation settling the last hold in between leaves nobody to close the run for an hour.
  it('marks the deferral before it reads the verdict, so the settle-in-between window cannot strand the run', async () => {
    const order: string[] = [];
    markDeferredMock.mockImplementation(async () => {
      order.push('mark');
    });
    deployGateMock.mockImplementation(() => {
      order.push('resolve');
      return { verdict: 'defer', confirmed: 1, total: 2 } as never;
    });

    await closeRun('run-1', 'completed');

    expect(order).toEqual(['mark', 'resolve']);
    deployGateMock.mockReset();
  });

  it('closeRun DEFERS `completed` while a dispatched deploy is unconfirmed, and writes nothing', async () => {
    deployGateMock.mockReturnValueOnce({ verdict: 'defer', confirmed: 1, total: 2 } as never);
    const before = updateCalls.length;

    expect(await closeRun('run-1', 'completed')).toBe('deferred');

    const wrote = updateCalls.slice(before).some((c) => c.set.status !== undefined);
    expect(wrote).toBe(false);
    expect(cascadeMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('closeRun writes `failed` when the deploy gate reports a failure, not the `completed` it was asked for', async () => {
    deployGateMock.mockReturnValueOnce({ verdict: 'failed', detail: 'Backend: boom' } as never);
    nextUpdateReturning.push([
      { id: 'run-1', projectId: 'p-1', issueId: 'i-1', kind: 'issue', currentStep: null },
    ]);

    expect(await closeRun('run-1', 'completed')).toBe('settled');

    const closeCall = updateCalls.find((c) => c.returnedRows.length > 0);
    expect(closeCall?.set.status).toBe('failed');
    expect(emitMock).toHaveBeenLastCalledWith(
      'pipelineRunStatusChanged',
      expect.objectContaining({ toStatus: 'failed' }),
    );
  });

  it('the gate is asked only about `completed` — a `cancelled` close is not a claim about a deploy', async () => {
    nextUpdateReturning.push([
      { id: 'run-1', projectId: 'p-1', issueId: 'i-1', kind: 'issue', currentStep: null },
    ]);
    await closeRun('run-1', 'cancelled');
    expect(deployGateMock).not.toHaveBeenCalled();
  });

  it('closeOpenRunForIssue is idempotent — repeat call with no UPDATE rows does not re-cascade', async () => {
    selectResponses.push([{ id: 'run-1', startedAt: new Date() }]);
    nextUpdateReturning.push([]);
    await closeOpenRunForIssue('i-1', 'completed');
    expect(cascadeMock).not.toHaveBeenCalled();
    expect(requestKillsMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });
});
