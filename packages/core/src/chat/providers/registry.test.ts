import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
  },
}));

const { clearProviders, get, listProviders, register, resolveForProject } = await import(
  './registry.js'
);
const { HTTPException } = await import('hono/http-exception');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

function fakeProvider(id: string, defaultModel = 'fake-default') {
  return {
    id,
    defaultModel,
    async *stream() {
      yield { type: 'done' as const };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  clearProviders();
});

describe('chat provider registry', () => {
  it('register + get returns the same instance (cached)', () => {
    const provider = fakeProvider('mock');
    register('mock', () => provider);
    expect(get('mock')).toBe(provider);
    expect(get('mock')).toBe(provider);
    expect(listProviders()).toEqual(['mock']);
  });

  it('get returns undefined for unknown id', () => {
    expect(get('missing')).toBeUndefined();
  });

  it('resolveForProject prefers app_config row when provider is registered', async () => {
    register('mock', () => fakeProvider('mock', 'mock-default'));
    selectLimit.mockResolvedValueOnce([{ chatProviderId: 'mock', chatModel: 'override-model' }]);

    const resolved = await resolveForProject(PROJECT_ID, { fallbackProviderId: 'unused' });

    expect(resolved.provider.id).toBe('mock');
    expect(resolved.model).toBe('override-model');
  });

  it('resolveForProject falls back to provider default model when chat_model is null', async () => {
    register('mock', () => fakeProvider('mock', 'mock-default'));
    selectLimit.mockResolvedValueOnce([{ chatProviderId: 'mock', chatModel: null }]);

    const resolved = await resolveForProject(PROJECT_ID);
    expect(resolved.model).toBe('mock-default');
  });

  it('resolveForProject falls back to env defaults when app_config has no provider', async () => {
    register('env-default', () => fakeProvider('env-default', 'env-model'));
    selectLimit.mockResolvedValueOnce([{ chatProviderId: null, chatModel: null }]);

    const resolved = await resolveForProject(PROJECT_ID, {
      fallbackProviderId: 'env-default',
      fallbackModel: 'fallback-model',
    });

    expect(resolved.provider.id).toBe('env-default');
    expect(resolved.model).toBe('fallback-model');
  });

  it('resolveForProject skips an unknown app_config provider id and falls back', async () => {
    register('env-default', () => fakeProvider('env-default'));
    selectLimit.mockResolvedValueOnce([{ chatProviderId: 'unknown', chatModel: 'whatever' }]);

    const resolved = await resolveForProject(PROJECT_ID, { fallbackProviderId: 'env-default' });
    expect(resolved.provider.id).toBe('env-default');
  });

  it('resolveForProject throws 503 when nothing is configured', async () => {
    selectLimit.mockResolvedValueOnce([]);

    await expect(
      resolveForProject(PROJECT_ID, { fallbackProviderId: undefined }),
    ).rejects.toBeInstanceOf(HTTPException);
  });
});

describe('resolveForProject — per-kind model', () => {
  const row = (chatModelByKind: unknown) => ({
    chatProviderId: 'mock',
    chatModel: 'project-model',
    chatModelByKind,
  });

  it('a by-kind entry wins over chat_model for that kind only', async () => {
    register('mock', () => fakeProvider('mock', 'mock-default'));
    selectLimit.mockResolvedValue([row({ relay: 'cheap-model' })]);

    expect((await resolveForProject(PROJECT_ID, { kind: 'relay' })).model).toBe('cheap-model');
    expect((await resolveForProject(PROJECT_ID, { kind: 'agentic' })).model).toBe('project-model');
    expect((await resolveForProject(PROJECT_ID)).model).toBe('project-model');
  });

  it('malformed or blank by-kind jsonb falls to chat_model, never throws', async () => {
    register('mock', () => fakeProvider('mock', 'mock-default'));
    for (const bad of ['oops', 42, null, { relay: 7 }, { relay: '  ' }, ['relay']]) {
      selectLimit.mockResolvedValueOnce([row(bad)]);
      expect((await resolveForProject(PROJECT_ID, { kind: 'relay' })).model).toBe('project-model');
    }
  });

  it('a by-kind entry rides the row provider — it is discarded with the row when that provider is unknown', async () => {
    register('fallback', () => fakeProvider('fallback', 'fallback-default'));
    selectLimit.mockResolvedValueOnce([
      { ...row({ relay: 'cheap-model' }), chatProviderId: 'gone' },
    ]);

    const resolved = await resolveForProject(PROJECT_ID, {
      kind: 'relay',
      fallbackProviderId: 'fallback',
    });
    expect(resolved.provider.id).toBe('fallback');
    expect(resolved.model).toBe('fallback-default');
  });
});
