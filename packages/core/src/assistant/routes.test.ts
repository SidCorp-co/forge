import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatStreamEvent, ChatStreamRequest } from './providers/types.js';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

import { ASSISTANT_METHOD_GUIDE } from '../guides/assistant-method-guide.js';

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
// cm:guard the leftJoin chain routes back into the SAME where/limit FIFO the plain select uses, because `loadProjectAccess` runs select().from().leftJoin().leftJoin().where().limit() — give the joins a queue of their own and every mock below answers the wrong query in the wrong order.
const selectLeftJoin = vi.fn(
  (): Record<string, unknown> => ({
    leftJoin: selectLeftJoin,
    where: selectWhere,
  }),
);
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));

const updateWhere = vi.fn(() => Promise.resolve(undefined));
const updateSet = vi.fn((..._args: unknown[]) => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

const insertReturning = vi.fn();
const insertValues = vi.fn((..._args: unknown[]) => ({ returning: insertReturning }));
const dbInsert = vi.fn(() => ({ values: insertValues }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    update: dbUpdate,
    insert: dbInsert,
  },
}));

// cm:why the store has its own suites; this file owns what the ROUTE owns — auth, membership,
// opening the turn, and the prompt it builds.
const persisted: Array<Record<string, unknown>> = [];
const openTurnCalls: Array<Record<string, unknown>> = [];
let seededHistory: Array<{ role: string; content: string }> = [];
vi.mock('./conversation-turn.js', () => ({
  openTurn: async (o: Record<string, unknown>) => {
    openTurnCalls.push(o);
    return {
      conversationId: CONVERSATION_ID,
      adapter: 'web',
      history: seededHistory.map((m) => ({ ...m, images: [], silenceReason: null })),
      pending: [] as Array<Record<string, unknown>>,
    };
  },
  appendUserMessage: (t: { pending: unknown[] }, content: string) => {
    t.pending.push({ role: 'user', content, images: [], silenceReason: null });
  },
  appendAssistantMessage: (
    t: { pending: unknown[] },
    content: string,
    opts?: { blocks?: unknown },
  ) => {
    t.pending.push({
      role: 'assistant',
      content,
      images: [],
      silenceReason: null,
      blocks: opts?.blocks ?? null,
    });
  },
  appendSilence: (t: { pending: unknown[] }, reason: string, opts?: { blocks?: unknown }) => {
    t.pending.push({
      role: 'assistant',
      content: '',
      images: [],
      silenceReason: reason,
      blocks: opts?.blocks ?? null,
    });
  },
  // cm:why the double RETURNS the written rows, as the real one does: `runChatTurn` reads the
  // assistant row back and streams it as the final frame, so a double answering `undefined` makes
  // the route throw where production would not (ISS-1029).
  persistMessages: async (t: {
    pending: Array<{
      role: string;
      content: string;
      silenceReason: string | null;
      blocks?: unknown;
    }>;
  }) => {
    const rows = t.pending.splice(0).map((m, i) => ({
      id: `row-${i}`,
      seq: i,
      externalId: null,
      role: m.role,
      authorUserId: null,
      authorLabel: null,
      authorKey: null,
      content: m.content,
      blocks: m.blocks ?? null,
      images: [],
      deliveryProof: null,
      silenceReason: m.silenceReason,
      createdAt: new Date(0),
    }));
    persisted.push(...rows);
    return rows;
  },
  toCanonicalEntry: (row: Record<string, unknown>) => ({
    id: row.id,
    type: row.role === 'user' ? 'user' : row.role === 'system' ? 'system' : 'assistant',
    timestamp: (row.createdAt as Date).getTime(),
    ...((row.content as string).length > 0 ? { content: row.content } : {}),
    ...(row.blocks ? { blocks: row.blocks } : {}),
  }),
  toProviderMessages: (t: {
    history: Array<{ role: string; content: string }>;
    pending: Array<{ role: string; content: string; silenceReason: string | null }>;
  }) =>
    [...t.history, ...t.pending]
      .filter((m) => (m as { silenceReason?: string | null }).silenceReason == null && m.content)
      .map((m) => ({ role: m.role, content: m.content })),
}));

const addPerson = vi.fn(async (..._a: unknown[]) => undefined);
// cm:guard the two ISS-1034 loaders are mocked at the module seam rather than fed through the select FIFO: each is one more `select().from().where()` and threading them through the queue would shift every `mockResolvedValueOnce` below by one, so a test about the SSE door's history would fail on a row order it never asserted (ISS-1034).
vi.mock('../orgs/agent-selves.js', () => ({ readSelvesFor: vi.fn(async () => new Map()) }));
vi.mock('../auth/preference-changes.js', () => ({
  readAssistantPreferences: vi.fn(async () => null),
}));
vi.mock('../conversations/participants.js', () => ({
  addPerson: (...args: unknown[]) => addPerson(...args),
}));

// cm:guard a chat turn must NOT broadcast over WS — the chat.message publisher was deleted because no client listened to it (the widget streams over the SSE response body, not WS), so a roomManager.publish re-introduced in assistant/routes.ts or run-turn.ts is caught by this mock and fails the success-path test's assertion (ISS-71)
const wsPublish = vi.fn();
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: wsPublish },
}));

const { chatRoutes } = await import('./routes.js');
const { clearProviders, register } = await import('./providers/registry.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
const { isEnabled } = await import('../lib/feature-flags.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '99999999-9999-4999-8999-999999999999';

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
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
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

function seedConversation(messages: Array<{ role: string; content: string }> = []) {
  seededHistory = messages;
}

/** Registers the `mock` provider streaming `events`; `onReq` sees the request before the first one. */
function mockProvider(events: ChatStreamEvent[], onReq?: (req: ChatStreamRequest) => void) {
  register('mock', () => ({
    id: 'mock',
    defaultModel: 'mock-default',
    async *stream(req: ChatStreamRequest) {
      onReq?.(req);
      yield* events;
    },
  }));
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
  persisted.length = 0;
  openTurnCalls.length = 0;
  seededHistory = [];
  selectLimit.mockReset();
  insertReturning.mockReset();
  insertValues.mockClear();
  updateSet.mockClear();
  updateWhere.mockClear();
  dbInsert.mockClear();
  dbUpdate.mockClear();
  wsPublish.mockClear();
  // cm:guard `values()` is both a Promise, for `await db.insert(...).values(...)` on the audit path,
  // AND carries a `.returning()` — drop either half and a caller this route makes stops resolving.
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

  it('streams chunk + done, persists session + chat_logs (no WS broadcast)', async () => {
    mockProvider([
      { type: 'chunk', text: 'hi ' },
      { type: 'chunk', text: 'there' },
      { type: 'usage', usage: { promptTokens: 5, completionTokens: 2 } },
      { type: 'done' },
    ]);

    authVerified();
    projectAccessAsMember();
    projectInfoRow({});
    appConfigOverrideRow(null);
    appConfigProviderRow({ chatProviderId: 'mock', chatModel: null });
    seedConversation();
    chatLogsInsert();

    const res = await buildApp({ mountChat: true }).request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, message: 'hi' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('event: conversation');
    expect(body).toContain(CONVERSATION_ID);
    // cm:guard the route speaks ONE event kind now — `message`, carrying the canonical transcript
    // entry — in place of the provider's chunk/done vocabulary it used to relay. The old
    // assertions named those two frames and are replaced here, not dropped (ISS-1029).
    expect(body).toContain('event: message');
    expect(body).not.toContain('event: chunk');
    expect(body).not.toContain('event: done');
    expect(body).toContain('"type":"assistant"');
    expect(body).toContain('hi there');

    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({ role: 'user', content: 'hi' });
    expect(persisted[1]).toMatchObject({ role: 'assistant', content: 'hi there' });

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
    expect(logRow).not.toHaveProperty('ragContext');
    expect(logRow).not.toHaveProperty('queryIntent');
    expect((logRow.usage as { promptTokens?: number })?.promptTokens).toBe(5);

    // ISS-71 regression guard — chat turn must not broadcast over WS.
    // Widget streams via SSE response body; web has no consumer for any
    // chat WS event. If anyone re-introduces a publisher, this fails.
    expect(wsPublish).not.toHaveBeenCalled();
  });

  it('second turn with the same conversationId includes prior turn in provider call', async () => {
    let captured: ChatMessage[] = [];
    mockProvider(
      [{ type: 'chunk', text: 'po' }, { type: 'chunk', text: 'ng' }, { type: 'done' }],
      (req) => {
        captured = req.messages;
      },
    );

    authVerified();
    projectAccessAsMember();
    projectInfoRow({});
    appConfigOverrideRow(null);
    appConfigProviderRow({ chatProviderId: 'mock', chatModel: null });
    seedConversation([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply-1' },
    ]);

    const res = await buildApp({ mountChat: true }).request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        message: 'second',
        conversationId: CONVERSATION_ID,
      }),
    });

    expect(res.status).toBe(200);
    // cm:guard the SSE body is drained because the persist and the audit row run AFTER the stream is
    // fully read — assert without this and both writes are still in flight.
    await res.text();

    expect(captured).toHaveLength(4);
    expect(captured[0]?.role).toBe('system');
    expect(captured[1]).toEqual({ role: 'user', content: 'first' });
    expect(captured[2]).toEqual({ role: 'assistant', content: 'reply-1' });
    expect(captured[3]).toEqual({ role: 'user', content: 'second' });

    const logsCalls = insertValues.mock.calls.filter((c) => {
      const v = c[0] as { query?: string };
      return typeof v?.query === 'string';
    });
    expect(logsCalls).toHaveLength(1);
  });

  it('writes chat_logs.error and emits error SSE on provider failure', async () => {
    mockProvider([
      { type: 'chunk', text: 'partial' },
      { type: 'error', message: 'upstream 500' },
    ]);

    authVerified();
    projectAccessAsMember();
    projectInfoRow({});
    appConfigOverrideRow(null);
    appConfigProviderRow({ chatProviderId: 'mock', chatModel: null });
    seedConversation();

    const res = await buildApp({ mountChat: true }).request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, message: 'hi' }),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    // cm:guard a failed turn still says so on the stream, as a canonical `system` entry carrying
    // the reason rather than as an `error` frame — the reason is part of the transcript a reader
    // sees, and `subtype` is how the canonical shape names a non-assistant entry (ISS-1029).
    expect(body).toContain('event: message');
    expect(body).toContain('"subtype":"error"');
    expect(body).toContain('upstream 500');
    expect(body).not.toContain('event: error');

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

// cm:guard this case sits in a describe of its own rather than inside `POST /api/chat (mounted)`, because that block is at its frozen function-length budget and the form axis may only improve — a case added inside it is a `--update-baseline` nobody priced (ISS-1007).
describe('the system prompt POST /api/chat opens with', () => {
  // cm:guard the system message is read for what it CONTAINS, not merely for its role: this door passed no persona until ISS-1007 and answered on `system-prompt.ts`'s one-sentence fallback, which asserting `role === 'system'` could never have told apart from a turn carrying the whole method.
  it('opens with the web persona rather than the one-line fallback', async () => {
    let captured: ChatMessage[] = [];
    mockProvider([{ type: 'chunk', text: 'ok' }, { type: 'done' }], (req) => {
      captured = req.messages;
    });
    authVerified();
    projectAccessAsMember();
    projectInfoRow({});
    appConfigOverrideRow(null);
    appConfigProviderRow({ chatProviderId: 'mock', chatModel: null });
    seedConversation([]);

    const res = await buildApp({ mountChat: true }).request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, message: 'hello' }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const system = captured[0]?.content ?? '';
    expect(system).not.toBe('You are a helpful assistant for project "Forge Dev".');
    expect(system).toContain(ASSISTANT_METHOD_GUIDE.body.trim());
    expect(system).toContain('/projects/forge-dev/agents');
  });
});
