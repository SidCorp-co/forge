/** v1 EPIC 1 (ISS-270) — registers the chat adapters from env at boot; `defaultChatProviderId()` is the fallback `resolveForProject` uses when `app_config.chat_provider_id` is null (the OpenAI-wire adapter when both are configured), and registering nothing lets the app start with chat unconfigured. */

import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAIProvider } from './openai.js';
import { listProviders, register } from './registry.js';

export const CHAT_PROVIDER_ID = 'openai';
export const ANTHROPIC_PROVIDER_ID = 'anthropic';

// cm:guard keep EVERY id this adapter has ever answered to registered — 'litellm' was its own id until the 2026-09-03 rename, and 'gemini' was a separate adapter registered on a GEMINI_API_KEY that config/env.ts stopped declaring on 2026-09-04; the env var is gone but the `app_config.chat_provider_id` rows that named it are NOT, and a row outlives the code that wrote it
// cm:guard dropping an alias is not a no-op: resolveForProject falls through to the env fallback when a row's chat_provider_id will not resolve and discards that row's `chat_model` with it, silently re-pinning a pinned project onto the default model — aliased, a Gemini model name instead reaches Vertex THROUGH the proxy or 400s where an operator can see it, and on a box with no LITELLM_* nothing registers at all so those rows get a 503 rather than a wrong answer
const LEGACY_PROVIDER_IDS = ['litellm', 'gemini'] as const;

export function bootstrapChatProviders(): void {
  if (env.LITELLM_API_URL && env.LITELLM_API_KEY) {
    const factory = () =>
      createOpenAIProvider({
        baseUrl: env.LITELLM_API_URL as string,
        apiKey: env.LITELLM_API_KEY as string,
        defaultModel: env.LITELLM_MODEL,
      });
    register(CHAT_PROVIDER_ID, factory);
    for (const legacy of LEGACY_PROVIDER_IDS) register(legacy, factory);
    logger.info({ model: env.LITELLM_MODEL }, 'chat provider registered: openai');
  }
  if (env.ANTHROPIC_API_KEY) {
    register(ANTHROPIC_PROVIDER_ID, () =>
      createAnthropicProvider({
        baseUrl: env.ANTHROPIC_API_URL,
        apiKey: env.ANTHROPIC_API_KEY as string,
        defaultModel: env.ANTHROPIC_MODEL,
        maxTokens: env.ANTHROPIC_MAX_TOKENS,
      }),
    );
    logger.info({ model: env.ANTHROPIC_MODEL }, 'chat provider registered: anthropic');
  }
  if (listProviders().length === 0) {
    logger.info(
      'chat provider: none configured (set LITELLM_API_URL + LITELLM_API_KEY, or ANTHROPIC_API_KEY)',
    );
  }
}

export function defaultChatProviderId(): string | undefined {
  const registered = listProviders();
  return [CHAT_PROVIDER_ID, ANTHROPIC_PROVIDER_ID].find((id) => registered.includes(id));
}
