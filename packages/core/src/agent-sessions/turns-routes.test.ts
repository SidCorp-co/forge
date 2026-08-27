import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  },
}));

const ensureSessionOwnerOrAdmin = vi.fn();
vi.mock('./session-access.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-access.js')>()),
  ensureSessionOwnerOrAdmin: (...args: unknown[]) => ensureSessionOwnerOrAdmin(...args),
}));

const createChatSessionRow = vi.fn();
const dispatchChatTurn = vi.fn();
const resolveChatDevice = vi.fn();
vi.mock('./chat-turn.js', () => ({
  createChatSessionRow: (...args: unknown[]) => createChatSessionRow(...args),
  dispatchChatTurn: (...args: unknown[]) => dispatchChatTurn(...args),
  noClaudeClient: () =>
    new HTTPException(409, {
      message: 'No online Claude client for this session.',
      cause: { code: 'NO_CLAUDE_CLIENT' },
    }),
  resolveChatDevice: (...args: unknown[]) => resolveChatDevice(...args),
}));

vi.mock('./session-activity.js', () => ({
  recordSessionCreatedActivity: vi.fn(async () => undefined),
}));

const { agentSessionTurnsRoutes } = await import('./turns-routes.js');

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';

function session(over: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    userId: '33333333-3333-4333-8333-333333333333',
    status: 'idle',
    title: 'Original chat',
    messages: [{ role: 'user', content: 'original prompt' }],
    metadata: { model: 'default' },
    updatedAt: new Date('2026-08-27T00:00:00.000Z'),
    ...over,
  };
}

function app() {
  const router = new Hono();
  router.route('/api/agent-sessions', agentSessionTurnsRoutes);
  router.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json(
        { code: (err.cause as { code?: string } | undefined)?.code ?? null },
        err.status,
      );
    }
    throw err;
  });
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  ensureSessionOwnerOrAdmin.mockReset();
  createChatSessionRow.mockReset();
  dispatchChatTurn.mockReset();
  resolveChatDevice.mockReset();
});

describe('POST /:id/rerun', () => {
  it.each(['running', 'queued'])('rejects a %s source session', async (status) => {
    ensureSessionOwnerOrAdmin.mockResolvedValueOnce({ session: session({ status }) });

    const res = await app().request(`/api/agent-sessions/${SESSION_ID}/rerun`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(resolveChatDevice).not.toHaveBeenCalled();
    expect(createChatSessionRow).not.toHaveBeenCalled();
  });

  it('fails before creating a child session when no chat runner is available', async () => {
    ensureSessionOwnerOrAdmin.mockResolvedValueOnce({ session: session() });
    resolveChatDevice.mockResolvedValueOnce({ deviceId: null, isLocal: false });

    const res = await app().request(`/api/agent-sessions/${SESSION_ID}/rerun`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(createChatSessionRow).not.toHaveBeenCalled();
    expect(dispatchChatTurn).not.toHaveBeenCalled();
  });

  it('reuses the canonical dispatcher with the copied model selection', async () => {
    const original = session();
    const child = { id: 'child-session', projectId: PROJECT_ID, metadata: original.metadata };
    const updated = { ...child, status: 'running' };
    ensureSessionOwnerOrAdmin.mockResolvedValueOnce({ session: original });
    resolveChatDevice.mockResolvedValueOnce({ deviceId: 'device-1', isLocal: false });
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, slug: 'project', repoPath: '/repo' }]);
    createChatSessionRow.mockResolvedValueOnce(child);
    dispatchChatTurn.mockResolvedValueOnce(updated);

    const res = await app().request(`/api/agent-sessions/${SESSION_ID}/rerun`, { method: 'POST' });

    expect(res.status).toBe(201);
    expect(createChatSessionRow).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      userId: original.userId,
      title: 'Original chat (rerun)',
      metadata: { model: 'default', rerunOfSessionId: SESSION_ID },
    });
    expect(dispatchChatTurn).toHaveBeenCalledWith({
      session: child,
      project: { id: PROJECT_ID, slug: 'project', repoPath: '/repo' },
      client: { deviceId: 'device-1', isLocal: false },
      message: 'original prompt',
      broadcastEvent: 'agent-session.created',
    });
  });
});
