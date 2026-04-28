/**
 * v1 EPIC 1 (ISS-270) — Chat provider registry.
 *
 * Mirrors the runner-framework registry pattern (ISS-271) so a future reader
 * sees one convention. Providers register at bootstrap; consumers either
 * resolve directly by id (`get(...)`) or by project (`resolveForProject(...)`)
 * which reads `app_config.chat_provider_id` then falls back to env defaults.
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

export function unregister(id: string): void {
  factories.delete(id);
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
  /** Override the default DB client (for tests). */
  db?: typeof defaultDb | undefined;
  /** Default provider id when `app_config` is empty (env-driven). */
  fallbackProviderId?: string | undefined;
  /** Default model when neither `app_config.chat_model` nor provider default fits. */
  fallbackModel?: string | undefined;
}

/**
 * Resolve the provider + model to use for a project. Order:
 *   1. `app_config.chat_provider_id` (if registered) — model from
 *      `app_config.chat_model` else provider default.
 *   2. Fallback provider id (env-driven, e.g. whichever of LITELLM/GEMINI
 *      is configured) — model from fallback or provider default.
 *
 * Throws 503 when no provider can be resolved so callers can return a
 * structured error to the client.
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
