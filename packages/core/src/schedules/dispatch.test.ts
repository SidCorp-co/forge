import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub eager env validation (config/env.js throws at import when DATABASE_URL /
// JWT_SECRET / DEVICE_TOKEN_PEPPER are absent) so this unit suite stays hermetic
// and never depends on the operator's shell — same pattern as schedules/routes.test.ts.
vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

// Shared per-call queues so each test seeds the order it expects.
// Explicit `(_payload: unknown)` keeps `mock.calls[i]` typed as `[unknown]`
// instead of `[]` so element access type-checks under strict tsconfig.
const selectLimit = vi.fn();
const selectFrom = vi.fn((_payload: unknown) => ({
  where: vi.fn((_p: unknown) => ({ limit: selectLimit })),
}));
// `createChatSessionRow` inserts the EMPTY session via `db.insert(...).values(...).returning()`.
const insertReturning = vi.fn();
const insertValues = vi.fn((_payload: unknown) => ({ returning: insertReturning }));
// schedule's publish-failure cleanup marks the session failed via
// applyKernelTransition (ISS-447): db.update(...).set(...).where(...).returning()
// then the kernel_transitions audit insert.
const updateWhere = vi.fn((_payload: unknown) => ({
  returning: async () => [{ id: 'sess-1' }],
}));
const updateSet = vi.fn((_payload: unknown) => ({ where: updateWhere }));

// `dispatchChatTurn` appends the turn inside `db.transaction(async (tx) => ...)`
// via `tx.update(...).set(...).where(...).returning()`.
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

// ISS-244 — schedule dispatch rides the interactive agent-session rails now.
// Stub out every collaborator the new path touches.
const findDeviceMock = vi.fn<(projectId: string) => Promise<string | null>>(async () => 'dev-1');
const resolveRepoPathMock = vi.fn(
  (_o: string | null | undefined, p: string | null): string | null => p ?? null,
);
const resolveRunnerRepoMock = vi.fn<
  (projectId: string, deviceId: string) => Promise<string | null>
>(async () => null);
vi.mock('../lib/device-pool.js', () => ({
  findAvailableDeviceForProject: findDeviceMock,
  resolveRepoPath: resolveRepoPathMock,
  resolveRunnerRepoPath: resolveRunnerRepoMock,
}));

const syncTurnsMock = vi.fn(
  async (_sessionId: string, _prev: unknown[], _next: unknown[], _tx?: unknown) => ({
    appended: [],
    truncatedFromTurnIndex: null,
  }),
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

const publishMock = vi.fn(
  (_room: string, _msg: { event: string; data: Record<string, unknown> }) => undefined,
);
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

// ISS-548 — mock the prompt builder so dispatch tests remain registry-independent.
const buildSkillImprovePromptMock =
  vi.fn<
    (input: { templateKey: string; mode: string; appliedMessageVersions: unknown }) => string | null
  >();
vi.mock('./messages/skill-improve-prompt.js', () => ({
  buildSkillImprovePrompt: (input: unknown) => buildSkillImprovePromptMock(input as never),
  extractReportFromMessages: vi.fn(() => null),
}));

// ISS-556 — mock the steward prompt builder.
const buildSkillStewardPromptMock = vi.fn<(input: { mode: string; projectId: string }) => string>(
  () => 'BUILT_STEWARD_PROMPT',
);
vi.mock('./messages/skill-steward-prompt.js', () => ({
  buildSkillStewardPrompt: (input: unknown) => buildSkillStewardPromptMock(input as never),
  extractStewardReportFromMessages: vi.fn(() => null),
}));

// ISS-568 — mock the drift-check prompt builder.
const buildDriftCheckPromptMock = vi.fn<(input: { mode: string; projectId: string }) => string>(
  () => 'BUILT_DRIFT_CHECK_PROMPT',
);
vi.mock('./messages/drift-check-prompt.js', () => ({
  buildDriftCheckPrompt: (input: unknown) => buildDriftCheckPromptMock(input as never),
}));

// ISS-587 — mock the product-map-refresh prompt builder.
const buildProductMapRefreshPromptMock = vi.fn<
  (input: { mode: string; projectId: string }) => string
>(() => 'BUILT_PRODUCT_MAP_PROMPT');
vi.mock('./messages/product-map-refresh-prompt.js', () => ({
  buildProductMapRefreshPrompt: (input: unknown) =>
    buildProductMapRefreshPromptMock(input as never),
}));

// ISS-713 — mock the fleet feedback-digest prompt builder.
const buildFeedbackDigestPromptMock = vi.fn<(input: { mode: string; projectId: string }) => string>(
  () => 'BUILT_FEEDBACK_DIGEST_PROMPT',
);
vi.mock('./messages/feedback-digest-prompt.js', () => ({
  buildFeedbackDigestPrompt: (input: unknown) => buildFeedbackDigestPromptMock(input as never),
}));

// ISS-618 — mock the sandbox executor so script-kind dispatch tests are
// deterministic and never spawn a real worker thread.
const runScheduleScriptMock =
  vi.fn<
    (input: { script: string; params?: unknown; timeoutMs?: number }) => Promise<{
      status: 'success' | 'failed';
      output: string;
      error?: string;
      notifications: Array<{ title: string; body?: string; severity?: string }>;
    }>
  >();
vi.mock('./script/executor.js', () => ({
  runScheduleScript: (input: unknown) => runScheduleScriptMock(input as never),
}));

// ISS-618 — mock notification delivery; script-kind dispatch tests assert on
// the call args, not on the real notifications-table insert.
const emitNotificationMock = vi.fn(async (_input: unknown) => ({ id: 'notif-1' }));
vi.mock('../notifications/emit.js', () => ({
  emitNotification: (input: unknown) => emitNotificationMock(input as never),
}));

const { dispatchScheduleRun, redispatchScheduleSessionOnFailover } = await import('./dispatch.js');
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
  // createChatSessionRow → empty row (status idle, no device, no messages).
  insertReturning.mockResolvedValueOnce([
    {
      id: SESSION_ID,
      projectId: SOURCE_PROJECT_ID,
      deviceId: null,
      title: 'Scheduled run',
      status: 'idle',
      messages: [],
      metadata: { source: 'schedule.run', scheduleId: SCHEDULE_ID },
      repoPath: null,
      claudeSessionId: null,
      startedAt: null,
    },
  ]);
  // dispatchChatTurn → the same row flipped to running with the turn appended.
  txUpdateReturning.mockResolvedValueOnce([
    {
      id: SESSION_ID,
      projectId: SOURCE_PROJECT_ID,
      deviceId: DEVICE_ID,
      title: 'Scheduled run',
      status: 'running',
      claudeSessionId: null,
      metadata: { source: 'schedule.run', scheduleId: SCHEDULE_ID, deviceId: DEVICE_ID },
    },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  insertReturning.mockReset();
  txUpdateReturning.mockReset();
  findDeviceMock.mockReset();
  findDeviceMock.mockResolvedValue(DEVICE_ID);
  resolveRunnerRepoMock.mockReset();
  resolveRunnerRepoMock.mockResolvedValue(null);
  publishMock.mockReset();
  publishMock.mockReturnValue(undefined);
  syncTurnsMock.mockReset();
  syncTurnsMock.mockResolvedValue({ appended: [], truncatedFromTurnIndex: null });
  buildSkillImprovePromptMock.mockReset();
  runScheduleScriptMock.mockReset();
  emitNotificationMock.mockReset();
  emitNotificationMock.mockResolvedValue({ id: 'notif-1' });
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
    expect(insertValues).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
    expect(findDeviceMock).not.toHaveBeenCalled();
  });

  it('desktop + actorUserId + device online → inserts agent_session, WS publishes, hook emits sessionId', async () => {
    // .limit calls: project slug+repoPath lookup
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
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

    // createChatSessionRow seeds the EMPTY row (no device, default idle).
    const insertCall = insertValues.mock.calls[0]?.[0] as unknown as {
      projectId?: string;
      userId?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    };
    expect(insertCall?.projectId).toBe(SOURCE_PROJECT_ID);
    expect(insertCall?.userId).toBe(USER_ID);
    expect(insertCall?.title).toBe('Daily Dream');
    expect(insertCall?.metadata).toMatchObject({
      source: 'schedule.run',
      scheduleId: SCHEDULE_ID,
    });

    // dispatchChatTurn pins the device + flips to running in the tx.update.
    const turnUpdate = txUpdateSet.mock.calls[0]?.[0] as unknown as {
      status?: string;
      deviceId?: string;
      metadata?: Record<string, unknown>;
    };
    expect(turnUpdate?.status).toBe('running');
    expect(turnUpdate?.deviceId).toBe(DEVICE_ID);
    expect(turnUpdate?.metadata).toMatchObject({ deviceId: DEVICE_ID });

    expect(publishMock).toHaveBeenCalledTimes(1);
    const [room, msg] = publishMock.mock.calls[0] as [
      string,
      { event: string; data: Record<string, unknown> },
    ];
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

  // Regression: the chosen runner's binding repo_path MUST win over
  // project.repoPath. The latter is only valid on the owner's box; sending it
  // to a remote CLI runner makes `claude` spawn in a non-existent cwd and the
  // chat/schedule session hangs `running` forever.
  it('runner binding repo_path overrides project.repoPath in the agent:start cwd', async () => {
    selectLimit.mockResolvedValueOnce([
      { id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/home/owner/repo' },
    ]);
    resolveRunnerRepoMock.mockResolvedValueOnce('/home/services/forge');
    seedDesktopHappy();

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'do thing',
        runner: 'desktop',
        targetProjectSlug: null,
      },
      actorUserId: USER_ID,
    });

    expect(result.ok).toBe(true);
    expect(resolveRunnerRepoMock).toHaveBeenCalledWith(SOURCE_PROJECT_ID, DEVICE_ID);
    const [, msg] = publishMock.mock.calls[0] as [string, { data: Record<string, unknown> }];
    expect(msg.data.repoPath).toBe('/home/services/forge');
  });

  it('tick + no device online → no-device / skipped (no inserts, no publish)', async () => {
    findDeviceMock.mockResolvedValueOnce(null);
    // owner lookup happens before findDevice in current code path
    selectLimit.mockResolvedValueOnce([{ createdBy: 'owner-1' }]); // createdBy
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);

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
    expect(insertValues).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('manual /run + no device online → no-device / skipped (caller turns into 409)', async () => {
    findDeviceMock.mockResolvedValueOnce(null);
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);

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
    expect(insertValues).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('targetProjectSlug → resolves and dispatches on target project', async () => {
    // 1st limit: project slug → target lookup
    selectLimit.mockResolvedValueOnce([{ id: TARGET_PROJECT_ID, createdBy: 'target-owner' }]);
    // 2nd limit: target project slug+repoPath
    selectLimit.mockResolvedValueOnce([{ id: TARGET_PROJECT_ID, slug: 'tgt', repoPath: '/tgt' }]);
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
    const insertCall = insertValues.mock.calls[0]?.[0] as unknown as { projectId?: string };
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
    expect(insertValues).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('WS publish throws → session marked failed, returns session-failed', async () => {
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
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
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
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
    // First .limit: project createdBy lookup.
    // Second .limit: project slug+repoPath.
    selectLimit.mockResolvedValueOnce([{ createdBy: 'owner-1' }]);
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
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
    const insertCall = insertValues.mock.calls[0]?.[0] as unknown as {
      userId?: string;
      metadata?: { tick?: boolean };
    };
    expect(insertCall?.userId).toBe('owner-1');
    expect(insertCall?.metadata?.tick).toBe(true);
  });
});

// ── ISS-584 (B): schedule cross-runner failover ───────────────────────────────

describe('redispatchScheduleSessionOnFailover', () => {
  const DEAD_DEVICE = 'dev-dead';
  const NEW_DEVICE = 'dev-2';

  function failedScheduleSession(over: Record<string, unknown> = {}) {
    return {
      id: 'failed-sess',
      projectId: SOURCE_PROJECT_ID,
      userId: USER_ID,
      deviceId: DEAD_DEVICE,
      title: 'Daily Dream',
      messages: [{ role: 'user', content: 'do the scheduled thing', timestamp: 1 }],
      metadata: { source: 'schedule.run', scheduleId: SCHEDULE_ID },
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

  it('no_client_ack schedule session → re-dispatches to a DIFFERENT runner, excluding the dead one', async () => {
    selectLimit.mockResolvedValueOnce([failedScheduleSession()]); // failed session fetch
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]); // project
    seedRedispatchHappy();

    const result = await redispatchScheduleSessionOnFailover('failed-sess');

    expect(result).toEqual({
      ok: true,
      status: 'redispatched',
      sessionId: 'retry-sess',
      deviceId: NEW_DEVICE,
    });
    // The dead device is excluded from the re-pick.
    const exclude = (
      findDeviceMock.mock.calls[0] as unknown as [string, { excludeDeviceIds: string[] }]
    )[1];
    expect(exclude?.excludeDeviceIds).toContain(DEAD_DEVICE);
    // Re-dispatch carries the bumped failover chain in the new session metadata.
    const insertCall = insertReturning.mock.calls.length
      ? (insertValues.mock.calls[0]?.[0] as {
          metadata?: { failover?: { attempt: number; triedDeviceIds: string[] } };
        })
      : undefined;
    expect(insertCall?.metadata?.failover?.attempt).toBe(1);
    expect(insertCall?.metadata?.failover?.triedDeviceIds).toContain(DEAD_DEVICE);
    // Re-uses the prompt from the failed session — no prompt re-build.
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

// ── ISS-548: skill-improve dispatch branching ─────────────────────────────────

describe('dispatchScheduleRun — templateKey / skill-improve path', () => {
  it('templateKey null → buildSkillImprovePrompt not called, raw prompt used', async () => {
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedDesktopHappy();

    await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'legacy raw prompt',
        runner: 'desktop',
        targetProjectSlug: null,
        templateKey: null,
      },
      actorUserId: USER_ID,
    });

    expect(buildSkillImprovePromptMock).not.toHaveBeenCalled();
    // Session still created — raw prompt path proceeds normally.
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it('templateKey set + prompt builder returns non-null → session created, metadata carries templateKey', async () => {
    buildSkillImprovePromptMock.mockReturnValue('BUILT_SKILL_IMPROVE_PROMPT');
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedDesktopHappy();

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'fallback-should-not-be-used',
        runner: 'desktop',
        targetProjectSlug: null,
        templateKey: 'merged-at-on-pass',
        mode: 'propose',
        appliedMessageVersions: null,
      },
      actorUserId: USER_ID,
    });

    expect(result.ok).toBe(true);

    // Builder called with the right args.
    expect(buildSkillImprovePromptMock).toHaveBeenCalledWith({
      templateKey: 'merged-at-on-pass',
      mode: 'propose',
      appliedMessageVersions: null,
    });

    // Session metadata carries templateKey so the completion hook can locate the schedule.
    const insertCall = insertValues.mock.calls[0]?.[0] as unknown as {
      metadata?: { templateKey?: string; source?: string; scheduleId?: string };
    };
    expect(insertCall?.metadata?.templateKey).toBe('merged-at-on-pass');
    expect(insertCall?.metadata?.source).toBe('schedule.run');
    expect(insertCall?.metadata?.scheduleId).toBe(SCHEDULE_ID);

    // Session was created and WS was published.
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it('templateKey set + prompt builder returns null → already-applied / skipped, no WS', async () => {
    buildSkillImprovePromptMock.mockReturnValue(null);

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
        templateKey: 'merged-at-on-pass',
        mode: 'propose',
        appliedMessageVersions: { 'merged-at-on-pass': 1 },
      },
      actorUserId: USER_ID,
    });

    expect(result).toEqual({ ok: false, reason: 'already-applied', status: 'skipped' });
    expect(insertValues).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('templateKey set + appliedMessageVersions forwarded to builder', async () => {
    buildSkillImprovePromptMock.mockReturnValue('PROMPT');
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedDesktopHappy();

    await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
        templateKey: 'qa-quality-bar',
        mode: 'auto',
        appliedMessageVersions: { 'some-other-key': 3 },
      },
      actorUserId: USER_ID,
    });

    expect(buildSkillImprovePromptMock).toHaveBeenCalledWith({
      templateKey: 'qa-quality-bar',
      mode: 'auto',
      appliedMessageVersions: { 'some-other-key': 3 },
    });
  });

  it('templateKey set but mode null → defaults to propose', async () => {
    buildSkillImprovePromptMock.mockReturnValue('PROMPT');
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedDesktopHappy();

    await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
        templateKey: 'merged-at-on-pass',
        mode: null,
        appliedMessageVersions: null,
      },
      actorUserId: USER_ID,
    });

    expect(buildSkillImprovePromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'propose' }),
    );
  });
});

// ── ISS-556: standing steward dispatch path ───────────────────────────────────

describe('dispatchScheduleRun — standing steward (ISS-556)', () => {
  it('standing template (optimize-skills) always dispatches — never already-applied', async () => {
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedDesktopHappy();

    // Even with appliedMessageVersions already set, standing always fires.
    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'fallback-should-not-be-used',
        runner: 'desktop',
        targetProjectSlug: null,
        templateKey: 'optimize-skills',
        mode: 'propose',
        appliedMessageVersions: { 'optimize-skills': 1 },
      },
      actorUserId: USER_ID,
    });

    expect(result.ok).toBe(true);
    // Steward builder called, NOT the one-shot builder.
    expect(buildSkillStewardPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'propose', projectId: SOURCE_PROJECT_ID }),
    );
    expect(buildSkillImprovePromptMock).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it('standing template sets metadata.steward=true so completion handler routes correctly', async () => {
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedDesktopHappy();

    await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
        templateKey: 'optimize-skills',
        mode: 'auto',
        appliedMessageVersions: null,
      },
      actorUserId: USER_ID,
    });

    const insertCall = insertValues.mock.calls[0]?.[0] as unknown as {
      metadata?: { steward?: boolean; templateKey?: string; source?: string };
    };
    expect(insertCall?.metadata?.steward).toBe(true);
    expect(insertCall?.metadata?.templateKey).toBe('optimize-skills');
    expect(insertCall?.metadata?.source).toBe('schedule.run');
  });

  it('standing template with null appliedMessageVersions still dispatches', async () => {
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedDesktopHappy();

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
        templateKey: 'optimize-skills',
        mode: 'propose',
        appliedMessageVersions: null,
      },
      actorUserId: USER_ID,
    });

    expect(result.ok).toBe(true);
    expect(buildSkillStewardPromptMock).toHaveBeenCalledTimes(1);
    expect(buildSkillImprovePromptMock).not.toHaveBeenCalled();
  });

  it('one-shot template still skips after appliedMessageVersions applied (regression guard)', async () => {
    // Explicitly return null from the one-shot builder to simulate already-applied.
    buildSkillImprovePromptMock.mockReturnValue(null);

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
        // 'merged-at-on-pass' is NOT in the registry anymore (retired) so
        // getImprovementMessage returns undefined → one-shot branch.
        templateKey: 'merged-at-on-pass',
        mode: 'propose',
        appliedMessageVersions: { 'merged-at-on-pass': 1 },
      },
      actorUserId: USER_ID,
    });

    expect(result).toEqual({ ok: false, reason: 'already-applied', status: 'skipped' });
    expect(buildSkillStewardPromptMock).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });
});

// ── ISS-568: knowledge-drift-check standing dispatch path ─────────────────────

describe('dispatchScheduleRun — knowledge drift-check (ISS-568)', () => {
  beforeEach(() => {
    buildDriftCheckPromptMock.mockReset();
    buildDriftCheckPromptMock.mockReturnValue('BUILT_DRIFT_CHECK_PROMPT');
  });

  it('drift-check key → builds drift prompt, NOT steward prompt', async () => {
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedDesktopHappy();

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'fallback-should-not-be-used',
        runner: 'desktop',
        targetProjectSlug: null,
        templateKey: 'knowledge-drift-check',
        mode: 'propose',
        appliedMessageVersions: { 'knowledge-drift-check': 1 }, // would block one-shot; standing ignores
      },
      actorUserId: USER_ID,
    });

    expect(result.ok).toBe(true);
    // Drift-check builder called with correct args.
    expect(buildDriftCheckPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'propose', projectId: SOURCE_PROJECT_ID }),
    );
    // Steward builder must NOT be called.
    expect(buildSkillStewardPromptMock).not.toHaveBeenCalled();
    // One-shot builder must NOT be called.
    expect(buildSkillImprovePromptMock).not.toHaveBeenCalled();
    // Session was created and WS was published.
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it('drift-check standing template always dispatches — never already-applied', async () => {
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedDesktopHappy();

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
        templateKey: 'knowledge-drift-check',
        mode: 'propose',
        appliedMessageVersions: { 'knowledge-drift-check': 1 },
      },
      actorUserId: USER_ID,
    });

    expect(result.ok).toBe(true);
    expect(buildDriftCheckPromptMock).toHaveBeenCalledTimes(1);
  });

  it('drift-check does NOT set metadata.steward (completion parser must skip it)', async () => {
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedDesktopHappy();

    await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
        templateKey: 'knowledge-drift-check',
        mode: 'propose',
        appliedMessageVersions: null,
      },
      actorUserId: USER_ID,
    });

    const insertCall = insertValues.mock.calls[0]?.[0] as unknown as {
      metadata?: { steward?: boolean; templateKey?: string };
    };
    // templateKey is carried for session traceability.
    expect(insertCall?.metadata?.templateKey).toBe('knowledge-drift-check');
    // steward must NOT be set — the drift-check parser is not the steward parser.
    expect(insertCall?.metadata?.steward).toBeUndefined();
  });

  it('optimize-skills (steward) still sets metadata.steward=true (regression guard)', async () => {
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedDesktopHappy();

    await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
        templateKey: 'optimize-skills',
        mode: 'propose',
        appliedMessageVersions: null,
      },
      actorUserId: USER_ID,
    });

    const insertCall = insertValues.mock.calls[0]?.[0] as unknown as {
      metadata?: { steward?: boolean };
    };
    expect(insertCall?.metadata?.steward).toBe(true);
  });
});

// ── ISS-587: product-map-refresh standing dispatch path ───────────────────────

describe('dispatchScheduleRun — product-map-refresh (ISS-587)', () => {
  beforeEach(() => {
    buildProductMapRefreshPromptMock.mockReset();
    buildProductMapRefreshPromptMock.mockReturnValue('BUILT_PRODUCT_MAP_PROMPT');
  });

  it('product-map-refresh key → builds product-map prompt, NOT steward/drift', async () => {
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedDesktopHappy();

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'fallback-should-not-be-used',
        runner: 'desktop',
        targetProjectSlug: null,
        templateKey: 'product-map-refresh',
        mode: 'auto',
        appliedMessageVersions: { 'product-map-refresh': 1 }, // standing ignores
      },
      actorUserId: USER_ID,
    });

    expect(result.ok).toBe(true);
    expect(buildProductMapRefreshPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'auto', projectId: SOURCE_PROJECT_ID }),
    );
    expect(buildSkillStewardPromptMock).not.toHaveBeenCalled();
    expect(buildDriftCheckPromptMock).not.toHaveBeenCalled();
    expect(buildSkillImprovePromptMock).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it('product-map-refresh does NOT set metadata.steward (completion parser must skip it)', async () => {
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedDesktopHappy();

    await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
        templateKey: 'product-map-refresh',
        mode: 'auto',
        appliedMessageVersions: null,
      },
      actorUserId: USER_ID,
    });

    const insertCall = insertValues.mock.calls[0]?.[0] as unknown as {
      metadata?: { steward?: boolean; templateKey?: string };
    };
    expect(insertCall?.metadata?.templateKey).toBe('product-map-refresh');
    expect(insertCall?.metadata?.steward).toBeUndefined();
  });

  it('mode null → defaults to auto', async () => {
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedDesktopHappy();

    await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
        templateKey: 'product-map-refresh',
        mode: null,
        appliedMessageVersions: null,
      },
      actorUserId: USER_ID,
    });

    expect(buildProductMapRefreshPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'auto', projectId: SOURCE_PROJECT_ID }),
    );
  });
});

// ── ISS-713: feedback-triage-digest standing dispatch path ────────────────────

describe('dispatchScheduleRun — feedback-triage-digest (ISS-713)', () => {
  beforeEach(() => {
    buildFeedbackDigestPromptMock.mockReset();
    buildFeedbackDigestPromptMock.mockReturnValue('BUILT_FEEDBACK_DIGEST_PROMPT');
  });

  it('feedback-triage-digest key → builds digest prompt, NOT steward/drift/product-map', async () => {
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedDesktopHappy();

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'fallback-should-not-be-used',
        runner: 'desktop',
        targetProjectSlug: null,
        templateKey: 'feedback-triage-digest',
        mode: 'propose',
        appliedMessageVersions: { 'feedback-triage-digest': 1 }, // standing ignores
      },
      actorUserId: USER_ID,
    });

    expect(result.ok).toBe(true);
    expect(buildFeedbackDigestPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'propose', projectId: SOURCE_PROJECT_ID }),
    );
    expect(buildSkillStewardPromptMock).not.toHaveBeenCalled();
    expect(buildDriftCheckPromptMock).not.toHaveBeenCalled();
    expect(buildProductMapRefreshPromptMock).not.toHaveBeenCalled();
    expect(buildSkillImprovePromptMock).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it('feedback-triage-digest does NOT set metadata.steward (completion parser must skip it)', async () => {
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedDesktopHappy();

    await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
        templateKey: 'feedback-triage-digest',
        mode: 'propose',
        appliedMessageVersions: null,
      },
      actorUserId: USER_ID,
    });

    const insertCall = insertValues.mock.calls[0]?.[0] as unknown as {
      metadata?: { steward?: boolean; templateKey?: string };
    };
    expect(insertCall?.metadata?.templateKey).toBe('feedback-triage-digest');
    expect(insertCall?.metadata?.steward).toBeUndefined();
  });

  it('mode null → defaults to propose', async () => {
    selectLimit.mockResolvedValueOnce([{ id: SOURCE_PROJECT_ID, slug: 'src', repoPath: '/repo' }]);
    seedDesktopHappy();

    await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: 'p',
        runner: 'desktop',
        targetProjectSlug: null,
        templateKey: 'feedback-triage-digest',
        mode: null,
        appliedMessageVersions: null,
      },
      actorUserId: USER_ID,
    });

    expect(buildFeedbackDigestPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'propose', projectId: SOURCE_PROJECT_ID }),
    );
  });
});

describe('dispatchScheduleRun — script kind (ISS-618)', () => {
  const RUN_ID = 'run-1';

  it('runs the sandboxed script, records a schedule_runs row, delivers notifications — no agent_sessions row at all', async () => {
    insertReturning.mockResolvedValueOnce([{ id: RUN_ID }]);
    runScheduleScriptMock.mockResolvedValueOnce({
      status: 'success',
      output: 'did the thing',
      notifications: [{ title: 'Daily report', body: 'all good' }],
    });

    let emitted: unknown = null;
    hooksModule.hooks.on('scheduleRun', (p) => {
      emitted = p;
    });

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: null,
        runner: 'antigravity', // deliberately not 'desktop' — script kind must not care
        targetProjectSlug: null,
        kind: 'script',
        script: 'ctx.notify({title:"Daily report", body:"all good"})',
      },
      actorUserId: USER_ID,
    });

    expect(result).toEqual({
      ok: true,
      sessionId: RUN_ID,
      status: 'success',
      resolvedProjectId: SOURCE_PROJECT_ID,
    });

    // No device resolution, no agent-session insert, no WS publish — the
    // script path never touches any of the prompt-path's collaborators.
    expect(findDeviceMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();

    // The ONE insert is the schedule_runs row (never agent_sessions).
    expect(insertValues).toHaveBeenCalledTimes(1);
    const insertCall = insertValues.mock.calls[0]?.[0] as unknown as {
      scheduleId?: string;
      projectId?: string;
      trigger?: string;
      status?: string;
    };
    expect(insertCall?.scheduleId).toBe(SCHEDULE_ID);
    expect(insertCall?.projectId).toBe(SOURCE_PROJECT_ID);
    expect(insertCall?.trigger).toBe('manual');
    expect(insertCall?.status).toBe('running');

    // Final status update on the same run row.
    const updateCall = updateSet.mock.calls[0]?.[0] as unknown as {
      status?: string;
      output?: string;
      error?: string | null;
    };
    expect(updateCall?.status).toBe('success');
    expect(updateCall?.output).toBe('did the thing');
    expect(updateCall?.error).toBeNull();

    expect(emitNotificationMock).toHaveBeenCalledTimes(1);
    expect(emitNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        projectId: SOURCE_PROJECT_ID,
        type: 'schedule_report',
        title: 'Daily report',
        body: 'all good',
      }),
    );

    expect(emitted).toMatchObject({
      scheduleId: SCHEDULE_ID,
      projectId: SOURCE_PROJECT_ID,
      sessionId: RUN_ID,
      actorUserId: USER_ID,
    });
  });

  it('tick-driven run is trigger="scheduled"', async () => {
    insertReturning.mockResolvedValueOnce([{ id: RUN_ID }]);
    runScheduleScriptMock.mockResolvedValueOnce({
      status: 'success',
      output: '',
      notifications: [],
    });

    await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: null,
        runner: 'desktop',
        targetProjectSlug: null,
        kind: 'script',
        script: 'ctx.log("hi")',
      },
      actorUserId: USER_ID,
      tick: true,
    });

    const insertCall = insertValues.mock.calls[0]?.[0] as unknown as { trigger?: string };
    expect(insertCall?.trigger).toBe('scheduled');
  });

  it('script throws → schedule_runs row recorded failed, result ok:false session-failed', async () => {
    insertReturning.mockResolvedValueOnce([{ id: RUN_ID }]);
    runScheduleScriptMock.mockResolvedValueOnce({
      status: 'failed',
      output: '',
      error: 'Error: boom',
      notifications: [],
    });

    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: null,
        runner: 'desktop',
        targetProjectSlug: null,
        kind: 'script',
        script: 'throw new Error("boom")',
      },
      actorUserId: USER_ID,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'session-failed',
      status: 'failed',
      sessionId: RUN_ID,
    });

    const updateCall = updateSet.mock.calls[0]?.[0] as unknown as {
      status?: string;
      error?: string | null;
    };
    expect(updateCall?.status).toBe('failed');
    expect(updateCall?.error).toBe('Error: boom');

    // A failed script run must not be treated as a notification-worthy report.
    expect(emitNotificationMock).not.toHaveBeenCalled();
  });

  it('no script on a kind="script" row → failed without ever calling the executor or inserting a run', async () => {
    const result = await dispatchScheduleRun({
      schedule: {
        id: SCHEDULE_ID,
        projectId: SOURCE_PROJECT_ID,
        prompt: null,
        runner: 'desktop',
        targetProjectSlug: null,
        kind: 'script',
        script: null,
      },
      actorUserId: USER_ID,
    });

    expect(result).toEqual({ ok: false, reason: 'session-failed', status: 'failed' });
    expect(runScheduleScriptMock).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });
});
