import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const whereResults: unknown[][] = [];
const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({
  limit: selectLimit,
  then: (cb: (v: unknown) => unknown) => {
    const result = whereResults.shift() ?? [];
    return Promise.resolve(result).then(cb);
  },
}));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const insertReturning = vi.fn();
const onConflictDoUpdate = vi.fn(() => ({ returning: insertReturning }));
const insertValues = vi.fn(() => ({ onConflictDoUpdate }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
  },
}));

const writeAssistantPreferences = vi.fn();
const listPreferenceChanges = vi.fn();
const restorePreferenceChange = vi.fn();
vi.mock('./preference-changes.js', async (orig) => ({
  ...(await orig<typeof import('./preference-changes.js')>()),
  writeAssistantPreferences: (...a: unknown[]) => writeAssistantPreferences(...a),
  listPreferenceChanges: (...a: unknown[]) => listPreferenceChanges(...a),
  restorePreferenceChange: (...a: unknown[]) => restorePreferenceChange(...a),
}));
const { preferenceRoutes } = await import('./preferences.js');
const { PreferenceRestoreConflict } = await import('./preference-changes.js');
const { signUserToken } = await import('./jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
const hooksModule = await import('../pipeline/hooks.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/auth', preferenceRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  insertReturning.mockReset();
  whereResults.length = 0;
  hooksModule.hooks.reset();
});

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/auth/preferences', () => {
  it('401 without token', async () => {
    const res = await buildApp().request('/api/auth/preferences');
    expect(res.status).toBe(401);
  });

  it('returns defaults when no row exists (never 404)', async () => {
    selectLimit.mockResolvedValueOnce([]);
    const res = await buildApp().request('/api/auth/preferences', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: USER_ID,
      theme: 'system',
      language: 'en',
      answerStyle: 'default',
      assistantInstructions: null,
      updatedAt: null,
    });
  });

  it('returns the persisted row when present', async () => {
    const updatedAt = new Date('2026-04-26T00:00:00.000Z').toISOString();
    selectLimit.mockResolvedValueOnce([
      { userId: USER_ID, theme: 'dark', language: 'vi', updatedAt },
    ]);
    const res = await buildApp().request('/api/auth/preferences', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: USER_ID,
      theme: 'dark',
      language: 'vi',
      updatedAt,
    });
  });
});

describe('PATCH /api/auth/preferences', () => {
  it('rejects empty body', async () => {
    const res = await buildApp().request('/api/auth/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('rejects unknown theme', async () => {
    const res = await buildApp().request('/api/auth/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ theme: 'pink' }),
    });
    expect(res.status).toBe(400);
  });

  it('upserts and emits userPreferencesChanged hook', async () => {
    insertReturning.mockResolvedValueOnce([
      {
        userId: USER_ID,
        theme: 'dark',
        language: 'en',
        updatedAt: new Date().toISOString(),
      },
    ]);
    const seen: Array<{ userId: string; theme: string; language: string }> = [];
    hooksModule.hooks.on('userPreferencesChanged', (p) => {
      seen.push({ userId: p.userId, theme: p.theme, language: p.language });
    });

    const res = await buildApp().request('/api/auth/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ theme: 'dark' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { theme: string };
    expect(body.theme).toBe('dark');
    expect(seen).toEqual([{ userId: USER_ID, theme: 'dark', language: 'en' }]);
  });
});

describe('assistant preferences (ISS-1034)', () => {
  const headers = async () => ({
    'content-type': 'application/json',
    authorization: `Bearer ${await token()}`,
  });

  it('PATCH answerStyle goes through the one writer as the person, and answers the full row (criterion 13)', async () => {
    writeAssistantPreferences.mockResolvedValueOnce({});
    selectLimit.mockResolvedValueOnce([
      {
        userId: USER_ID,
        theme: 'system',
        language: 'en',
        answerStyle: 'concise',
        assistantInstructions: null,
        updatedAt: null,
      },
    ]);
    const res = await buildApp().request('/api/auth/preferences', {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({ answerStyle: 'concise' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { answerStyle: string }).answerStyle).toBe('concise');
    expect(writeAssistantPreferences).toHaveBeenCalledWith({
      userId: USER_ID,
      patch: { answerStyle: 'concise', assistantInstructions: undefined },
      actor: { kind: 'person', userId: USER_ID },
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('PATCH with an unknown answerStyle is refused 400 naming the accepted values (criterion 14)', async () => {
    const res = await buildApp().request('/api/auth/preferences', {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({ answerStyle: 'shouty' }),
    });
    expect(res.status).toBe(400);
    const text = JSON.stringify(await res.json());
    for (const v of ['default', 'concise', 'detailed', 'bullets']) expect(text).toContain(v);
    expect(writeAssistantPreferences).not.toHaveBeenCalled();
  });

  it('GET /preferences/changes lists the caller’s trail (criterion 59)', async () => {
    listPreferenceChanges.mockResolvedValueOnce([{ id: 'c-1', field: 'answer_style' }]);
    const res = await buildApp().request('/api/auth/preferences/changes', {
      headers: await headers(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ id: 'c-1', field: 'answer_style' }] });
    expect(listPreferenceChanges).toHaveBeenCalledWith(USER_ID);
  });

  it('POST restore answers 404 for a change that is not the caller’s', async () => {
    restorePreferenceChange.mockResolvedValueOnce(null);
    const res = await buildApp().request(
      '/api/auth/preferences/changes/99999999-9999-4999-8999-999999999999/restore',
      { method: 'POST', headers: await headers() },
    );
    expect(res.status).toBe(404);
  });

  it('POST restore answers 409 naming the later change once the field moved on (criterion 61)', async () => {
    const change = { id: 'c-1', field: 'answer_style', changedAt: new Date(1) };
    const later = { id: 'c-2', field: 'answer_style', changedBy: 'person', changedAt: new Date(2) };
    restorePreferenceChange.mockRejectedValueOnce(
      new PreferenceRestoreConflict(change as never, later as never),
    );
    const res = await buildApp().request(
      '/api/auth/preferences/changes/99999999-9999-4999-8999-999999999999/restore',
      { method: 'POST', headers: await headers() },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string; laterChangeId?: string };
    expect(body.code).toBe('PREFERENCE_CHANGE_SUPERSEDED');
    expect(body.message).toContain('c-2');
  });

  it('POST restore answers the full row when it applied (criterion 60)', async () => {
    restorePreferenceChange.mockResolvedValueOnce({
      userId: USER_ID,
      answerStyle: 'default',
      assistantInstructions: null,
      updatedAt: null,
    });
    selectLimit.mockResolvedValueOnce([
      {
        userId: USER_ID,
        theme: 'dark',
        language: 'vi',
        answerStyle: 'default',
        assistantInstructions: null,
        updatedAt: null,
      },
    ]);
    const res = await buildApp().request(
      '/api/auth/preferences/changes/99999999-9999-4999-8999-999999999999/restore',
      { method: 'POST', headers: await headers() },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { theme: string }).theme).toBe('dark');
    expect(restorePreferenceChange).toHaveBeenCalledWith({
      userId: USER_ID,
      changeId: '99999999-9999-4999-8999-999999999999',
      actor: { kind: 'person', userId: USER_ID },
    });
  });
});
