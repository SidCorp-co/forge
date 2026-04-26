/**
 * v1 EPIC 1 (ISS-270) — Register chat providers from env.
 *
 * Called once from `src/index.ts` during the boot sequence. Each provider
 * is registered only when its credentials are present so the app starts
 * cleanly even when no chat provider is configured.
 *
 * `defaultChatProviderId()` returns the implicit fallback provider id used
 * when `app_config.chat_provider_id` is null. Picks the first registered
 * provider in a stable order; returns undefined when none are configured.
 */

import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { createGeminiProvider } from './gemini.js';
import { createLiteLLMProvider } from './litellm.js';
import { listProviders, register } from './registry.js';

const PRIORITY = ['litellm', 'gemini'] as const;

export function bootstrapChatProviders(): void {
  if (env.LITELLM_API_URL && env.LITELLM_API_KEY) {
    register('litellm', () =>
      createLiteLLMProvider({
        baseUrl: env.LITELLM_API_URL as string,
        apiKey: env.LITELLM_API_KEY as string,
        defaultModel: env.LITELLM_MODEL,
      }),
    );
  }

  if (env.GEMINI_API_KEY) {
    register('gemini', () =>
      createGeminiProvider({
        apiKey: env.GEMINI_API_KEY as string,
        defaultModel: env.GEMINI_MODEL,
      }),
    );
  }

  const ids = listProviders();
  if (ids.length === 0) {
    logger.info('chat providers: none configured (set LITELLM_* or GEMINI_API_KEY to enable)');
  } else {
    logger.info({ providers: ids }, 'chat providers registered');
  }
}

export function defaultChatProviderId(): string | undefined {
  const registered = new Set(listProviders());
  for (const id of PRIORITY) {
    if (registered.has(id)) return id;
  }
  return registered.values().next().value as string | undefined;
}
