import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

// ISS-1236 — a chat turn runs in the checkout its device is bound to, read through the one
// reader, or is refused DEVICE_NOT_BOUND before anything is written.

const selectLimit = vi.fn();
const selectFrom = vi.fn(() => ({ where: vi.fn(() => ({ limit: selectLimit })) }));

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn((_values: Record<string, unknown>) => ({ where: updateWhere }));

vi.mock('../db/client.js', () => {
  const dbStub = {
    select: vi.fn(() => ({ from: selectFrom })),
    update: vi.fn(() => ({ set: updateSet })),
    execute: vi.fn(async () => []),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(dbStub)),
  };
  return { db: dbStub };
});

const findAvailableDeviceForProject = vi.fn();
const findChatCapableDeviceForProject = vi.fn();
/** Each device's own binding of the project; a device absent here has no runner row there. */
let bindings: Record<string, string | null> = {};
const readDeviceBinding = vi.fn();
vi.mock('../lib/device-pool.js', async () => {
  const { DeviceNotBoundError } =
    await vi.importActual<typeof import('../lib/device-pool.js')>('../lib/device-pool.js');
  readDeviceBinding.mockImplementation(async (projectId: string, deviceId: string) => {
    if (!(deviceId in bindings)) {
      throw new DeviceNotBoundError({ deviceId, deviceName: null, projectId, projectSlug: null });
    }
    return {
      runnerId: `runner-${deviceId}`,
      runnerType: 'claude-code',
      checkout: bindings[deviceId],
    };
  });
  return {
    DeviceNotBoundError,
    findAvailableDeviceForProject: (id: string) => findAvailableDeviceForProject(id),
    findChatCapableDeviceForProject: (
      projectId: string,
      deviceId: string,
      opts?: { allowLimited?: boolean },
    ) => findChatCapableDeviceForProject(projectId, deviceId, opts),
    readDeviceBinding: (projectId: string, deviceId: string) =>
      readDeviceBinding(projectId, deviceId),
  };
});

vi.mock('../lib/chat-preamble.js', () => ({
  buildChatPreamble: vi.fn(async () => '[Preamble]\n'),
  TOOL_REFERENCE: '<tool-reference>',
}));

const resolveProjectDefaultMcpServers = vi.fn(async (_id: string) => ({
  servers: { playwright: { type: 'stdio' } },
  declaredNames: ['playwright'],
}));
vi.mock('../jobs/stage-overrides.js', () => ({
  resolveProjectDefaultMcpServers: (id: string) => resolveProjectDefaultMcpServers(id),
}));

const publishSpy = vi.fn((..._args: unknown[]) => 1);
vi.mock('../ws/server.js', () => ({ roomManager: { publish: publishSpy } }));
vi.mock('../ws/rooms.js', () => ({
  deviceRoom: (id: string) => `device:${id}`,
  projectRoom: (id: string) => `project:${id}`,
}));

vi.mock('./broadcast.js', () => ({
  broadcastSession: vi.fn(),
  broadcastTurnAppended: vi.fn(),
}));
const applyAutoTitleAsyncSpy = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./auto-title.js', () => ({
  applyAutoTitleAsync: (...args: unknown[]) => applyAutoTitleAsyncSpy(...args),
}));
const syncTurnsSpy = vi.fn(async () => ({ appended: [], truncatedFromTurnIndex: null }));
vi.mock('./turns-helpers.js', () => ({
  syncTurnsWithMessages: (...args: unknown[]) => syncTurnsSpy(...(args as [])),
}));
(await import('../integrations/register-all.js')).registerAllIntegrations();
vi.mock('../pipeline/runs.js', () => ({
  openOneShotRun: vi.fn(async () => ({ id: 'run-1' })),
}));

const { resolveChatDevice, dispatchChatTurn } = await import('./chat-turn.js');

const PROJECT = { id: 'proj-1', slug: 'apiflow' };
const DEVICE = 'dev-1';
const ON_DEV_1 = '/repo/on/dev-1';
const ON_DEV_2 = '/repo/on/dev-2';

/** The data of the one frame of `event` this turn published, refused when there is none. */
function frameData(event: string): { repoPath?: string | null } {
  const call = publishSpy.mock.calls.find((c) => (c[1] as { event: string }).event === event);
  if (!call) throw new Error(`no ${event} frame was published`);
  return (call[1] as { data: { repoPath?: string | null } }).data;
}

function baseSession(over: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    projectId: PROJECT.id,
    userId: 'user-1',
    deviceId: null,
    pipelineRunId: 'run-1',
    title: 'Chat',
    status: 'idle',
    repoPath: null,
    claudeSessionId: null,
    messages: [],
    metadata: null,
    startedAt: null,
    lastHeartbeatAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  updateReturning.mockReset();
  findAvailableDeviceForProject.mockReset();
  findChatCapableDeviceForProject.mockReset();
  bindings = { [DEVICE]: ON_DEV_1, 'dev-2': ON_DEV_2 };
});

describe('resolveChatDevice — a device is handed its own checkout or refused (ISS-1236)', () => {
  it('reads the checkout from the binding of the device it picked', async () => {
    findAvailableDeviceForProject.mockResolvedValueOnce('dev-2');
    const r = await resolveChatDevice(baseSession(), undefined);
    expect(readDeviceBinding).toHaveBeenCalledWith(PROJECT.id, 'dev-2');
    expect(r.checkout).toBe(ON_DEV_2);
  });

  it('refuses DEVICE_NOT_BOUND when the auto-picked device has no runner row for the project', async () => {
    findAvailableDeviceForProject.mockResolvedValueOnce('dev-unbound');
    const refused = await resolveChatDevice(baseSession(), undefined).catch((e: unknown) => e);
    expect(refused).toMatchObject({
      status: 409,
      cause: {
        code: 'DEVICE_NOT_BOUND',
        details: { deviceId: 'dev-unbound', projectId: PROJECT.id },
      },
    });
    expect(String((refused as Error).message)).toContain('forge-runner bind');
  });

  it('refuses an explicit pick of an unbound device as DEVICE_NOT_BOUND, before the capability check', async () => {
    const refused = await resolveChatDevice(baseSession(), undefined, 'dev-unbound').catch(
      (e: unknown) => e,
    );
    expect(refused).toMatchObject({ cause: { code: 'DEVICE_NOT_BOUND' } });
    expect(findChatCapableDeviceForProject).not.toHaveBeenCalled();
  });

  it('refuses an online pin whose runner row is gone, instead of handing it a path', async () => {
    bindings = {};
    findChatCapableDeviceForProject.mockResolvedValue(null);
    selectLimit.mockResolvedValueOnce([{ status: 'online', disabledAt: null }]);
    const refused = await resolveChatDevice(
      baseSession({ metadata: { deviceId: DEVICE } }),
      undefined,
    ).catch((e: unknown) => e);
    expect(refused).toMatchObject({ cause: { code: 'DEVICE_NOT_BOUND' } });
  });

  it('hands a binding with no recorded path through as null', async () => {
    bindings = { [DEVICE]: null };
    findAvailableDeviceForProject.mockResolvedValueOnce(DEVICE);
    const r = await resolveChatDevice(baseSession(), undefined);
    expect(r).toEqual({ deviceId: DEVICE, isLocal: false, migrated: false, checkout: null });
  });
});

describe('dispatchChatTurn — the frame carries the device binding (ISS-1236)', () => {
  it("a migrated turn's frame carries the NEW device's binding, not the old box's path (ISS-755, ISS-1236)", async () => {
    updateReturning.mockResolvedValueOnce([
      baseSession({ status: 'running', deviceId: 'dev-2', claudeSessionId: null }),
    ]);
    await dispatchChatTurn({
      session: baseSession({
        claudeSessionId: 'c-1',
        deviceId: DEVICE,
        metadata: { deviceId: DEVICE },
        repoPath: ON_DEV_1,
        messages: [{ type: 'user', content: 'hi' }],
      }),
      project: PROJECT,
      client: { deviceId: 'dev-2', isLocal: false, migrated: true, checkout: ON_DEV_2 },
      message: 'again on the new box',
    });
    const updates = updateSet.mock.calls[0]?.[0] as { repoPath?: string | null };
    expect(updates.repoPath).toBe(ON_DEV_2);
    expect(frameData('agent:start').repoPath).toBe(ON_DEV_2);
  });

  it('a follow-up on the same device sends its CURRENT binding, not the path the session recorded earlier (ISS-1236 criterion 9)', async () => {
    updateReturning.mockResolvedValueOnce([
      baseSession({ status: 'running', deviceId: DEVICE, claudeSessionId: 'c-1' }),
    ]);
    await dispatchChatTurn({
      session: baseSession({
        claudeSessionId: 'c-1',
        deviceId: DEVICE,
        repoPath: '/where/dev-1/used/to/keep/it',
        messages: [{ type: 'user', content: 'a' }],
      }),
      project: PROJECT,
      client: { deviceId: DEVICE, isLocal: false, migrated: false, checkout: ON_DEV_1 },
      message: 'again',
    });
    const updates = updateSet.mock.calls[0]?.[0] as { repoPath?: string | null };
    expect(updates.repoPath).toBe(ON_DEV_1);
    expect(frameData('agent:send').repoPath).toBe(ON_DEV_1);
  });

  it('a binding that records no path sends none, so the device answers from its own config (ISS-1236 criterion 8)', async () => {
    updateReturning.mockResolvedValueOnce([baseSession({ status: 'running', deviceId: DEVICE })]);
    await dispatchChatTurn({
      session: baseSession(),
      project: PROJECT,
      client: { deviceId: DEVICE, isLocal: false, migrated: false, checkout: null },
      message: 'hello',
    });
    expect(frameData('agent:start').repoPath).toBeNull();
  });

  it('a local (desktop) turn keeps the path its own caller gave the session', async () => {
    updateReturning.mockResolvedValueOnce([baseSession({ status: 'running' })]);
    await dispatchChatTurn({
      session: baseSession({ repoPath: '/home/me/my-checkout' }),
      project: PROJECT,
      client: { deviceId: null, isLocal: true, checkout: null },
      message: 'hi',
    });
    const updates = updateSet.mock.calls[0]?.[0] as { repoPath?: string | null };
    expect(updates.repoPath).toBe('/home/me/my-checkout');
  });
});
