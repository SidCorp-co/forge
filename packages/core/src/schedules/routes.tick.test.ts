import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

// `runScheduleTickOnce` does:
//   1. await db.select().from(schedules).where(...)        // due rows
//   2. await db.update(schedules).set(...).where(...).returning(...) // atomic claim
//   3. dispatchScheduleRun(...)                            // mocked here
//   4. await db.update(schedules).set({lastStatus}).where(...)
//
// We mock dispatch.js so the integration test stays focused on the tick
// wrapper (atomic claim + lastStatus transitions) without re-asserting the
// helper's internals (already covered in dispatch.test.ts).

const selectFromMock = vi.fn();
const updateSetMock = vi.fn();
const updateReturningMock = vi.fn();

function makeUpdateChain() {
  // Each db.update(...).set(...).where(...) call gets a fresh chain so we can
  // observe per-call `set` payloads in order.
  const where = (..._args: unknown[]) => ({
    returning: updateReturningMock,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
  });
  return {
    set: (payload: unknown) => {
      updateSetMock(payload);
      return { where };
    },
  };
}

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: selectFromMock }) }),
    update: () => makeUpdateChain(),
  },
}));

const dispatchMock = vi.fn();
vi.mock('./dispatch.js', () => ({
  dispatchScheduleRun: (...args: unknown[]) => dispatchMock(...args),
}));

vi.mock('./cron.js', async () => {
  const actual = await vi.importActual<typeof import('./cron.js')>('./cron.js');
  return {
    ...actual,
    nextRunFor: vi.fn(() => new Date('2099-01-01T00:00:00Z')),
  };
});

const { runScheduleTickOnce } = await import('./routes.js');

const SCHEDULE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';

function dueScheduleRow(
  overrides: Partial<{
    runner: 'desktop' | 'antigravity';
    targetProjectSlug: string | null;
  }> = {},
) {
  return {
    id: SCHEDULE_ID,
    name: 'tick-test',
    projectId: PROJECT_ID,
    prompt: 'do thing',
    // ISS-244 — desktop is the only runner supported on the interactive
    // dispatch path; tick tests default to it so happy paths exercise the
    // real flow.
    runner: overrides.runner ?? 'desktop',
    targetProjectSlug: overrides.targetProjectSlug ?? null,
    cron: '0 9 * * *',
    nextRunAt: new Date('2026-04-25T09:00:00Z'),
    enabled: true,
    lastStatus: null,
    lastRunAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectFromMock.mockReset();
  updateSetMock.mockReset();
  updateReturningMock.mockReset();
});

describe('runScheduleTickOnce', () => {
  it('passes targetProjectSlug through to dispatcher and updates lastStatus to success', async () => {
    selectFromMock.mockResolvedValueOnce([dueScheduleRow({ targetProjectSlug: 'marketing' })]);
    updateReturningMock.mockResolvedValueOnce([{ id: SCHEDULE_ID }]); // atomic claim wins
    dispatchMock.mockResolvedValueOnce({
      ok: true,
      sessionId: 'sess-1',
      status: 'success',
      resolvedProjectId: 'proj-target',
    });

    const dispatched = await runScheduleTickOnce(new Date('2026-04-25T09:00:00Z'));

    expect(dispatched).toEqual([SCHEDULE_ID]);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchArg = dispatchMock.mock.calls[0]?.[0] as {
      schedule: { targetProjectSlug: string | null };
      tick?: boolean;
    };
    expect(dispatchArg.schedule.targetProjectSlug).toBe('marketing');
    expect(dispatchArg.tick).toBe(true);

    // lastStatus transitions: 'running' (atomic claim) then 'success' (post-dispatch)
    const setPayloads = updateSetMock.mock.calls.map((c) => c[0] as { lastStatus?: string });
    expect(setPayloads[0]?.lastStatus).toBe('running');
    expect(setPayloads[1]?.lastStatus).toBe('success');
  });

  it("desktop schedule with no online device → lastStatus='skipped' (no dispatched id)", async () => {
    selectFromMock.mockResolvedValueOnce([dueScheduleRow({ runner: 'desktop' })]);
    updateReturningMock.mockResolvedValueOnce([{ id: SCHEDULE_ID }]);
    dispatchMock.mockResolvedValueOnce({
      ok: false,
      reason: 'no-device',
      status: 'skipped',
    });

    const dispatched = await runScheduleTickOnce(new Date('2026-04-25T09:00:00Z'));

    expect(dispatched).toEqual([]);
    const setPayloads = updateSetMock.mock.calls.map((c) => c[0] as { lastStatus?: string });
    expect(setPayloads[0]?.lastStatus).toBe('running');
    expect(setPayloads[1]?.lastStatus).toBe('skipped');
  });

  it("dispatch throws → lastStatus reset to 'failed' (no stuck 'running')", async () => {
    selectFromMock.mockResolvedValueOnce([dueScheduleRow()]);
    updateReturningMock.mockResolvedValueOnce([{ id: SCHEDULE_ID }]);
    dispatchMock.mockRejectedValueOnce(new Error('boom'));

    const dispatched = await runScheduleTickOnce(new Date('2026-04-25T09:00:00Z'));

    expect(dispatched).toEqual([]);
    const setPayloads = updateSetMock.mock.calls.map((c) => c[0] as { lastStatus?: string });
    expect(setPayloads[0]?.lastStatus).toBe('running');
    expect(setPayloads[1]?.lastStatus).toBe('failed');
  });

  it('atomic claim race-loss (rowcount=0) → no dispatch', async () => {
    selectFromMock.mockResolvedValueOnce([dueScheduleRow()]);
    updateReturningMock.mockResolvedValueOnce([]); // another ticker won

    const dispatched = await runScheduleTickOnce(new Date('2026-04-25T09:00:00Z'));

    expect(dispatched).toEqual([]);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
