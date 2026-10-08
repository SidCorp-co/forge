/** v1 EPIC 1 (ISS-270) — registers the chat adapters from env at boot; `defaultChatProviderId()` is the provider `resolveChatProvider` answers — the Anthropic Messages-wire adapter when it is configured, because measured 2026-09-04 it is the wire that reports cache reads and returns structured output where the Completions wire did not — and registering nothing lets the app start with chat unconfigured. */

import type { Executor } from '@forge/contracts/report-executions';
import { env } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { createAnthropicProvider } from './anthropic.js';
import { CODE_EXECUTOR_ID, createCodeExecutor } from './code-execution.js';
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

/** Where the Files API and the code execution tool are served: the Claude API, not a gateway in its format. */
const CLAUDE_API_ORIGIN = 'https://api.anthropic.com';

type ExecutorSettings = Pick<
  typeof env,
  | 'ANTHROPIC_API_URL'
  | 'ANTHROPIC_API_KEY'
  | 'ANTHROPIC_MODEL'
  | 'CODE_EXECUTION_API_URL'
  | 'CODE_EXECUTION_API_KEY'
  | 'CODE_EXECUTION_MODEL'
>;

/** The sandbox executors a deployment enabled, and why each it could not enable is absent. */
export interface ProviderExecutors {
  executors: Executor[];
  unavailable: string[];
}

const isClaudeApi = (url: string): boolean => new URL(url).origin === CLAUDE_API_ORIGIN;

/**
 * The in-band sandbox executors this deployment's provider settings enable, for the process entry
 * to hand the reports Executor port at boot. The code execution adapter runs on the Claude API only,
 * where the Files API and the code execution tool are served (platform.claude.com/docs,
 * build-with-claude/files and agents-and-tools/tool-use/code-execution-tool): on its own
 * CODE_EXECUTION_* settings where its key is set, or on the chat's ANTHROPIC_* settings where they
 * name the Claude API. An Anthropic-format gateway in front of another model serves neither, so a
 * chat on one enables no executor, and the reason stands in every computation's refusal.
 */
export function providerExecutors(settings: ExecutorSettings = env): ProviderExecutors {
  if (settings.CODE_EXECUTION_API_KEY) {
    return {
      executors: [
        createCodeExecutor({
          baseUrl: settings.CODE_EXECUTION_API_URL,
          apiKey: settings.CODE_EXECUTION_API_KEY,
          model: settings.CODE_EXECUTION_MODEL,
        }),
      ],
      unavailable: [],
    };
  }
  if (!settings.ANTHROPIC_API_KEY) {
    return {
      executors: [],
      unavailable: [
        `${CODE_EXECUTOR_ID} is off: this deployment holds no ANTHROPIC_API_KEY or CODE_EXECUTION_API_KEY for the Claude API`,
      ],
    };
  }
  if (!isClaudeApi(settings.ANTHROPIC_API_URL)) {
    // the host stays in the operator's log: the reason is read by every asker a computation refuses
    logger.info(
      { executor: CODE_EXECUTOR_ID, chatHost: new URL(settings.ANTHROPIC_API_URL).host },
      'code execution: off, the chat runs on a gateway',
    );
    return {
      executors: [],
      unavailable: [
        `${CODE_EXECUTOR_ID} is off: the chat's ANTHROPIC_API_URL is a gateway, not the Claude API (${CLAUDE_API_ORIGIN}) that serves the Files API and the code execution tool; the operator sets CODE_EXECUTION_API_KEY to a Claude API key to enable it`,
      ],
    };
  }
  return {
    executors: [
      createCodeExecutor({
        baseUrl: settings.ANTHROPIC_API_URL,
        apiKey: settings.ANTHROPIC_API_KEY,
        model: settings.ANTHROPIC_MODEL,
      }),
    ],
    unavailable: [],
  };
}
