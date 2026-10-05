/**
 * v1 EPIC 1 (ISS-270) — Chat provider registry (same convention as the runner-framework registry, ISS-271). Providers register at bootstrap; `resolveChatProvider` answers the deployment's provider and its default model.
 */

import type { ConversationRefusalCode } from '@forge/contracts/conversations';
import { refuser } from '../../lib/refusal.js';
import type { ChatProvider, ChatProviderFactory } from './types.js';

const factories = new Map<string, ChatProviderFactory>();
const instances = new Map<string, ChatProvider>();

export function register(id: string, factory: ChatProviderFactory): void {
  factories.set(id, factory);
  instances.delete(id);
}

export function listProviders(): string[] {
  return [...factories.keys()];
}

function get(id: string): ChatProvider | undefined {
  let instance = instances.get(id);
  if (instance) return instance;
  const factory = factories.get(id);
  if (!factory) return undefined;
  instance = factory();
  instances.set(id, instance);
  return instance;
}

interface ResolvedChatProvider {
  provider: ChatProvider;
  model: string;
}

/** The provider registered under `providerId` (the env default) with `model` or its default; refuses ASSISTANT_MODEL_NOT_CONFIGURED (503), naming the env variables, when none resolves. */
export function resolveChatProvider(
  providerId: string | undefined,
  model?: string,
): ResolvedChatProvider {
  const provider = providerId ? get(providerId) : undefined;
  if (provider) return { provider, model: model ?? provider.defaultModel };
  throw refuser<ConversationRefusalCode>('ASSISTANT_MODEL_NOT_CONFIGURED')(
    'ASSISTANT_MODEL_NOT_CONFIGURED',
    'no chat model is configured on this instance, so Assistant mode cannot answer: set ANTHROPIC_API_KEY, or LITELLM_API_URL + LITELLM_API_KEY, in the instance .env and restart core',
  );
}
