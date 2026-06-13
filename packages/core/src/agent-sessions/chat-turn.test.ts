import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for the SINGLE chat-turn dispatcher — the logic /start, /send and
// schedule.run all share. The behaviour that matters: a cold session (no
// claudeSessionId) starts a fresh Claude run (`agent:start`); a warm one
// follows up (`agent:send`); device resolution self-heals a dead pin; desktop
// stays local.

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));

vi.mock('../db/client.js', () => {
  const dbStub = {
    select: vi.fn(() => ({ from: selectFrom })),
    update: vi.fn(() => ({ set: updateSet })),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(dbStub)),
  };
  return { db: dbStub };
});

const findAvailableDeviceForProject = vi.fn();
vi.mock('../lib/device-pool.js', () => ({
  findAvailableDeviceForProject: (id: string) => findAvailableDeviceForProject(id),
  resolveRepoPath: (override: string | null | undefined, repo: string | null) =>
    (override ?? repo ?? '').trim() || null,
  resolveRunnerRepoPath: () => Promise.resolve(null),
}));

vi.mock('../lib/chat-preamble.js', () => ({
  buildChatPreamble: vi.fn(async () => '[Preamble]\n'),
  TOOL_REFERENCE: '<tool-reference>',
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
const syncTurnsSpy = vi.fn(async () => ({ appended: [], truncatedFromTurnIndex: null }));
vi.mock('./turns-helpers.js', () => ({
  syncTurnsWithMessages: (...args: unknown[]) => syncTurnsSpy(...(args as [])),
}));
vi.mock('../pipeline/runs.js', () => ({
  openOneShotRun: vi.fn(async () => ({ id: 'run-1' })),
}));

const { resolveChatDevice, dispatchChatTurn } = await import('./chat-turn.js');

const PROJECT = { id: 'proj-1', slug: 'apiflow', repoPath: '/repo' };
const DEVICE = 'dev-1';

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
});

describe('resolveChatDevice', () => {
  it('desktop origin → local, no device', async () => {
    const r = await resolveChatDevice(baseSession(), 'desktop');
    expect(r).toEqual({ deviceId: null, isLocal: true });
    expect(findAvailableDeviceForProject).not.toHaveBeenCalled();
  });

  it('no pin → picks a fresh online runner', async () => {
    findAvailableDeviceForProject.mockResolvedValueOnce(DEVICE);
    const r = await resolveChatDevice(baseSession(), undefined);
    expect(r).toEqual({ deviceId: DEVICE, isLocal: false });
  });

  it('online pin → reuses it (no re-pick)', async () => {
    selectLimit.mockResolvedValueOnce([{ status: 'online' }]);
    const r = await resolveChatDevice(baseSession({ metadata: { deviceId: DEVICE } }), undefined);
    expect(r).toEqual({ deviceId: DEVICE, isLocal: false });
    expect(findAvailableDeviceForProject).not.toHaveBeenCalled();
  });

  it('offline pin → self-heals to a fresh online runner', async () => {
    selectLimit.mockResolvedValueOnce([{ status: 'offline' }]);
    findAvailableDeviceForProject.mockResolvedValueOnce('dev-2');
    const r = await resolveChatDevice(baseSession({ metadata: { deviceId: DEVICE } }), undefined);
    expect(r).toEqual({ deviceId: 'dev-2', isLocal: false });
  });

  it('offline pin + empty pool → null (caller 409s)', async () => {
    selectLimit.mockResolvedValueOnce([{ status: 'offline' }]);
    findAvailableDeviceForProject.mockResolvedValueOnce(null);
    const r = await resolveChatDevice(baseSession({ metadata: { deviceId: DEVICE } }), undefined);
    expect(r).toEqual({ deviceId: null, isLocal: false });
  });
});

describe('dispatchChatTurn', () => {
  it('cold session (no claudeSessionId) → agent:start with system prompt + preamble', async () => {
    updateReturning.mockResolvedValueOnce([baseSession({ status: 'running', deviceId: DEVICE })]);
    await dispatchChatTurn({
      session: baseSession(),
      project: PROJECT,
      client: { deviceId: DEVICE, isLocal: false },
      message: 'hello',
    });
    const call = publishSpy.mock.calls.find(
      ([room, env]) => room === `device:${DEVICE}` && (env as { event: string }).event === 'agent:start',
    );
    expect(call).toBeDefined();
    const data = (call![1] as { data: Record<string, unknown> }).data;
    expect(data.systemPrompt).toBe('<tool-reference>');
    expect(String(data.prompt)).toContain('hello');
    expect(String(data.prompt)).toContain('[Preamble]');
  });

  it('warm session (claudeSessionId set) → agent:send, no system prompt', async () => {
    updateReturning.mockResolvedValueOnce([
      baseSession({ status: 'running', deviceId: DEVICE, claudeSessionId: 'c-1' }),
    ]);
    await dispatchChatTurn({
      session: baseSession({ claudeSessionId: 'c-1', messages: [{ role: 'user', content: 'a' }] }),
      project: PROJECT,
      client: { deviceId: DEVICE, isLocal: false },
      message: 'again',
    });
    const call = publishSpy.mock.calls.find(
      ([room, env]) => room === `device:${DEVICE}` && (env as { event: string }).event === 'agent:send',
    );
    expect(call).toBeDefined();
    const data = (call![1] as { data: Record<string, unknown> }).data;
    expect(data.message).toBe('again');
    expect(data.claudeSessionId).toBe('c-1');
    expect(data.systemPrompt).toBeUndefined();
  });

  it('local (desktop) → mirrors agent:user-message, no device dispatch', async () => {
    updateReturning.mockResolvedValueOnce([baseSession({ status: 'running' })]);
    await dispatchChatTurn({
      session: baseSession(),
      project: PROJECT,
      client: { deviceId: null, isLocal: true },
      message: 'hi',
      origin: 'desktop',
    });
    const mirror = publishSpy.mock.calls.find(
      ([room, env]) =>
        room === `project:${PROJECT.id}` && (env as { event: string }).event === 'agent:user-message',
    );
    expect(mirror).toBeDefined();
    const started = publishSpy.mock.calls.find(
      ([, env]) => (env as { event: string }).event === 'agent:start',
    );
    expect(started).toBeUndefined();
  });

  it('persists the user turn (syncTurnsWithMessages) before dispatch (Bug 1 guard)', async () => {
    updateReturning.mockResolvedValueOnce([baseSession({ status: 'running', deviceId: DEVICE })]);
    await dispatchChatTurn({
      session: baseSession(),
      project: PROJECT,
      client: { deviceId: DEVICE, isLocal: false },
      message: 'hello',
    });
    expect(syncTurnsSpy).toHaveBeenCalledTimes(1);
    const [, prev, next] = syncTurnsSpy.mock.calls[0] as unknown as [
      string,
      unknown[],
      Array<Record<string, unknown>>,
    ];
    expect(prev).toEqual([]);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ role: 'user', content: 'hello' });
    // The user turn is materialized as part of the same update that flips the
    // session to running — never after dispatch.
    const updates = updateSet.mock.calls[0]![0] as { messages: unknown[]; status: string };
    expect(updates.status).toBe('running');
    expect(updates.messages).toHaveLength(1);
  });

  it('auto-titles a first turn on an untitled "Chat" session from the raw message (Bug 3)', async () => {
    updateReturning.mockResolvedValueOnce([baseSession({ status: 'running', deviceId: DEVICE })]);
    await dispatchChatTurn({
      session: baseSession({ title: 'Chat' }),
      project: PROJECT,
      client: { deviceId: DEVICE, isLocal: false },
      message: '  What files   are\nin this repo?  ',
    });
    const updates = updateSet.mock.calls[0]![0] as { title?: string };
    expect(updates.title).toBe('What files are in this repo?');
  });

  it('does NOT title a follow-up turn (claudeSessionId set)', async () => {
    updateReturning.mockResolvedValueOnce([
      baseSession({ status: 'running', deviceId: DEVICE, claudeSessionId: 'c-1' }),
    ]);
    await dispatchChatTurn({
      session: baseSession({
        title: 'Chat',
        claudeSessionId: 'c-1',
        messages: [{ role: 'user', content: 'first' }],
      }),
      project: PROJECT,
      client: { deviceId: DEVICE, isLocal: false },
      message: 'second message',
    });
    const updates = updateSet.mock.calls[0]![0] as { title?: string };
    expect(updates.title).toBeUndefined();
  });

  it('does NOT overwrite a user-renamed title on the first turn', async () => {
    updateReturning.mockResolvedValueOnce([baseSession({ status: 'running', deviceId: DEVICE })]);
    await dispatchChatTurn({
      session: baseSession({ title: 'My important chat' }),
      project: PROJECT,
      client: { deviceId: DEVICE, isLocal: false },
      message: 'hello there',
    });
    const updates = updateSet.mock.calls[0]![0] as { title?: string };
    expect(updates.title).toBeUndefined();
  });
});
