/** Registers the one chat adapter, the model gateway (REQ-19): an OpenAI-compatible endpoint at LITELLM_API_URL with LITELLM_API_KEY. No provider is ever reached directly, so no provider key is read; registering nothing lets the app start with chat unconfigured, and a turn then refuses naming the setting that is missing. */

import { env } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { createOpenAIProvider } from './openai.js';
import { listProviders, register } from './registry.js';

const GATEWAY_PROVIDER_ID = 'openai';

/** Variables of the removed direct-provider adapter: still set on an instance, they are read by nothing. */
const RETIRED_PROVIDER_VARS = [
  'ANTHROPIC_API_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_MAX_TOKENS',
] as const;

/** The gateway settings this instance lacks, by name; empty when chat is configured. */
export function missingGatewaySettings(): string[] {
  return [
    ...(env.LITELLM_API_URL ? [] : ['LITELLM_API_URL']),
    ...(env.LITELLM_API_KEY ? [] : ['LITELLM_API_KEY']),
  ];
}

export function bootstrapChatProviders(): void {
  const retired = RETIRED_PROVIDER_VARS.filter((name) => process.env[name]);
  if (retired.length > 0) {
    logger.error(
      { retired },
      `chat provider: ${retired.join(', ')} ${retired.length === 1 ? 'is' : 'are'} set but read by nothing: models are reached only through the gateway (LITELLM_API_URL + LITELLM_API_KEY); remove ${retired.length === 1 ? 'it' : 'them'} from the instance environment`,
    );
  }
  const missing = missingGatewaySettings();
  if (missing.length > 0) {
    logger.info(
      { missing },
      `chat provider: none configured (${missing.join(' and ')} not set: models are reached only through the gateway)`,
    );
    return;
  }
  register(GATEWAY_PROVIDER_ID, () =>
    createOpenAIProvider({
      baseUrl: env.LITELLM_API_URL as string,
      apiKey: env.LITELLM_API_KEY as string,
      defaultModel: env.LITELLM_MODEL,
    }),
  );
  logger.info({ model: env.LITELLM_MODEL }, 'chat provider registered: gateway');
}

export function defaultChatProviderId(): string | undefined {
  return listProviders().includes(GATEWAY_PROVIDER_ID) ? GATEWAY_PROVIDER_ID : undefined;
}
