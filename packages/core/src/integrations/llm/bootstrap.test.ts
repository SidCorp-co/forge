import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// REQ-19: the instance reaches a model only through the gateway. No provider key is read, and with
// no gateway a turn refuses naming the setting that is missing.

const settings = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  errors: [] as string[],
}));
vi.mock('../../lib/env.js', () => ({ env: settings.env }));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: () => undefined, error: (_: unknown, msg: string) => settings.errors.push(msg) },
}));

async function boot() {
  vi.resetModules();
  const bootstrap = await import('./bootstrap.js');
  const chat = await import('./chat.js');
  bootstrap.bootstrapChatProviders();
  return { ...bootstrap, chat };
}

describe('bootstrapChatProviders', () => {
  beforeEach(() => {
    for (const k of Object.keys(settings.env)) delete settings.env[k];
    settings.env.LITELLM_MODEL = 'gateway-model';
    settings.errors.length = 0;
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('registers the gateway and answers its model', async () => {
    settings.env.LITELLM_API_URL = 'https://gateway.example';
    settings.env.LITELLM_API_KEY = 'k';
    const { defaultChatProviderId, chat } = await boot();
    expect(defaultChatProviderId()).toBe('openai');
    expect(chat.chatModelName()).toBe('gateway-model');
  });

  it('with no gateway, refuses by name and names both settings', async () => {
    const { defaultChatProviderId, chat } = await boot();
    expect(defaultChatProviderId()).toBeUndefined();
    expect(() => chat.chatModelName()).toThrow(
      /ASSISTANT_MODEL_NOT_CONFIGURED|LITELLM_API_URL and LITELLM_API_KEY are not set/,
    );
    expect(() => chat.chatModelName()).toThrow(/LITELLM_API_URL and LITELLM_API_KEY are not set/);
  });

  it('with only the URL, names the key as the missing setting', async () => {
    settings.env.LITELLM_API_URL = 'https://gateway.example';
    const { chat } = await boot();
    expect(() => chat.chatModelName()).toThrow(/LITELLM_API_KEY is not set/);
  });

  it('reads no provider key: ANTHROPIC_API_KEY alone configures nothing and is named as unread', async () => {
    process.env.ANTHROPIC_API_KEY = 'not-a-real-key';
    const { defaultChatProviderId } = await boot();
    expect(defaultChatProviderId()).toBeUndefined();
    expect(settings.errors.join('\n')).toMatch(/ANTHROPIC_API_KEY is set but read by nothing/);
  });
});
