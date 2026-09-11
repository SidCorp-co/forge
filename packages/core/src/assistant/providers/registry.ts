/**
 * v1 EPIC 1 (ISS-270) — Chat provider registry (same convention as the runner-framework registry, ISS-271). Providers register at bootstrap; `resolveForProject` reads `app_config.chat_provider_id` and falls back to the env default, and picks the model per turn kind — an `agentic` turn (tools offered) and a `relay` turn (tool-less prose, e.g. escalation synthesis) may run different models on one provider via `app_config.chat_model_by_kind`.
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

export const chatTurnKinds = ['agentic', 'relay'] as const;
export type ChatTurnKind = (typeof chatTurnKinds)[number];

export interface ResolvedChatProvider {
  provider: ChatProvider;
  model: string;
}

export interface ResolveOptions {
  db?: typeof defaultDb | undefined;
  fallbackProviderId?: string | undefined;
  fallbackModel?: string | undefined;
  kind?: ChatTurnKind | undefined;
}

// cm:guard tolerate any shape in the jsonb (non-object, non-string entry) by returning undefined — an operator can PUT this map by hand and a throw here would 503 every chat turn on the project instead of falling to `chat_model`
function modelForKind(byKind: unknown, kind: ChatTurnKind): string | undefined {
  if (!byKind || typeof byKind !== 'object') return undefined;
  const value = (byKind as Record<string, unknown>)[kind];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** `app_config.chat_provider_id` when registered (model: `chat_model_by_kind[kind]` → `chat_model` → provider default), else the env fallback id; throws 503 when neither resolves. */
export async function resolveForProject(
  projectId: string,
  opts: ResolveOptions = {},
): Promise<ResolvedChatProvider> {
  const dbi = opts.db ?? defaultDb;
  const [row] = await dbi
    .select({
      chatProviderId: appConfig.chatProviderId,
      chatModel: appConfig.chatModel,
      chatModelByKind: appConfig.chatModelByKind,
    })
    .from(appConfig)
    .where(eq(appConfig.projectId, projectId))
    .limit(1);

  const candidates: Array<{ id: string | null | undefined; model: string | null | undefined }> = [
    {
      id: row?.chatProviderId,
      model: modelForKind(row?.chatModelByKind, opts.kind ?? 'agentic') ?? row?.chatModel,
    },
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
