// ISS-718 — the model half of the chat-turn dispatcher, in its own file because
// chat-turn.test.ts is frozen at its current length in .forge/size-baseline.json.
// What matters: the picked model reaches BOTH dispatch frames, an explicit pick
// is remembered on the session, an explicit null selects Claude Code's Default,
// and a later turn that carries no override inherits it instead of silently
// falling back to the configured default.
//
// `config/env.js` is stubbed because it throws at import when DATABASE_URL /
// JWT_SECRET / DEVICE_TOKEN_PEPPER are absent, and this suite must stay hermetic.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn((_values: Record<string, unknown>) => ({ where: updateWhere }));

vi.mock('../db/client.js', () => {
  const dbStub = {
    select: vi.fn(() => ({ from: selectFrom })),
    update: vi.fn(() => ({ set: updateSet })),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(dbStub)),
  };
  return { db: dbStub };
});

vi.mock('../lib/device-pool.js', () => ({
  findAvailableDeviceForProject: vi.fn(async () => null),
  findChatCapableDeviceForProject: vi.fn(async () => null),
  resolveSessionRepoPathForDevice: vi.fn(
    async (_projectId: string, _deviceId: string | null, repo: string | null) => repo ?? null,
  ),
}));

vi.mock('../lib/chat-preamble.js', () => ({
  buildChatPreamble: vi.fn(async () => '[Preamble]\n'),
  TOOL_REFERENCE: '<tool-reference>',
}));

vi.mock('../jobs/stage-overrides.js', () => ({
  resolveProjectDefaultMcpServers: vi.fn(async () => ({ servers: {}, declaredNames: [] })),
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
vi.mock('./auto-title.js', () => ({ applyAutoTitleAsync: vi.fn(async () => undefined) }));
vi.mock('./turns-helpers.js', () => ({
  syncTurnsWithMessages: vi.fn(async () => ({ appended: [], truncatedFromTurnIndex: null })),
}));
vi.mock('../pipeline/runs.js', () => ({ openOneShotRun: vi.fn(async () => ({ id: 'run-1' })) }));
// cm:why the ISS-927 mint writes through the module-level `db`, which this suite stubs as a single shared spy — unmocked, its UPDATE lands in `updateSet` and `writtenMetadata()` reads it back as if it were the session write.
vi.mock('./session-token.js', () => ({
  mintSessionToken: vi.fn(async () => 'forge_pat_dev_x'),
  isUnattendedSession: () => false,
}));

const { dispatchChatTurn } = await import('./chat-turn.js');

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

/** The data payload of the last frame published for `event`. */
function frame(event: 'agent:start' | 'agent:send'): Record<string, unknown> {
  const calls = publishSpy.mock.calls.filter(
    ([room, env]) => room === `device:${DEVICE}` && (env as { event: string }).event === event,
  );
  const last = calls.at(-1);
  if (!last) throw new Error(`no ${event} frame was published`);
  return (last[1] as { data: Record<string, unknown> }).data;
}

/** The metadata object written by the turn's UPDATE. */
function writtenMetadata(): Record<string, unknown> {
  const call = updateSet.mock.calls.at(-1);
  if (!call) throw new Error('no session update was written');
  return (call[0] as { metadata: Record<string, unknown> }).metadata;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  updateReturning.mockReset();
});

describe('dispatchChatTurn — model transport', () => {
  it('sends nothing when no model was ever picked (the runner default stands)', async () => {
    updateReturning.mockResolvedValueOnce([baseSession({ deviceId: DEVICE })]);
    await dispatchChatTurn({
      session: baseSession(),
      project: PROJECT,
      client: { deviceId: DEVICE, isLocal: false },
      message: 'hello',
    });
    expect(frame('agent:start')).not.toHaveProperty('model');
    expect(writtenMetadata()).not.toHaveProperty('model');
  });

  it('an explicit pick rides the cold-start frame and is remembered on the session', async () => {
    updateReturning.mockResolvedValueOnce([baseSession({ deviceId: DEVICE })]);
    await dispatchChatTurn({
      session: baseSession(),
      project: PROJECT,
      client: { deviceId: DEVICE, isLocal: false },
      message: 'hello',
      model: 'opus',
    });
    expect(frame('agent:start').model).toBe('opus');
    expect(writtenMetadata().model).toBe('opus');
  });

  it('a resumed follow-up carries the model too — the frame that used to drop it', async () => {
    updateReturning.mockResolvedValueOnce([baseSession({ deviceId: DEVICE })]);
    await dispatchChatTurn({
      session: baseSession({
        claudeSessionId: 'c-1',
        deviceId: DEVICE,
        messages: [{ role: 'user', content: 'a' }],
      }),
      project: PROJECT,
      client: { deviceId: DEVICE, isLocal: false },
      message: 'again',
      model: 'haiku',
    });
    const data = frame('agent:send');
    expect(data.claudeSessionId).toBe('c-1');
    expect(data.model).toBe('haiku');
  });

  it('a turn with no override inherits the remembered model', async () => {
    updateReturning.mockResolvedValueOnce([baseSession({ deviceId: DEVICE })]);
    await dispatchChatTurn({
      session: baseSession({
        claudeSessionId: 'c-1',
        deviceId: DEVICE,
        metadata: { deviceId: DEVICE, model: 'sonnet' },
        messages: [{ role: 'user', content: 'a' }],
      }),
      project: PROJECT,
      client: { deviceId: DEVICE, isLocal: false },
      message: 'again',
    });
    expect(frame('agent:send').model).toBe('sonnet');
    // cm:why inheriting must not rewrite the marker — only an explicit pick does
    expect(writtenMetadata().model).toBe('sonnet');
  });

  it('a new pick overwrites the remembered one', async () => {
    updateReturning.mockResolvedValueOnce([baseSession({ deviceId: DEVICE })]);
    await dispatchChatTurn({
      session: baseSession({
        claudeSessionId: 'c-1',
        deviceId: DEVICE,
        metadata: { deviceId: DEVICE, model: 'sonnet' },
        messages: [{ role: 'user', content: 'a' }],
      }),
      project: PROJECT,
      client: { deviceId: DEVICE, isLocal: false },
      message: 'again',
      model: 'opus',
    });
    expect(frame('agent:send').model).toBe('opus');
    expect(writtenMetadata().model).toBe('opus');
  });

  it('an explicit null emits the Claude Code default model instead of inheriting the resumed model', async () => {
    updateReturning.mockResolvedValueOnce([baseSession({ deviceId: DEVICE })]);
    await dispatchChatTurn({
      session: baseSession({
        claudeSessionId: 'c-1',
        deviceId: DEVICE,
        metadata: { deviceId: DEVICE, model: 'opus' },
        messages: [{ role: 'user', content: 'a' }],
      }),
      project: PROJECT,
      client: { deviceId: DEVICE, isLocal: false },
      message: 'again',
      model: null,
    });
    expect(frame('agent:send').model).toBe('default');
    expect(writtenMetadata().model).toBe('default');
  });

  it('keeps an explicit default on later omitted sends', async () => {
    updateReturning.mockResolvedValueOnce([baseSession({ deviceId: DEVICE })]);
    await dispatchChatTurn({
      session: baseSession({
        claudeSessionId: 'c-1',
        deviceId: DEVICE,
        metadata: { deviceId: DEVICE, model: 'default' },
        messages: [{ role: 'user', content: 'a' }],
      }),
      project: PROJECT,
      client: { deviceId: DEVICE, isLocal: false },
      message: 'again',
    });
    expect(frame('agent:send').model).toBe('default');
  });

  it('a garbage metadata.model reads as no selection rather than being forwarded', async () => {
    updateReturning.mockResolvedValueOnce([baseSession({ deviceId: DEVICE })]);
    await dispatchChatTurn({
      session: baseSession({
        claudeSessionId: 'c-1',
        deviceId: DEVICE,
        metadata: { deviceId: DEVICE, model: 'gpt-4' },
        messages: [{ role: 'user', content: 'a' }],
      }),
      project: PROJECT,
      client: { deviceId: DEVICE, isLocal: false },
      message: 'again',
    });
    expect(frame('agent:send')).not.toHaveProperty('model');
  });

  it('a migrated cold start re-sends the remembered model — the new box has no session file', async () => {
    updateReturning.mockResolvedValueOnce([baseSession({ deviceId: DEVICE })]);
    await dispatchChatTurn({
      session: baseSession({
        claudeSessionId: 'c-old',
        deviceId: 'dev-0',
        metadata: { deviceId: 'dev-0', model: 'opus' },
        messages: [{ role: 'user', content: 'a' }],
      }),
      project: PROJECT,
      client: { deviceId: DEVICE, isLocal: false, migrated: true },
      message: 'again',
    });
    expect(frame('agent:start').model).toBe('opus');
  });
});
