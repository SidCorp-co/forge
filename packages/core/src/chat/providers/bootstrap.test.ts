import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    LITELLM_API_URL: 'http://proxy.test',
    LITELLM_API_KEY: 'k',
    LITELLM_MODEL: 'gpt-4o-mini',
  },
}));
vi.mock('../../logger.js', () => ({ logger: { info: () => undefined } }));

const { bootstrapChatProviders, CHAT_PROVIDER_ID, defaultChatProviderId } = await import(
  './bootstrap.js'
);
const { clearProviders, get, listProviders } = await import('./registry.js');

describe('bootstrapChatProviders', () => {
  beforeEach(() => {
    clearProviders();
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
