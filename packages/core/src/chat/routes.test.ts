import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

const updateWhere = vi.fn(() => Promise.resolve(undefined));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const dbInsert = vi.fn(() => ({ values: insertValues }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    update: dbUpdate,
    insert: dbInsert,
  },
}));

const { chatRoutes } = await import('./routes.js');
const { clearProviders, register } = await import('./providers/registry.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
const { isEnabled } = await import('../lib/feature-flags.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '99999999-9999-4999-8999-999999999999';

function buildApp(opts: { mountChat: boolean }) {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  if (opts.mountChat) {
    app.route('/api/chat', chatRoutes);
  }
  app.onError(errorHandler);
  return app;
}

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

function projectAccessAsMember() {
  selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, ownerId: 'someone-else' }]);
  selectLimit.mockResolvedValueOnce([{ role: 'member' }]);
}

function projectInfoRow(
  row: {
    id?: string;
    slug?: string;
    name?: string;
    agentConfig?: unknown;
  } | null = {},
) {
  selectLimit.mockResolvedValueOnce(
    row
      ? [
          {
            id: row.id ?? PROJECT_ID,
            slug: row.slug ?? 'forge-dev',
            name: row.name ?? 'Forge Dev',
            agentConfig: row.agentConfig ?? null,
          },
        ]
      : [],
  );
}

function appConfigOverrideRow(systemPromptOverride: string | null) {
  selectLimit.mockResolvedValueOnce([{ systemPromptOverride }]);
}

function appConfigProviderRow(row: { chatProviderId: string | null; chatModel: string | null }) {
  selectLimit.mockResolvedValueOnce([row]);
}

function sessionRow(messages: unknown[] = []) {
  selectLimit.mockResolvedValueOnce([
    {
      id: SESSION_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      source: 'web',
      messages,
    },
  ]);
}

function newSessionInsert() {
  insertReturning.mockResolvedValueOnce([
    {
      id: SESSION_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      source: 'web',
      messages: [],
    },
  ]);
}

function chatLogsInsert() {
  // chat_logs insert path uses `.values(...)` only (no `.returning`).
  // Ensure the mock resolves to keep the default thenable from blocking.
}

async function token() {
  return signUserToken(USER_ID);
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  insertReturning.mockReset();
  insertValues.mockClear();
  updateSet.mockClear();
  updateWhere.mockClear();
  dbInsert.mockClear();
  dbUpdate.mockClear();
  // values() is both a Promise (chat_logs path: `await db.insert(...).values(...)`)
  // AND has a `.returning()` method (chat_sessions path).
  insertValues.mockImplementation((() => {
    const p = Promise.resolve(undefined) as Promise<undefined> & {
      returning: typeof insertReturning;
    };
    p.returning = insertReturning;
    return p;
  }) as never);
  clearProviders();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('FEATURE_')) delete process.env[k];
  }
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('FEATURE_')) delete process.env[k];
  }
});

describe('feature flag gate', () => {
  it('chatProvider flag default is on (FEATURE_CHAT_PROVIDER unset)', () => {
    // Commit 2020bda8 flipped all v0.1.x alpha flags to default-on. The
    // test still pins the *runtime override* below — toggling
    // FEATURE_CHAT_PROVIDER=false continues to disable the route.
    expect(isEnabled('chatProvider')).toBe(true);
  });

  it('chatProvider flag respects explicit FEATURE_CHAT_PROVIDER=false', () => {
    process.env.FEATURE_CHAT_PROVIDER = 'false';
    expect(isEnabled('chatProvider')).toBe(false);
  });

  it('returns 404 when route is not mounted (flag off)', async () => {
    const res = await buildApp({ mountChat: false }).request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT_ID, message: 'hi' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/chat (mounted)', () => {
  it('401 without token', async () => {
    const res = await buildApp({ mountChat: true }).request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT_ID, message: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('400 on invalid payload', async () => {
    authVerified();
    const res = await buildApp({ mountChat: true }).request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID }),
    });
    expect(res.status).toBe(400);
  });

  it('streams chunk + done, persists session + chat_logs', async () => {
    register('mock', () => ({
      id: 'mock',
      defaultModel: 'mock-default',
      async *stream() {
        yield { type: 'chunk' as const, text: 'hi ' };
        yield { type: 'chunk' as const, text: 'there' };
        yield { type: 'usage' as const, usage: { promptTokens: 5, completionTokens: 2 } };
        yield { type: 'done' as const };
      },
    }));

    authVerified();
    projectAccessAsMember();
    projectInfoRow({});
    appConfigOverrideRow(null);
    appConfigProviderRow({ chatProviderId: 'mock', chatModel: null });
    newSessionInsert();
    chatLogsInsert();

    const res = await buildApp({ mountChat: true }).request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, message: 'hi' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('event: session');
    expect(body).toContain(SESSION_ID);
    expect(body).toContain('event: chunk');
    expect(body).toContain('"text":"hi "');
    expect(body).toContain('event: done');

    // session persisted with both turns
    expect(updateSet).toHaveBeenCalled();
    const setArg = updateSet.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(setArg.messages).toHaveLength(2);
    expect(setArg.messages[0]).toMatchObject({ role: 'user', content: 'hi' });
    expect(setArg.messages[1]).toMatchObject({ role: 'assistant', content: 'hi there' });

    // chat_logs row written exactly once with the accumulated reply + usage
    const logsCalls = insertValues.mock.calls.filter((c) => {
      const v = c[0] as { query?: string };
      return typeof v?.query === 'string';
    });
    expect(logsCalls).toHaveLength(1);
    const logRow = logsCalls[0]?.[0] as Record<string, unknown>;
    expect(logRow.query).toBe('hi');
    expect(logRow.reply).toBe('hi there');
    expect(logRow.model).toBe('mock-default');
    expect(logRow.iterations).toBe(1);
    expect(logRow.source).toBe('web');
    expect(logRow.error).toBeNull();
    expect(logRow.toolCalls).toEqual([]);
    expect(logRow.ragContext).toBeNull();
    expect((logRow.usage as { promptTokens?: number })?.promptTokens).toBe(5);
  });

  it('second turn with same sessionId includes prior turn in provider call', async () => {
    let captured: Array<{ role: string; content: string }> = [];
    register('mock', () => ({
      id: 'mock',
      defaultModel: 'mock-default',
      async *stream(req: { messages: Array<{ role: string; content: string }> }) {
        captured = req.messages;
        yield { type: 'chunk' as const, text: 'po' };
        yield { type: 'chunk' as const, text: 'ng' };
        yield { type: 'done' as const };
      },
    }));

    authVerified();
    projectAccessAsMember();
    projectInfoRow({});
    appConfigOverrideRow(null);
    appConfigProviderRow({ chatProviderId: 'mock', chatModel: null });
    sessionRow([
      { role: 'user', content: 'first', ts: '2026-04-26T00:00:00.000Z' },
      { role: 'assistant', content: 'reply-1', ts: '2026-04-26T00:00:01.000Z' },
    ]);

    const res = await buildApp({ mountChat: true }).request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, message: 'second', sessionId: SESSION_ID }),
    });

    expect(res.status).toBe(200);
    // Drain the SSE body so the streamSSE callback completes (post-loop persist
    // + chat_logs insert run after the stream is fully read).
    await res.text();

    // system + 2 prior turns + the new user message = 4
    expect(captured).toHaveLength(4);
    expect(captured[0]?.role).toBe('system');
    expect(captured[1]).toEqual({ role: 'user', content: 'first' });
    expect(captured[2]).toEqual({ role: 'assistant', content: 'reply-1' });
    expect(captured[3]).toEqual({ role: 'user', content: 'second' });

    // exactly one chat_logs row per request
    const logsCalls = insertValues.mock.calls.filter((c) => {
      const v = c[0] as { query?: string };
      return typeof v?.query === 'string';
    });
    expect(logsCalls).toHaveLength(1);
  });

  it('writes chat_logs.error and emits error SSE on provider failure', async () => {
    register('mock', () => ({
      id: 'mock',
      defaultModel: 'mock-default',
      async *stream() {
        yield { type: 'chunk' as const, text: 'partial' };
        yield { type: 'error' as const, message: 'upstream 500' };
      },
    }));

    authVerified();
    projectAccessAsMember();
    projectInfoRow({});
    appConfigOverrideRow(null);
    appConfigProviderRow({ chatProviderId: 'mock', chatModel: null });
    newSessionInsert();

    const res = await buildApp({ mountChat: true }).request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, message: 'hi' }),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('event: error');
    expect(body).toContain('upstream 500');
    expect(body).toContain('"message":"upstream 500"');

    const logsCalls = insertValues.mock.calls.filter((c) => {
      const v = c[0] as { query?: string };
      return typeof v?.query === 'string';
    });
    expect(logsCalls).toHaveLength(1);
    const row = logsCalls[0]?.[0] as Record<string, unknown>;
    expect(row.error).toBe('upstream 500');
  });

  it('503 when no provider can be resolved', async () => {
    authVerified();
    projectAccessAsMember();
    projectInfoRow({});
    appConfigOverrideRow(null);
    appConfigProviderRow({ chatProviderId: null, chatModel: null });

    const res = await buildApp({ mountChat: true }).request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, message: 'hi' }),
    });

    expect(res.status).toBe(503);
  });
});
