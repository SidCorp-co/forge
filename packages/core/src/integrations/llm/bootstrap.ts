/** v1 EPIC 1 (ISS-270) — registers the chat adapters from env at boot; `defaultChatProviderId()` is the provider `resolveChatProvider` answers — the Anthropic Messages-wire adapter when it is configured, because measured 2026-09-04 it is the wire that reports cache reads and returns structured output where the Completions wire did not — and registering nothing lets the app start with chat unconfigured. */

import type { Executor } from '@forge/contracts/report-executions';
import { env } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { createAnthropicProvider } from './anthropic.js';
import { createCodeExecutor } from './code-execution.js';
import { createOpenAIProvider } from './openai.js';
import { listProviders, register } from './registry.js';

const CHAT_PROVIDER_ID = 'openai';
const ANTHROPIC_PROVIDER_ID = 'anthropic';

export function bootstrapChatProviders(): void {
  if (env.LITELLM_API_URL && env.LITELLM_API_KEY) {
    register(CHAT_PROVIDER_ID, () =>
      createOpenAIProvider({
        baseUrl: env.LITELLM_API_URL as string,
        apiKey: env.LITELLM_API_KEY as string,
        defaultModel: env.LITELLM_MODEL,
      }),
    );
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
  return [ANTHROPIC_PROVIDER_ID, CHAT_PROVIDER_ID].find((id) => registered.includes(id));
}

/**
 * The in-band sandbox executors this deployment's provider keys enable, for the process entry to
 * hand the reports Executor port at boot: the code execution adapter where the Anthropic key is set,
 * none otherwise. It runs on the same URL and model the chat turns use.
 */
export function providerExecutors(): Executor[] {
  if (!env.ANTHROPIC_API_KEY) return [];
  return [
    createCodeExecutor({
      baseUrl: env.ANTHROPIC_API_URL,
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL,
    }),
  ];
}
