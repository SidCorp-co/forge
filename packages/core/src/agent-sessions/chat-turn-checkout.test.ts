import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

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
const resolveSessionRepoPathForDevice = vi.fn(
  async (_projectId: string, deviceId: string | null): Promise<string | null> =>
    deviceId ? '/repo' : null,
);
vi.mock('../lib/device-pool.js', () => ({
  findAvailableDeviceForProject: (id: string) => findAvailableDeviceForProject(id),
  findChatCapableDeviceForProject: (
    projectId: string,
    deviceId: string,
    opts?: { allowLimited?: boolean },
  ) => findChatCapableDeviceForProject(projectId, deviceId, opts),
  resolveSessionRepoPathForDevice: (projectId: string, deviceId: string | null) =>
    resolveSessionRepoPathForDevice(projectId, deviceId),
}));

vi.mock('../lib/chat-preamble.js', () => ({
  buildChatPreamble: vi.fn(async () => '[Preamble]\n'),
  TOOL_REFERENCE: '<tool-reference>',
}));

vi.mock('../jobs/resolve-job-mcp-servers.js', () => ({
  resolveSessionMcpServers: async () => ({
    mcpServers: { playwright: { type: 'stdio' } },
    resolvedNames: ['playwright'],
    integrationServers: [{ name: 'playwright', bindingId: 'b-1' }],
  }),
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

const { dispatchChatTurn } = await import('./chat-turn.js');

const PROJECT = { id: 'proj-1', slug: 'apiflow' };
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
  findChatCapableDeviceForProject.mockReset();
});

describe("dispatchChatTurn — the checkout is the device binding's (ISS-755, ISS-14)", () => {
  it("migration recomputes repoPath for the NEW device instead of reusing the old box's stale path (ISS-755 bug guard)", async () => {
    updateReturning.mockResolvedValueOnce([
      baseSession({ status: 'running', deviceId: 'dev-2', claudeSessionId: null }),
    ]);
    resolveSessionRepoPathForDevice.mockResolvedValueOnce('/repo/on/dev-2');
    await dispatchChatTurn({
      session: baseSession({
        claudeSessionId: 'c-1',
        deviceId: DEVICE,
        metadata: { deviceId: DEVICE },
        repoPath: '/repo/on/dev-1',
        messages: [{ type: 'user', content: 'hi' }],
      }),
      project: PROJECT,
      client: { deviceId: 'dev-2', isLocal: false, migrated: true },
      message: 'again on the new box',
    });
    expect(resolveSessionRepoPathForDevice).toHaveBeenCalledWith(PROJECT.id, 'dev-2');
    const updates = updateSet.mock.calls[0]?.[0] as { repoPath?: string | null };
    expect(updates.repoPath).toBe('/repo/on/dev-2');
    expect(updates.repoPath).not.toBe('/repo/on/dev-1');
  });

  it('refuses a remote turn whose device binding names no checkout, and publishes nothing', async () => {
    resolveSessionRepoPathForDevice.mockResolvedValueOnce(null);
    await expect(
      dispatchChatTurn({
        session: baseSession({ deviceId: DEVICE, repoPath: null }),
        project: PROJECT,
        client: { deviceId: DEVICE, isLocal: false, migrated: false },
        message: 'hello',
      }),
    ).rejects.toThrow(
      /CHECKOUT_UNBOUND: device dev-1's binding to project proj-1 names no checkout/,
    );
    expect(publishSpy).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('no device change + session.repoPath already set → NOT re-resolved (no extra query)', async () => {
    updateReturning.mockResolvedValueOnce([
      baseSession({ status: 'running', deviceId: DEVICE, claudeSessionId: 'c-1' }),
    ]);
    await dispatchChatTurn({
      session: baseSession({
        claudeSessionId: 'c-1',
        deviceId: DEVICE,
        repoPath: '/repo/on/dev-1',
        messages: [{ type: 'user', content: 'a' }],
      }),
      project: PROJECT,
      client: { deviceId: DEVICE, isLocal: false, migrated: false },
      message: 'again',
    });
    expect(resolveSessionRepoPathForDevice).not.toHaveBeenCalled();
    const updates = updateSet.mock.calls[0]?.[0] as { repoPath?: string | null };
    expect(updates.repoPath).toBe('/repo/on/dev-1');
  });
});
