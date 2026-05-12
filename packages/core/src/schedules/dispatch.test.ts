import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectLimit = vi.fn();
// `db.select(...).from(...).where(...)` resolves directly when no `.limit`
// (used for the count(*) query); the `.where` mock returns a thenable so
// `await db...where(...)` works AND a `.limit` chain still works.
function makeWhereResult(): {
  limit: typeof selectLimit;
  then: (onFulfilled: (v: unknown) => unknown) => Promise<unknown>;
} {
  return {
    limit: selectLimit,
    then: (onFulfilled) => Promise.resolve(selectLimit()).then(onFulfilled),
  };
}
const selectWhereThenable = vi.fn(() => makeWhereResult());
const selectFrom = vi.fn(() => ({ where: selectWhereThenable }));
const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const updateWhere = vi.fn(async () => undefined);
const updateSet = vi.fn(() => ({ where: updateWhere }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
  },
}));

const enqueueMock = vi.fn(async () => undefined as unknown);
vi.mock('../jobs/enqueue.js', () => ({
  enqueueJob: (...args: unknown[]) => enqueueMock(...args),
}));

// ISS-101 — schedule dispatch now opens a one-shot pipeline_run before
// inserting the job. The test's insert mock only handles the jobs row, so
// short-circuit the helper to avoid consuming the insertReturning queue.
vi.mock('../pipeline/runs.js', () => ({
  openIssueRun: vi.fn(async () => ({ id: 'mock-run-id', startedAt: new Date() })),
  openOneShotRun: vi.fn(async () => ({ id: 'mock-run-id' })),
  closeRun: vi.fn(async () => undefined),
  closeRunIfOneShot: vi.fn(async () => undefined),
  closeOpenRunForIssue: vi.fn(async () => undefined),
  setCurrentStep: vi.fn(async () => undefined),
  setCurrentStepForOpenIssueRun: vi.fn(async () => undefined),
}));

const { dispatchScheduleRun } = await import('./dispatch.js');
const hooksModule = await import('../pipeline/hooks.js');

const SCHEDULE_ID = 'sch-1';
const SOURCE_PROJECT_ID = 'proj-source';
const TARGET_PROJECT_ID = 'proj-target';
const USER_ID = 'user-1';
const JOB_ID = 'job-1';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  insertReturning.mockReset();
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue(undefined);
  hooksModule.hooks.reset();
});

describe('dispatchScheduleRun', () => {
  it('antigravity + actorUserId → insert + enqueue + emit', async () => {
    insertReturning.mockResolvedValueOnce([{ id: JOB_ID }]);

    let emitted: unknown = null;
    hooksModule.hooks.on('scheduleRun', (p) => {
      emitted = p;
    });

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'do thing',
        runner: 'antigravity',
        targetProjectSlug: null,
      },
      actorUserId: USER_ID,
    });

    expect(result).toEqual({
      ok: true,
      jobId: JOB_ID,
      status: 'success',
      resolvedProjectId: SOURCE_PROJECT_ID,
    });
    const insertCall = insertValues.mock.calls[0]?.[0] as { createdBy?: string; projectId?: string };
    expect(insertCall?.createdBy).toBe(USER_ID);
    expect(insertCall?.projectId).toBe(SOURCE_PROJECT_ID);
    expect(emitted).toMatchObject({
      scheduleId: SCHEDULE_ID,
      projectId: SOURCE_PROJECT_ID,
      jobId: JOB_ID,
      actorUserId: USER_ID,
    });
  });

  it('targetProjectSlug → resolves and enqueues on target project', async () => {
    // 1st select: lookup project by slug
    selectLimit.mockResolvedValueOnce([{ id: TARGET_PROJECT_ID, ownerId: 'target-owner' }]);
    insertReturning.mockResolvedValueOnce([{ id: JOB_ID }]);

    let emitted: { projectId?: string } | null = null;
    hooksModule.hooks.on('scheduleRun', (p) => {
      emitted = p as never;
    });

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'do thing',
        runner: 'antigravity',
        targetProjectSlug: 'marketing',
      },
      actorUserId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolvedProjectId).toBe(TARGET_PROJECT_ID);
    const insertCall = insertValues.mock.calls[0]?.[0] as { projectId?: string };
    expect(insertCall?.projectId).toBe(TARGET_PROJECT_ID);
    expect(emitted?.projectId).toBe(TARGET_PROJECT_ID);
  });

  it('targetProjectSlug → not found yields project-not-found / skipped', async () => {
    selectLimit.mockResolvedValueOnce([]); // no project matches slug

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'antigravity',
        targetProjectSlug: 'missing',
      },
      actorUserId: USER_ID,
    });

    expect(result).toEqual({ ok: false, reason: 'project-not-found', status: 'skipped' });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('desktop runner with no online runner → no-runner / skipped', async () => {
    // Desktop path: 1st select-with-limit is the project ownerId lookup
    // (because no actorUserId is supplied). 2nd select-without-limit returns
    // count(*)=0.
    selectLimit.mockResolvedValueOnce([{ ownerId: 'owner-1' }]); // ownerId lookup
    selectLimit.mockResolvedValueOnce([{ count: 0 }]); // runners count

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
      },
      tick: true,
    });

    expect(result).toEqual({ ok: false, reason: 'no-runner', status: 'skipped' });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('desktop runner without tick (manual /run) skips runner check and enqueues', async () => {
    insertReturning.mockResolvedValueOnce([{ id: JOB_ID }]);

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
      },
      actorUserId: USER_ID,
      // tick omitted — manual trigger
    });

    expect(result.ok).toBe(true);
    // No selectLimit calls expected (no slug, actorUserId set, tick !== true).
    expect(selectLimit).not.toHaveBeenCalled();
  });

  it('enqueueJob throws → marks job failed (no orphan queued row), no hook emit', async () => {
    insertReturning.mockResolvedValueOnce([{ id: JOB_ID }]);
    enqueueMock.mockRejectedValueOnce(new Error('boss down'));

    let emitted: unknown = null;
    hooksModule.hooks.on('scheduleRun', (p) => {
      emitted = p;
    });

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'antigravity',
        targetProjectSlug: null,
      },
      actorUserId: USER_ID,
    });

    expect(result).toEqual({ ok: false, reason: 'enqueue-failed', status: 'failed', jobId: JOB_ID });
    // The cleanup must flip the freshly-inserted row to status='failed' so it
    // doesn't sit in `queued` forever with no boss message backing it.
    const setPayloads = updateSet.mock.calls.map((c) => c[0] as { status?: string });
    expect(setPayloads.some((p) => p?.status === 'failed')).toBe(true);
    expect(emitted).toBeNull();
  });

  it('hook subscriber throws → dispatch still returns success (best-effort emit)', async () => {
    insertReturning.mockResolvedValueOnce([{ id: JOB_ID }]);
    hooksModule.hooks.on('scheduleRun', () => {
      throw new Error('subscriber blew up');
    });

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'antigravity',
        targetProjectSlug: null,
      },
      actorUserId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe('success');
  });

  it('desktop runner with online runner → enqueues', async () => {
    selectLimit.mockResolvedValueOnce([{ ownerId: 'owner-1' }]); // ownerId lookup
    selectLimit.mockResolvedValueOnce([{ count: 1 }]); // runners count
    insertReturning.mockResolvedValueOnce([{ id: JOB_ID }]);

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
      },
      tick: true,
    });

    expect(result.ok).toBe(true);
    const insertCall = insertValues.mock.calls[0]?.[0] as {
      createdBy?: string;
      payload?: Record<string, unknown>;
    };
    expect(insertCall?.createdBy).toBe('owner-1');
    expect(insertCall?.payload?.tick).toBe(true);
  });
});
