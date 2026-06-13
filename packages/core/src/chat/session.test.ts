import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../db/client.js', () => ({
  db: {} as never,
}));

const {
  appendAssistantMessage,
  appendUserMessage,
  loadOrCreateSession,
  persistMessages,
  toProviderMessages,
} = await import('./session.js');

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '99999999-9999-4999-8999-999999999999';

function selectMock(rows: unknown[]) {
  const limit = vi.fn(() => Promise.resolve(rows));
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select, limit };
}

function insertMock(returnedRow: unknown) {
  const returning = vi.fn(() => Promise.resolve([returnedRow]));
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  return { insert, values };
}

function updateMock() {
  const where = vi.fn(() => Promise.resolve(undefined));
  const set = vi.fn((..._args: unknown[]) => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { update, set, where };
}

describe('loadOrCreateSession', () => {
  it('loads an existing session by id when sessionId provided', async () => {
    const row = {
      id: SESSION_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      source: 'web',
      messages: [{ role: 'user', content: 'hi', ts: '2026-04-26T00:00:00.000Z' }],
    };
    const { select } = selectMock([row]);
    const fakeDb = { select } as never;

    const session = await loadOrCreateSession({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      userId: USER_ID,
      source: 'web',
      db: fakeDb,
    });

    expect(session.id).toBe(SESSION_ID);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.content).toBe('hi');
  });

  it('throws 404 when session does not exist', async () => {
    const { select } = selectMock([]);
    const fakeDb = { select } as never;

    await expect(
      loadOrCreateSession({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        userId: USER_ID,
        source: 'web',
        db: fakeDb,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('throws 403 when session belongs to another project', async () => {
    const { select } = selectMock([
      {
        id: SESSION_ID,
        projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        userId: USER_ID,
        source: 'web',
        messages: [],
      },
    ]);
    const fakeDb = { select } as never;

    await expect(
      loadOrCreateSession({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        userId: USER_ID,
        source: 'web',
        db: fakeDb,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('creates a new session when sessionId is undefined', async () => {
    const created = {
      id: SESSION_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      source: 'web',
      messages: [],
    };
    const { insert, values } = insertMock(created);
    const fakeDb = { insert } as never;

    const session = await loadOrCreateSession({
      projectId: PROJECT_ID,
      userId: USER_ID,
      source: 'web',
      db: fakeDb,
    });

    expect(session.id).toBe(SESSION_ID);
    expect(session.messages).toEqual([]);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, userId: USER_ID, source: 'web' }),
    );
  });
});

describe('append + persist round-trip', () => {
  it('appends user + assistant messages and persists with updatedAt', async () => {
    const row = {
      id: SESSION_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      source: 'web',
      messages: [],
    };
    const { select } = selectMock([row]);
    const { update, set } = updateMock();
    const fakeDb = { select, update } as never;

    const session = await loadOrCreateSession({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      userId: USER_ID,
      source: 'web',
      db: fakeDb,
    });

    appendUserMessage(session, 'hello');
    appendAssistantMessage(session, 'hi back');

    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]).toMatchObject({ role: 'user', content: 'hello' });
    expect(session.messages[1]).toMatchObject({ role: 'assistant', content: 'hi back' });

    await persistMessages(session, { db: fakeDb });

    expect(set).toHaveBeenCalledTimes(1);
    const setArg = set.mock.calls[0]?.[0] as { messages: unknown[]; updatedAt: Date };
    expect(setArg.messages).toHaveLength(2);
    expect(setArg.updatedAt).toBeInstanceOf(Date);
  });
});

describe('toProviderMessages', () => {
  it('drops the ts field', () => {
    const messages = toProviderMessages({
      id: SESSION_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      source: 'web',
      messages: [
        { role: 'user', content: 'a', ts: 'x' },
        { role: 'assistant', content: 'b', ts: 'y' },
      ],
    });
    expect(messages).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
  });
});
