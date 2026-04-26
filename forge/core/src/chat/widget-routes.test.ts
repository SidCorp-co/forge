import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
const insertValues = vi.fn();
const dbInsert = vi.fn(() => ({ values: insertValues }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    update: dbUpdate,
    insert: dbInsert,
  },
}));

const { widgetChatRoutes } = await import('./widget-routes.js');
const { clearProviders, register } = await import('./providers/registry.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '99999999-9999-4999-8999-999999999999';
const API_KEY = 'fk_widget-test-key-long-enough-1234';

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/widget/chat', widgetChatRoutes);
  app.onError(errorHandler);
  return app;
}

function apiKeyMatch() {
  selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, slug: 'forge-dev', name: 'Forge Dev' }]);
}

function projectInfoRow() {
  selectLimit.mockResolvedValueOnce([
    { id: PROJECT_ID, slug: 'forge-dev', name: 'Forge Dev', agentConfig: null },
  ]);
}

function appConfigOverrideRow() {
  selectLimit.mockResolvedValueOnce([{ systemPromptOverride: null }]);
}

function appConfigProviderRow(row: { chatProviderId: string | null; chatModel: string | null }) {
  selectLimit.mockResolvedValueOnce([row]);
}

function newSessionInsert() {
  insertReturning.mockResolvedValueOnce([
    {
      id: SESSION_ID,
      projectId: PROJECT_ID,
      userId: null,
      source: 'widget',
      messages: [],
    },
  ]);
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
  insertValues.mockImplementation((() => {
    const p = Promise.resolve(undefined) as Promise<undefined> & {
      returning: typeof insertReturning;
    };
    p.returning = insertReturning;
    return p;
  }) as never);
  clearProviders();
});

describe('POST /api/widget/chat', () => {
  it('401 without X-Forge-API-Key', async () => {
    const res = await buildApp().request('/api/widget/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('400 on invalid payload (missing message)', async () => {
    apiKeyMatch();
    const res = await buildApp().request('/api/widget/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Forge-API-Key': API_KEY },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('streams + persists chat_logs.source=widget', async () => {
    register('mock', () => ({
      id: 'mock',
      defaultModel: 'mock-default',
      async *stream() {
        yield { type: 'chunk' as const, text: 'hello' };
        yield { type: 'done' as const };
      },
    }));

    apiKeyMatch();
    projectInfoRow();
    appConfigOverrideRow();
    appConfigProviderRow({ chatProviderId: 'mock', chatModel: null });
    newSessionInsert();

    const res = await buildApp().request('/api/widget/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Forge-API-Key': API_KEY },
      body: JSON.stringify({ message: 'hi' }),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('event: session');
    expect(body).toContain('event: chunk');
    expect(body).toContain('event: done');

    const logsCalls = insertValues.mock.calls.filter((c) => {
      const v = c[0] as { query?: string };
      return typeof v?.query === 'string';
    });
    expect(logsCalls).toHaveLength(1);
    const logRow = logsCalls[0]?.[0] as Record<string, unknown>;
    expect(logRow.source).toBe('widget');
    expect(logRow.userKey).toBeNull();
    expect(logRow.projectSlug).toBe('forge-dev');
    expect(logRow.reply).toBe('hello');
  });
});
