import { beforeEach, describe, expect, it, vi } from 'vitest';

const envState: Record<string, unknown> = {};
vi.mock('../../config/env.js', () => ({ env: envState }));
const setEnv = (values: Record<string, unknown>) => {
  for (const k of Object.keys(envState)) delete envState[k];
  Object.assign(envState, values);
};
setEnv({
  LITELLM_API_URL: 'http://proxy.test',
  LITELLM_API_KEY: 'k',
  LITELLM_MODEL: 'gpt-4o-mini',
});
vi.mock('../../logger.js', () => ({ logger: { info: () => undefined } }));

const { bootstrapChatProviders, CHAT_PROVIDER_ID, defaultChatProviderId } = await import(
  './bootstrap.js'
);
const { clearProviders, get, listProviders } = await import('./registry.js');

describe('bootstrapChatProviders', () => {
  beforeEach(() => {
    clearProviders();
    setEnv({
      LITELLM_API_URL: 'http://proxy.test',
      LITELLM_API_KEY: 'k',
      LITELLM_MODEL: 'gpt-4o-mini',
    });
  });

  it('registers the adapter under `openai`, and reports it as the default', () => {
    bootstrapChatProviders();

    expect(CHAT_PROVIDER_ID).toBe('openai');
    expect(get('openai')?.id).toBe('openai');
    expect(get('openai')?.defaultModel).toBe('gpt-4o-mini');
    expect(defaultChatProviderId()).toBe('openai');
  });

  it('still resolves `litellm`, the id every project pinned before the rename holds', () => {
    bootstrapChatProviders();

    const legacy = get('litellm');
    expect(legacy).toBeDefined();
    expect(legacy?.defaultModel).toBe('gpt-4o-mini');
  });

  it('still resolves `gemini`, the id a box running memory could always select', () => {
    bootstrapChatProviders();

    expect(get('gemini')).toBeDefined();
    expect(listProviders().sort()).toEqual(['gemini', 'litellm', 'openai']);
  });

  it('reports no default before boot, so an unconfigured app resolves nothing', () => {
    expect(defaultChatProviderId()).toBeUndefined();
  });
});

describe('bootstrapChatProviders — anthropic', () => {
  beforeEach(() => clearProviders());

  it('registers `anthropic` beside `openai` and keeps openai as the default', () => {
    setEnv({
      LITELLM_API_URL: 'http://proxy.test',
      LITELLM_API_KEY: 'k',
      LITELLM_MODEL: 'gpt-4o-mini',
      ANTHROPIC_API_URL: 'https://api.anthropic.com',
      ANTHROPIC_API_KEY: 'ak',
      ANTHROPIC_MODEL: 'claude-sonnet-5',
      ANTHROPIC_MAX_TOKENS: 8192,
    });
    bootstrapChatProviders();
    expect(get('anthropic')?.id).toBe('anthropic');
    expect(get('anthropic')?.defaultModel).toBe('claude-sonnet-5');
    expect(defaultChatProviderId()).toBe('openai');
  });

  it('is the default when it is the only adapter configured', () => {
    setEnv({
      ANTHROPIC_API_URL: 'https://api.anthropic.com',
      ANTHROPIC_API_KEY: 'ak',
      ANTHROPIC_MODEL: 'claude-sonnet-5',
      ANTHROPIC_MAX_TOKENS: 8192,
    });
    bootstrapChatProviders();
    expect(listProviders()).toEqual(['anthropic']);
    expect(defaultChatProviderId()).toBe('anthropic');
  });

  it('registers nothing and reports no default when neither is configured', () => {
    setEnv({});
    bootstrapChatProviders();
    expect(listProviders()).toEqual([]);
    expect(defaultChatProviderId()).toBeUndefined();
  });
});
