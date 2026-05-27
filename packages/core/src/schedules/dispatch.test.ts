import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shared per-call queues so each test seeds the order it expects.
// Explicit `(_payload: unknown)` keeps `mock.calls[i]` typed as `[unknown]`
// instead of `[]` so element access type-checks under strict tsconfig.
const selectLimit = vi.fn();
const selectFrom = vi.fn((_payload: unknown) => ({
  where: vi.fn((_p: unknown) => ({ limit: selectLimit })),
}));
const insertReturning = vi.fn();
const insertValues = vi.fn((_payload: unknown) => ({ returning: insertReturning }));
const updateWhere = vi.fn(async (_payload: unknown) => undefined);
const updateSet = vi.fn((_payload: unknown) => ({ where: updateWhere }));

// `db.transaction(async (tx) => ...)` invokes the callback with a tx object
// that mirrors the same select/insert/update surface — schedule.dispatch only
// uses `tx.insert(...).values(...).returning()` and the helpers' `tx` param.
const txInsertReturning = vi.fn();
const txInsertValues = vi.fn((_payload: unknown) => ({ returning: txInsertReturning }));
const txInsert = vi.fn((_payload: unknown) => ({ values: txInsertValues }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ insert: txInsert }),
    ),
  },
}));

// ISS-244 — schedule dispatch rides the interactive agent-session rails now.
// Stub out every collaborator the new path touches.
const findDeviceMock = vi.fn<(projectId: string) => Promise<string | null>>(async () => 'dev-1');
const resolveRepoPathMock = vi.fn(
  (_o: string | null | undefined, p: string | null): string | null => p ?? null,
);
vi.mock('../lib/device-pool.js', () => ({
  findAvailableDeviceForProject: findDeviceMock,
  resolveRepoPath: resolveRepoPathMock,
}));

const syncTurnsMock = vi.fn(
  async (
    _sessionId: string,
    _prev: unknown[],
    _next: unknown[],
    _tx?: unknown,
  ) => ({ appended: [], truncatedFromTurnIndex: null }),
);
vi.mock('../agent-sessions/turns-helpers.js', () => ({
  syncTurnsWithMessages: syncTurnsMock,
}));

const broadcastSessionMock = vi.fn((_row: unknown, _event: string, _extra?: unknown) => undefined);
const broadcastTurnAppendedMock = vi.fn((_row: unknown, _turn: unknown) => undefined);
vi.mock('../agent-sessions/broadcast.js', () => ({
  broadcastSession: broadcastSessionMock,
  broadcastTurnAppended: broadcastTurnAppendedMock,
}));

const publishMock = vi.fn((_room: string, _msg: { event: string; data: Record<string, unknown> }) => undefined);
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: publishMock },
}));
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
const SESSION_ID = 'sess-1';
const DEVICE_ID = 'dev-1';

function seedDesktopHappy() {
  // 1st .limit: project owner lookup (no actorUserId path) — seeded per-test.
  // 2nd .limit: project slug+repoPath lookup.
  // For most tests we set actorUserId so only one limit call is needed.
  findDeviceMock.mockResolvedValue(DEVICE_ID);
  txInsertReturning.mockResolvedValueOnce([
    {
      id: SESSION_ID,
      projectId: SOURCE_PROJECT_ID,
      title: 'Scheduled run',
      status: 'running',
    },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  insertReturning.mockReset();
  txInsertReturning.mockReset();
  findDeviceMock.mockReset();
  findDeviceMock.mockResolvedValue(DEVICE_ID);
  publishMock.mockReset();
  publishMock.mockReturnValue(undefined);
  syncTurnsMock.mockReset();
  syncTurnsMock.mockResolvedValue({ appended: [], truncatedFromTurnIndex: null });
  hooksModule.hooks.reset();
});

describe('dispatchScheduleRun (ISS-244 interactive path)', () => {
  it('antigravity runner → unsupported-runner / skipped (no DB writes, no WS)', async () => {
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

    expect(result).toEqual({ ok: false, reason: 'unsupported-runner', status: 'skipped' });
    expect(txInsertValues).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
    expect(findDeviceMock).not.toHaveBeenCalled();
  });

  it('desktop + actorUserId + device online → inserts agent_session, WS publishes, hook emits sessionId', async () => {
    // .limit calls: project slug+repoPath lookup
    selectLimit.mockResolvedValueOnce([
      { id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' },
    ]);
    seedDesktopHappy();

    let emitted: unknown = null;
    hooksModule.hooks.on('scheduleRun', (p) => {
      emitted = p;
    });

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        name: 'Daily Dream',
        projectId: SOURCE_PROJECT_ID,
        prompt: 'do thing',
        runner: 'desktop',
        targetProjectSlug: null,
      },
      actorUserId: USER_ID,
    });

    expect(result).toEqual({
      ok: true,
      sessionId: SESSION_ID,
      status: 'success',
      resolvedProjectId: SOURCE_PROJECT_ID,
    });

    const insertCall = txInsertValues.mock.calls[0]?.[0] as unknown as {
      projectId?: string;
      userId?: string;
      deviceId?: string;
      title?: string;
      status?: string;
      metadata?: Record<string, unknown>;
    };
    expect(insertCall?.projectId).toBe(SOURCE_PROJECT_ID);
    expect(insertCall?.userId).toBe(USER_ID);
    expect(insertCall?.deviceId).toBe(DEVICE_ID);
    expect(insertCall?.title).toBe('Daily Dream');
    expect(insertCall?.status).toBe('running');
    expect(insertCall?.metadata).toMatchObject({
      source: 'schedule.run',
      scheduleId: SCHEDULE_ID,
      deviceId: DEVICE_ID,
    });

    expect(publishMock).toHaveBeenCalledTimes(1);
    const [room, msg] = publishMock.mock.calls[0] as [string, { event: string; data: Record<string, unknown> }];
    expect(room).toBe(`device:${DEVICE_ID}`);
    expect(msg.event).toBe('agent:start');
    expect(msg.data.sessionId).toBe(SESSION_ID);
    expect(msg.data.projectSlug).toBe('src');
    expect(msg.data.repoPath).toBe('/repo');
    expect(msg.data.systemPrompt).toBe('<tool-reference>');

    expect(emitted).toMatchObject({
      scheduleId: SCHEDULE_ID,
      projectId: SOURCE_PROJECT_ID,
      sessionId: SESSION_ID,
      actorUserId: USER_ID,
    });
    expect(broadcastSessionMock).toHaveBeenCalledTimes(1);
  });

  it('tick + no device online → no-device / skipped (no inserts, no publish)', async () => {
    findDeviceMock.mockResolvedValueOnce(null);
    // owner lookup happens before findDevice in current code path
    selectLimit.mockResolvedValueOnce([{ ownerId: 'owner-1' }]); // ownerId
    selectLimit.mockResolvedValueOnce([
      { id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' },
    ]);

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

    expect(result).toEqual({ ok: false, reason: 'no-device', status: 'skipped' });
    expect(txInsertValues).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('manual /run + no device online → no-device / skipped (caller turns into 409)', async () => {
    findDeviceMock.mockResolvedValueOnce(null);
    selectLimit.mockResolvedValueOnce([
      { id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' },
    ]);

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
      },
      actorUserId: USER_ID,
    });

    expect(result).toEqual({ ok: false, reason: 'no-device', status: 'skipped' });
    expect(txInsertValues).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('targetProjectSlug → resolves and dispatches on target project', async () => {
    // 1st limit: project slug → target lookup
    selectLimit.mockResolvedValueOnce([{ id: TARGET_PROJECT_ID, ownerId: 'target-owner' }]);
    // 2nd limit: target project slug+repoPath
    selectLimit.mockResolvedValueOnce([
      { id: TARGET_PROJECT_ID, slug: 'tgt', repoPath: '/tgt' },
    ]);
    seedDesktopHappy();

    // Object wrapper so the callback's reassignment isn't lost to TS's
    // control-flow narrowing of plain `let` variables.
    const captured: { value: { projectId?: string; sessionId?: string } | null } = {
      value: null,
    };
    hooksModule.hooks.on('scheduleRun', (p) => {
      captured.value = p as unknown as { projectId?: string; sessionId?: string };
    });

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'do thing',
        runner: 'desktop',
        targetProjectSlug: 'marketing',
      },
      actorUserId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedProjectId).toBe(TARGET_PROJECT_ID);
      expect(result.sessionId).toBe(SESSION_ID);
    }
    const insertCall = txInsertValues.mock.calls[0]?.[0] as unknown as { projectId?: string };
    expect(insertCall?.projectId).toBe(TARGET_PROJECT_ID);
    expect(captured.value?.projectId).toBe(TARGET_PROJECT_ID);
    expect(captured.value?.sessionId).toBe(SESSION_ID);
  });

  it('targetProjectSlug not found → project-not-found / skipped', async () => {
    selectLimit.mockResolvedValueOnce([]); // no project matches slug

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: 'missing',
      },
      actorUserId: USER_ID,
    });

    expect(result).toEqual({ ok: false, reason: 'project-not-found', status: 'skipped' });
    expect(txInsertValues).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('WS publish throws → session marked failed, returns session-failed', async () => {
    selectLimit.mockResolvedValueOnce([
      { id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' },
    ]);
    seedDesktopHappy();
    publishMock.mockImplementationOnce(() => {
      throw new Error('ws-bus-down');
    });

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
      },
      actorUserId: USER_ID,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'session-failed',
      status: 'failed',
      sessionId: SESSION_ID,
    });
    // The cleanup must flip the freshly-inserted session to status='failed'
    // so it doesn't sit in `running` forever with no runner backing it.
    const setPayloads = updateSet.mock.calls.map((c) => c[0] as { status?: string });
    expect(setPayloads.some((p) => p?.status === 'failed')).toBe(true);
  });

  it('hook subscriber throws → dispatch still returns success (best-effort emit)', async () => {
    selectLimit.mockResolvedValueOnce([
      { id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' },
    ]);
    seedDesktopHappy();
    hooksModule.hooks.on('scheduleRun', () => {
      throw new Error('subscriber blew up');
    });

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
      },
      actorUserId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe('success');
  });

  it('tick attribution → falls back to project owner when no actorUserId', async () => {
    // First .limit: project ownerId lookup.
    // Second .limit: project slug+repoPath.
    selectLimit.mockResolvedValueOnce([{ ownerId: 'owner-1' }]);
    selectLimit.mockResolvedValueOnce([
      { id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' },
    ]);
    seedDesktopHappy();

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
    const insertCall = txInsertValues.mock.calls[0]?.[0] as unknown as {
      userId?: string;
      metadata?: { tick?: boolean };
    };
    expect(insertCall?.userId).toBe('owner-1');
    expect(insertCall?.metadata?.tick).toBe(true);
  });
});
