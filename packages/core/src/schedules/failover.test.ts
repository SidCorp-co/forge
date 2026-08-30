// Unit suite for schedules/failover.ts, split out of dispatch.test.ts with the
// code it covers. The env stub keeps it hermetic: config/env.js throws at import
// when DATABASE_URL / JWT_SECRET / DEVICE_TOKEN_PEPPER are absent.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectFrom = vi.fn((_payload: unknown) => ({
  where: vi.fn((_p: unknown) => ({ limit: selectLimit })),
}));
const insertReturning = vi.fn();
const insertValues = vi.fn((_payload: unknown) => ({ returning: insertReturning }));
const updateWhere = vi.fn((_payload: unknown) => ({
  returning: async () => [{ id: 'sess-1' }],
}));
const updateSet = vi.fn((_payload: unknown) => ({ where: updateWhere }));
const txUpdateReturning = vi.fn();
const txUpdateWhere = vi.fn((_payload: unknown) => ({ returning: txUpdateReturning }));
const txUpdateSet = vi.fn((_payload: unknown) => ({ where: txUpdateWhere }));
const txUpdate = vi.fn((_payload: unknown) => ({ set: txUpdateSet }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ update: txUpdate })),
  },
}));

const findDeviceMock = vi.fn<(projectId: string) => Promise<string | null>>(async () => 'dev-1');
const resolveRepoPathMock = vi.fn(
  (_o: string | null | undefined, p: string | null): string | null => p ?? null,
);
const resolveRunnerRepoMock = vi.fn<
  (projectId: string, deviceId: string) => Promise<string | null>
>(async () => null);
vi.mock('../lib/device-pool.js', () => ({
  findAvailableDeviceForProject: findDeviceMock,
  findChatCapableDeviceForProject: vi.fn(async () => null),
  resolveRepoPath: resolveRepoPathMock,
  resolveRunnerRepoPath: resolveRunnerRepoMock,
  resolveSessionRepoPathForDevice: vi.fn(
    async (projectId: string, deviceId: string | null, projectRepoPath: string | null) => {
      const bindingRepo = deviceId ? await resolveRunnerRepoMock(projectId, deviceId) : null;
      return resolveRepoPathMock(null, bindingRepo ?? projectRepoPath ?? null);
    },
  ),
}));

const syncTurnsMock = vi.fn(async () => ({ appended: [], truncatedFromTurnIndex: null }));
vi.mock('../agent-sessions/turns-helpers.js', () => ({ syncTurnsWithMessages: syncTurnsMock }));

vi.mock('../agent-sessions/broadcast.js', () => ({
  broadcastSession: vi.fn(),
  broadcastTurnAppended: vi.fn(),
}));

const publishMock = vi.fn(
  (_room: string, _msg: { event: string; data: Record<string, unknown> }) => undefined,
);
vi.mock('../ws/server.js', () => ({ roomManager: { publish: publishMock } }));
vi.mock('../ws/rooms.js', () => ({ deviceRoom: (id: string) => `device:${id}` }));

vi.mock('../lib/chat-preamble.js', () => ({
  buildChatPreamble: vi.fn(async () => '[Preamble]\n'),
  TOOL_REFERENCE: '<tool-reference>',
}));

vi.mock('../pipeline/runs.js', () => ({
  openIssueRun: vi.fn(async () => ({ id: 'mock-run-id', startedAt: new Date() })),
  openOneShotRun: vi.fn(async () => ({ id: 'mock-run-id' })),
  closeRun: vi.fn(async () => undefined),
  closeRunIfOneShot: vi.fn(async () => undefined),
  setCurrentStep: vi.fn(async () => undefined),
  setCurrentStepForOpenIssueRun: vi.fn(async () => undefined),
}));

const emitNotificationMock = vi.fn(async (_input: unknown) => ({ id: 'notif-1' }));
vi.mock('../notifications/emit.js', () => ({
  emitNotification: (input: unknown) => emitNotificationMock(input as never),
}));

const { redispatchScheduleSessionOnFailover } = await import('./failover.js');

const SCHEDULE_ID = 'sch-1';
const SOURCE_PROJECT_ID = 'proj-source';
const USER_ID = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  insertReturning.mockReset();
  txUpdateReturning.mockReset();
  findDeviceMock.mockReset();
  findDeviceMock.mockResolvedValue('dev-1');
  resolveRunnerRepoMock.mockReset();
  resolveRunnerRepoMock.mockResolvedValue(null);
  publishMock.mockReset();
  publishMock.mockReturnValue(undefined);
  syncTurnsMock.mockReset();
  syncTurnsMock.mockResolvedValue({ appended: [], truncatedFromTurnIndex: null });
  emitNotificationMock.mockReset();
  emitNotificationMock.mockResolvedValue({ id: 'notif-1' });
});

const DEAD_DEVICE = 'dev-dead';
const NEW_DEVICE = 'dev-2';

// cm:guard state `claudeSessionId` on every fixture. The drizzle mock discards the select's column list, so an ABSENT field reads `undefined` — which the ISS-875 side-effect guard treats as "never attached" and waves through. Every failover test here would then pass by accident, proving nothing about a session that did attach.
function failedScheduleSession(over: Record<string, unknown> = {}) {
  return {
    id: 'failed-sess',
    projectId: SOURCE_PROJECT_ID,
    userId: USER_ID,
    deviceId: DEAD_DEVICE,
    title: 'Daily Dream',
    messages: [{ role: 'user', content: 'do the scheduled thing', timestamp: 1 }],
    metadata: { source: 'schedule.run', scheduleId: SCHEDULE_ID },
    claudeSessionId: null,
    ...over,
  };
}

function seedRedispatchHappy() {
  findDeviceMock.mockResolvedValue(NEW_DEVICE);
  insertReturning.mockResolvedValueOnce([
    {
      id: 'retry-sess',
      projectId: SOURCE_PROJECT_ID,
      deviceId: null,
      title: 'Daily Dream',
      status: 'idle',
      messages: [],
      metadata: { source: 'schedule.run', scheduleId: SCHEDULE_ID },
      claudeSessionId: null,
      startedAt: null,
    },
  ]);
  txUpdateReturning.mockResolvedValueOnce([
    {
      id: 'retry-sess',
      projectId: SOURCE_PROJECT_ID,
      deviceId: NEW_DEVICE,
      status: 'running',
      claudeSessionId: null,
      metadata: { source: 'schedule.run', scheduleId: SCHEDULE_ID, deviceId: NEW_DEVICE },
    },
  ]);
}

describe('redispatchScheduleSessionOnFailover', () => {
  it('no_client_ack schedule session → re-dispatches to a DIFFERENT runner, excluding the dead one', async () => {
    selectLimit.mockResolvedValueOnce([failedScheduleSession()]);
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedRedispatchHappy();

    const result = await redispatchScheduleSessionOnFailover('failed-sess');

    expect(result).toEqual({
      ok: true,
      status: 'redispatched',
      sessionId: 'retry-sess',
      deviceId: NEW_DEVICE,
    });
    const exclude = (
      findDeviceMock.mock.calls[0] as unknown as [string, { excludeDeviceIds: string[] }]
    )[1];
    expect(exclude?.excludeDeviceIds).toContain(DEAD_DEVICE);
    const insertCall = insertReturning.mock.calls.length
      ? (insertValues.mock.calls[0]?.[0] as {
          metadata?: { failover?: { attempt: number; triedDeviceIds: string[] } };
        })
      : undefined;
    expect(insertCall?.metadata?.failover?.attempt).toBe(1);
    expect(insertCall?.metadata?.failover?.triedDeviceIds).toContain(DEAD_DEVICE);
    expect(publishMock).toHaveBeenCalledTimes(1);
    const [room, msg] = publishMock.mock.calls[0] as [string, { data: Record<string, unknown> }];
    expect(room).toBe(`device:${NEW_DEVICE}`);
    expect(String(msg.data.prompt)).toContain('do the scheduled thing');
  });

  it('non-schedule session → not-schedule, no re-dispatch', async () => {
    selectLimit.mockResolvedValueOnce([failedScheduleSession({ metadata: { source: 'chat' } })]);
    const result = await redispatchScheduleSessionOnFailover('failed-sess');
    expect(result).toEqual({ ok: false, status: 'not-schedule' });
    expect(insertValues).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('failover chain exhausted (attempt > MAX) → exhausted, no re-dispatch', async () => {
    selectLimit.mockResolvedValueOnce([
      failedScheduleSession({
        metadata: {
          source: 'schedule.run',
          scheduleId: SCHEDULE_ID,
          failover: { attempt: 2, triedDeviceIds: ['a', 'b'] },
        },
      }),
    ]);
    const result = await redispatchScheduleSessionOnFailover('failed-sess');
    expect(result).toEqual({ ok: false, status: 'exhausted' });
    expect(findDeviceMock).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('no other runner available → no-device, no re-dispatch', async () => {
    selectLimit.mockResolvedValueOnce([failedScheduleSession()]);
    findDeviceMock.mockResolvedValue(null);
    const result = await redispatchScheduleSessionOnFailover('failed-sess');
    expect(result).toEqual({ ok: false, status: 'no-device' });
    expect(insertValues).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('failed session has no user-message prompt → no-prompt', async () => {
    selectLimit.mockResolvedValueOnce([failedScheduleSession({ messages: [] })]);
    const result = await redispatchScheduleSessionOnFailover('failed-sess');
    expect(result).toEqual({ ok: false, status: 'no-prompt' });
    expect(findDeviceMock).not.toHaveBeenCalled();
  });
});

// cm:why ISS-875 fixtures reproduce Dream session 1584cfcf exactly — attached, 15 tool calls, created ISS-872, then died on a usage limit — because the classifier path reaches this function with no predicate of its own, and only the absence of a free device stopped it re-running a session that had already committed work.
describe('a session that may have committed work is never re-dispatched', () => {
  const attachedAndWorked = {
    claudeSessionId: 'claude-1584cfcf',
    metadata: { source: 'schedule.run', scheduleId: SCHEDULE_ID, toolCallCount: 15 },
  };

  // cm:guard seed the WHOLE happy path (project row + device + insert + turn) behind each refusal. Without it, deleting the guard makes the mock run dry and the test fails on `not iterable` — red for the wrong reason, and it would stay red for any unrelated seeding change. Seeded, a lost guard means a genuine `redispatched`, which is exactly the duplicate-work defect ISS-875 is about.
  function seedAnUnguardedRunWouldSucceed() {
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedRedispatchHappy();
  }

  it('attached with tool calls → side-effects, and NOTHING is re-dispatched', async () => {
    selectLimit.mockResolvedValueOnce([failedScheduleSession(attachedAndWorked)]);
    seedAnUnguardedRunWouldSucceed();

    const result = await redispatchScheduleSessionOnFailover('failed-sess');

    expect(result).toEqual({ ok: false, status: 'side-effects' });
    expect(findDeviceMock).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('attached with an UNKNOWN tool-call count refuses too — /desktop/status never patches it', async () => {
    selectLimit.mockResolvedValueOnce([
      failedScheduleSession({
        claudeSessionId: 'claude-1584cfcf',
        metadata: { source: 'schedule.run', scheduleId: SCHEDULE_ID },
      }),
    ]);
    seedAnUnguardedRunWouldSucceed();

    const result = await redispatchScheduleSessionOnFailover('failed-sess');

    expect(result).toEqual({ ok: false, status: 'side-effects' });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('attached having PROVABLY run nothing (toolCallCount 0) still fails over', async () => {
    selectLimit.mockResolvedValueOnce([
      failedScheduleSession({
        claudeSessionId: 'claude-cc-startup-death',
        metadata: { source: 'schedule.run', scheduleId: SCHEDULE_ID, toolCallCount: 0 },
      }),
    ]);
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedRedispatchHappy();

    const result = await redispatchScheduleSessionOnFailover('failed-sess');

    expect(result.status).toBe('redispatched');
  });

  it('alerts the operator that the run was abandoned — the next firing does not cover its window', async () => {
    selectLimit.mockResolvedValueOnce([failedScheduleSession(attachedAndWorked)]);
    seedAnUnguardedRunWouldSucceed();

    await redispatchScheduleSessionOnFailover('failed-sess');

    expect(emitNotificationMock).toHaveBeenCalledTimes(1);
    const alert = emitNotificationMock.mock.calls[0]?.[0] as {
      userId: string;
      type: string;
      severity: string;
      agentSessionId: string;
    };
    expect(alert.userId).toBe(USER_ID);
    expect(alert.type).toBe('schedule_report');
    expect(alert.severity).toBe('warning');
    expect(alert.agentSessionId).toBe('failed-sess');
  });
});

// cm:why finalizeScheduleSessionFailure writes the classifier's PREDICTED disposition before this function runs, and the real outcome used to be logged and dropped — so these cases assert on the persisted row, not the return value, which is where the `VISION: state-never-lies` breach was.
describe('the disposition actually applied is written back over the prediction', () => {
  function persistedDetail(): string | undefined {
    const call = updateSet.mock.calls.find(
      (c) => (c[0] as { failureDetail?: unknown })?.failureDetail !== undefined,
    );
    return (call?.[0] as { failureDetail?: string } | undefined)?.failureDetail;
  }

  it('refused as side-effects → the row says no failover, naming why, and keeps the class', async () => {
    selectLimit.mockResolvedValueOnce([
      failedScheduleSession({
        claudeSessionId: 'claude-1584cfcf',
        metadata: { source: 'schedule.run', scheduleId: SCHEDULE_ID, toolCallCount: 15 },
      }),
    ]);
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedRedispatchHappy();

    await redispatchScheduleSessionOnFailover('failed-sess', {
      failureClass: 'usage/session limit',
    });

    const detail = persistedDetail();
    expect(detail).toBe(
      'usage/session limit → no failover (session had attached and run tool calls; side effects preserved)',
    );
    expect(detail).not.toContain('cross-device failover');
  });

  it('no device left → the row says so instead of claiming a failover', async () => {
    selectLimit.mockResolvedValueOnce([failedScheduleSession()]);
    findDeviceMock.mockResolvedValue(null);

    await redispatchScheduleSessionOnFailover('failed-sess', {
      failureClass: 'usage/session limit',
    });

    expect(persistedDetail()).toBe(
      'usage/session limit → no failover (no other device was available)',
    );
  });

  it('a real re-dispatch records the device it landed on', async () => {
    selectLimit.mockResolvedValueOnce([failedScheduleSession()]);
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedRedispatchHappy();

    await redispatchScheduleSessionOnFailover('failed-sess', {
      failureClass: 'usage/session limit',
    });

    expect(persistedDetail()).toBe(
      `usage/session limit → cross-device failover (re-dispatched to device ${NEW_DEVICE})`,
    );
  });

  it('a caller that claimed no disposition (the loop-monitor sweep) leaves the row alone', async () => {
    selectLimit.mockResolvedValueOnce([failedScheduleSession()]);
    findDeviceMock.mockResolvedValue(null);

    await redispatchScheduleSessionOnFailover('failed-sess');

    expect(persistedDetail()).toBeUndefined();
  });
});
