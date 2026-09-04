/**
 * v1 EPIC 1 (ISS-270) — Chat provider registry, mirroring the runner-framework
 * registry pattern (ISS-271) so a future reader sees one convention. Providers
 * register at bootstrap; consumers resolve directly by id (`get`) or by project
 * (`resolveForProject`), which reads `app_config.chat_provider_id` and falls
 * back to the env default.
 */

import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db as defaultDb } from '../../db/client.js';
import { appConfig } from '../../db/schema.js';
import type { ChatProvider, ChatProviderFactory } from './types.js';

const factories = new Map<string, ChatProviderFactory>();
const instances = new Map<string, ChatProvider>();

export function register(id: string, factory: ChatProviderFactory): void {
  factories.set(id, factory);
  instances.delete(id);
}

export function clearProviders(): void {
  factories.clear();
  instances.clear();
}

export function listProviders(): string[] {
  return [...factories.keys()];
}

export function get(id: string): ChatProvider | undefined {
  let instance = instances.get(id);
  if (instance) return instance;
  const factory = factories.get(id);
  if (!factory) return undefined;
  instance = factory();
  instances.set(id, instance);
  return instance;
}

export interface ResolvedChatProvider {
  provider: ChatProvider;
  model: string;
}

export interface ResolveOptions {
  db?: typeof defaultDb | undefined;
  fallbackProviderId?: string | undefined;
  fallbackModel?: string | undefined;
}

/**
 * Resolve the provider + model for a project: `app_config.chat_provider_id`
 * when that id is registered (model from `app_config.chat_model`, else the
 * provider's default), otherwise the env-driven fallback id from
 * `defaultChatProviderId()`. Throws 503 when neither resolves, so callers can
 * return a structured error to the client.
 */
export async function resolveForProject(
  projectId: string,
  opts: ResolveOptions = {},
): Promise<ResolvedChatProvider> {
  const dbi = opts.db ?? defaultDb;
  const [row] = await dbi
    .select({
      chatProviderId: appConfig.chatProviderId,
      chatModel: appConfig.chatModel,
    })
    .from(appConfig)
    .where(eq(appConfig.projectId, projectId))
    .limit(1);

  const candidates: Array<{ id: string | null | undefined; model: string | null | undefined }> = [
    { id: row?.chatProviderId, model: row?.chatModel },
    { id: opts.fallbackProviderId, model: opts.fallbackModel },
  ];

  for (const c of candidates) {
    if (!c.id) continue;
    const provider = get(c.id);
    if (!provider) continue;
    return { provider, model: c.model ?? provider.defaultModel };
  }

  throw new HTTPException(503, {
    message: 'no chat provider configured',
    cause: { code: 'CHAT_PROVIDER_UNAVAILABLE' },
  });
}
