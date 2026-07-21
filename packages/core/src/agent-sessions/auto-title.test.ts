import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    LITELLM_API_URL: 'http://litellm.test',
    LITELLM_API_KEY: 'k',
    LITELLM_MODEL: 'fast-model',
  },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
vi.mock('../db/client.js', () => ({
  db: { update: vi.fn(() => ({ set: updateSet })) },
}));

const broadcastSessionSpy = vi.fn();
vi.mock('./broadcast.js', () => ({
  broadcastSession: (...args: unknown[]) => broadcastSessionSpy(...args),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { generateSessionTitle, applyAutoTitleAsync } = await import('./auto-title.js');

function mockCompletion(content: string) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  updateReturning.mockReset();
});

describe('generateSessionTitle', () => {
  it('returns a cleaned topic label from the model', async () => {
    mockCompletion('"Runner dispatch loop debugging"');
    const title = await generateSessionTitle('Help me debug the runner dispatch loop');
    expect(title).toBe('Runner dispatch loop debugging');
  });

  it('collapses whitespace and caps length', async () => {
    mockCompletion(`  ${'Very long topic label '.repeat(6)}  `);
    const title = await generateSessionTitle('some message');
    expect(title).not.toBeNull();
    expect(title?.length).toBeLessThanOrEqual(60);
  });

  it('returns null when the message is pure system noise', async () => {
    const title = await generateSessionTitle("[RESULT_ERROR] success: You've hit a rate limit");
    expect(title).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when the model call fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const title = await generateSessionTitle('hello there');
    expect(title).toBeNull();
  });

  it('returns null when the model reply is itself system noise', async () => {
    mockCompletion('[RESULT_ERROR] nope');
    const title = await generateSessionTitle('hello there');
    expect(title).toBeNull();
  });
});

describe('applyAutoTitleAsync', () => {
  it('applies the AI title via compare-and-swap and broadcasts the update', async () => {
    mockCompletion('Runner dispatch loop debugging');
    updateReturning.mockResolvedValueOnce([
      { id: 'sess-1', projectId: 'proj-1', deviceId: null, status: 'running' },
    ]);
    await applyAutoTitleAsync({
      sessionId: 'sess-1',
      userMessage: 'Help me debug the runner dispatch loop',
      fallbackTitle: 'Help me debug the runner dispatch loop',
    });
    expect(updateSet).toHaveBeenCalledWith({ title: 'Runner dispatch loop debugging' });
    expect(broadcastSessionSpy).toHaveBeenCalledWith(
      { id: 'sess-1', projectId: 'proj-1', deviceId: null, status: 'running' },
      'agent-session.updated',
    );
  });

  it('skips the update (no broadcast) when the CAS misses — title changed underneath (user rename)', async () => {
    mockCompletion('Runner dispatch loop debugging');
    updateReturning.mockResolvedValueOnce([]); // CAS where-clause matched no row
    await applyAutoTitleAsync({
      sessionId: 'sess-1',
      userMessage: 'Help me debug the runner dispatch loop',
      fallbackTitle: 'Help me debug the runner dispatch loop',
    });
    expect(broadcastSessionSpy).not.toHaveBeenCalled();
  });

  it('skips the update entirely when the AI title equals the fallback', async () => {
    mockCompletion('Help me debug the runner dispatch loop');
    await applyAutoTitleAsync({
      sessionId: 'sess-1',
      userMessage: 'Help me debug the runner dispatch loop',
      fallbackTitle: 'Help me debug the runner dispatch loop',
    });
    expect(updateSet).not.toHaveBeenCalled();
    expect(broadcastSessionSpy).not.toHaveBeenCalled();
  });

  it('never throws when the model call fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(
      applyAutoTitleAsync({
        sessionId: 'sess-1',
        userMessage: 'hello',
        fallbackTitle: 'hello',
      }),
    ).resolves.toBeUndefined();
    expect(updateSet).not.toHaveBeenCalled();
  });
});
