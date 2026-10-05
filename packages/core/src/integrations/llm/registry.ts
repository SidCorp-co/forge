/**
 * v1 EPIC 1 (ISS-270) — Chat provider registry (same convention as the runner-framework registry, ISS-271). Providers register at bootstrap; `resolveChatProvider` answers the deployment's provider and its default model.
 */

import { HTTPException } from 'hono/http-exception';
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

/** The provider registered under `providerId` (the env default) with `model` or its default; 503 when none resolves. */
export function resolveChatProvider(
  providerId: string | undefined,
  model?: string,
): ResolvedChatProvider {
  const provider = providerId ? get(providerId) : undefined;
  if (provider) return { provider, model: model ?? provider.defaultModel };
  throw new HTTPException(503, {
    message: 'no chat provider configured',
    cause: { code: 'CHAT_PROVIDER_UNAVAILABLE' },
  });
}
