import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeMock = vi.fn();
const insertReturningMock = vi.fn();
const insertValuesMock = vi.fn((..._args: unknown[]) => ({ returning: insertReturningMock }));
const insertMock = vi.fn((..._args: unknown[]) => ({ values: insertValuesMock }));
const selectLimitMock = vi.fn();
const selectWhereMock = vi.fn(() => ({ limit: selectLimitMock }));
const selectFromMock = vi.fn(() => ({ where: selectWhereMock }));
const selectMock = vi.fn((..._args: unknown[]) => ({ from: selectFromMock }));

vi.mock('../db/client.js', () => ({
  db: {
    execute: (...args: unknown[]) => executeMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    select: (...args: unknown[]) => selectMock(...args),
  },
}));

const enqueueJobMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../jobs/enqueue.js', () => ({
  enqueueJob: (...args: unknown[]) => enqueueJobMock(...(args as [string])),
}));

vi.mock('../memory/indexer.js', () => ({
  indexMemory: vi.fn(async () => {}),
}));

vi.mock('../queue/boss.js', () => ({
  boss: {
    createQueue: vi.fn(async () => {}),
    work: vi.fn(async () => 'worker-1'),
    schedule: vi.fn(async () => {}),
    unschedule: vi.fn(async () => {}),
  },
}));

vi.mock('../observability/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
}));

// ISS-101 — sweeper opens an issue pipeline_run before inserting the fallback
// job. Short-circuit the helper so the existing single-insert mock keeps
// matching the jobs row.
vi.mock('../pipeline/runs.js', () => ({
  openIssueRun: vi.fn().mockResolvedValue({ id: 'run-1', startedAt: new Date() }),
  openOneShotRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
  closeRun: vi.fn().mockResolvedValue(undefined),
  closeRunIfOneShot: vi.fn().mockResolvedValue(undefined),
  closeOpenRunForIssue: vi.fn().mockResolvedValue(undefined),
  setCurrentStep: vi.fn().mockResolvedValue(undefined),
  setCurrentStepForOpenIssueRun: vi.fn().mockResolvedValue(undefined),
}));

const { runPmEscalationSweep } = await import('./escalation-sweeper.js');

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const ISSUE_ID = '00000000-0000-4000-8000-000000000002';
const DECISION_ID = '00000000-0000-4000-8000-000000000003';
const OWNER_ID = '00000000-0000-4000-8000-000000000004';

beforeEach(() => {
  executeMock.mockReset();
  insertMock.mockClear();
  insertValuesMock.mockClear();
  insertReturningMock.mockReset();
  selectLimitMock.mockReset();
  enqueueJobMock.mockClear();
});

function dispatchEscalationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: DECISION_ID,
    project_id: PROJECT_ID,
    event_ref: { issueIds: [ISSUE_ID], expiresAt: '2020-01-01T00:00:00Z' },
    actions: [
      {
        type: 'escalate',
        fallback: {
          type: 'dispatch',
          issueId: ISSUE_ID,
          jobType: 'plan',
          payload: { foo: 'bar' },
        },
      },
    ],
    ...overrides,
  };
}

describe('runPmEscalationSweep', () => {
  it('dispatches the fallback job and records an escalation-timeout decision', async () => {
    executeMock.mockResolvedValueOnce({ rows: [dispatchEscalationRow()] });
    selectLimitMock.mockResolvedValueOnce([{ createdBy: OWNER_ID }]);
    insertReturningMock
      .mockResolvedValueOnce([{ id: 'job-1' }])
      .mockResolvedValueOnce([{ id: 'decision-2' }]);

    const result = await runPmEscalationSweep(new Date('2026-05-04T00:00:00Z'));

    expect(result).toEqual({ examined: 1, executed: 1, skipped: 0, errors: 0 });
    expect(insertValuesMock).toHaveBeenCalledTimes(2);
    const jobValues = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(jobValues).toMatchObject({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      createdBy: OWNER_ID,
      type: 'plan',
      status: 'queued',
    });
    const jobPayload = jobValues.payload as Record<string, unknown>;
    expect(jobPayload).toMatchObject({
      foo: 'bar',
      skillName: 'forge-plan',
      dispatchedBy: 'pm-escalation-timeout',
    });

    const decisionValues = insertValuesMock.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(decisionValues).toMatchObject({
      projectId: PROJECT_ID,
      cause: 'escalation-timeout',
    });
    expect((decisionValues.eventRef as Record<string, unknown>).parentDecisionId).toBe(DECISION_ID);
    expect(enqueueJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1' }),
    );
  });

  it('returns examined=0 when no expired escalations match', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    const result = await runPmEscalationSweep(new Date('2026-05-04T00:00:00Z'));
    expect(result).toEqual({ examined: 0, executed: 0, skipped: 0, errors: 0 });
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('skips nested escalate fallback (depth=1 cap) but still records a follow-up decision', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        dispatchEscalationRow({
          actions: [
            {
              type: 'escalate',
              fallback: { type: 'escalate', summary: 'nested' },
            },
          ],
        }),
      ],
    });
    insertReturningMock.mockResolvedValueOnce([{ id: 'decision-2' }]);

    const result = await runPmEscalationSweep();

    expect(result).toEqual({ examined: 1, executed: 0, skipped: 1, errors: 0 });
    // Exactly one insert: the timeout decision row. No job insert.
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    const decisionValues = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(decisionValues.cause).toBe('escalation-timeout');
  });

  it('skips and records a follow-up decision when the escalate has no fallback', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [dispatchEscalationRow({ actions: [{ type: 'escalate' }] })],
    });
    insertReturningMock.mockResolvedValueOnce([{ id: 'decision-2' }]);

    const result = await runPmEscalationSweep();

    expect(result).toEqual({ examined: 1, executed: 0, skipped: 1, errors: 0 });
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
  });

  it('treats a unique-violation on dispatch as already-active (executed)', async () => {
    executeMock.mockResolvedValueOnce({ rows: [dispatchEscalationRow()] });
    selectLimitMock.mockResolvedValueOnce([{ createdBy: OWNER_ID }]);
    const uniqueErr = Object.assign(new Error('dup'), { code: '23505' });
    insertReturningMock
      .mockRejectedValueOnce(uniqueErr)
      .mockResolvedValueOnce([{ id: 'decision-2' }]);

    const result = await runPmEscalationSweep();

    expect(result).toEqual({ examined: 1, executed: 1, skipped: 0, errors: 0 });
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });

  it('catches errors per row so one bad fallback does not block the rest', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [dispatchEscalationRow({ id: 'd-bad' }), dispatchEscalationRow({ id: 'd-good' })],
    });
    selectLimitMock
      .mockRejectedValueOnce(new Error('owner lookup blew up'))
      .mockResolvedValueOnce([{ createdBy: OWNER_ID }]);
    insertReturningMock
      .mockResolvedValueOnce([{ id: 'job-good' }])
      .mockResolvedValueOnce([{ id: 'decision-good' }]);

    const result = await runPmEscalationSweep();

    expect(result.examined).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.executed).toBe(1);
  });
});
