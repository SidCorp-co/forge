// The chat port's one way to a provider: the deployment's model, with every request it carries
// passed through the project's egress policy on the way out.

import type { SensitiveDataLevel } from '@forge/contracts/data-policy';
import {
  dataPolicyOf,
  EgressRefused,
  type EgressScope,
  type EgressSurface,
  egressAt,
} from '../../lib/data-egress.js';
import { isRefusal } from '../../lib/refusal.js';
import { defaultChatProviderId } from './bootstrap.js';
import { resolveChatProvider } from './registry.js';
import type { ChatMessage, ChatProvider, ChatStreamUsage } from './types.js';

/** The deployment's chat model name; refuses ASSISTANT_MODEL_NOT_CONFIGURED (503) when none is. */
export function chatModelName(): string {
  return resolveChatProvider(defaultChatProviderId()).model;
}

/**
 * The deployment's chat provider, gated by `scope`'s egress policy. A surface the level withholds is
 * refused here (`EgressRefused`) before the provider is resolved; otherwise every request's messages
 * are scrubbed at that level as they leave. The system prompt is Forge's own text and an assistant
 * message that carries tool calls is the model's own output of this turn, so both leave as written.
 */
export async function openChat(
  scope: EgressScope,
): Promise<{ provider: ChatProvider; model: string }> {
  const what = scope.what ?? scope.surface;
  const level = await levelOf(scope, what);
  const gate = egressAt(level, scope.surface, null, what);
  if (!gate.ok) throw new EgressRefused(gate.refusal);
  const resolved = resolveChatProvider(defaultChatProviderId());
  return { provider: gated(resolved.provider, level, scope.surface, what), model: resolved.model };
}

async function levelOf(scope: EgressScope, what: string): Promise<SensitiveDataLevel> {
  if ('level' in scope) return scope.level;
  if ('projectId' in scope) return dataPolicyOf(scope.projectId);
  // A product surface leaves exactly as stored at every level.
  if (egressAt('no_egress', scope.surface, null, what).ok) return 'off';
  throw new Error(
    `llm.chat: ${what} is ${scope.surface} content, which is not product, and reached the chat adapter with no projectId or level to read its policy`,
  );
}

function gated(
  provider: ChatProvider,
  level: SensitiveDataLevel,
  surface: EgressSurface,
  what: string,
): ChatProvider {
  const outbound = (m: ChatMessage): ChatMessage => {
    if (m.role === 'system' || m.tool_calls) return m;
    const out = egressAt(level, surface, m.content, what);
    if (!out.ok) throw new EgressRefused(out.refusal);
    return { ...m, content: out.value };
  };
  return {
    id: provider.id,
    defaultModel: provider.defaultModel,
    stream: (req) => provider.stream({ ...req, messages: req.messages.map(outbound) }),
  };
}

/**
 * Why a one-shot completion has no answer: the project's policy withholds the request, no chat model
 * is configured on this instance, or the call failed (the provider's own message is in `detail`).
 */
export type CompletionMiss = 'withheld' | 'unconfigured' | 'failed';

export type CompletionAnswer =
  | { ok: true; text: string; model: string; usage: ChatStreamUsage }
  | { ok: false; miss: CompletionMiss; detail: string; model: string | null };

/**
 * One tool-less completion through `openChat`, so the deployment's provider and `scope`'s egress
 * policy apply exactly as they do to a chat turn: a request the policy withholds is never sent. The
 * stream is drained to its text and the usage it reported; nothing is thrown.
 */
export async function completeOnce(
  scope: EgressScope,
  messages: ChatMessage[],
  opts: { temperature?: number; signal?: AbortSignal } = {},
): Promise<CompletionAnswer> {
  let opened: { provider: ChatProvider; model: string };
  try {
    opened = await openChat(scope);
  } catch (err) {
    if (err instanceof EgressRefused) {
      return { ok: false, miss: 'withheld', detail: err.message, model: null };
    }
    if (isRefusal(err, 'ASSISTANT_MODEL_NOT_CONFIGURED')) {
      return { ok: false, miss: 'unconfigured', detail: err.message, model: null };
    }
    return { ok: false, miss: 'failed', detail: String(err), model: null };
  }
  const { provider, model } = opened;
  const usage: ChatStreamUsage = {};
  let text = '';
  try {
    for await (const event of provider.stream({
      model,
      messages,
      temperature: opts.temperature,
      signal: opts.signal,
    })) {
      if (event.type === 'chunk') text += event.text;
      else if (event.type === 'usage') {
        for (const key of [
          'promptTokens',
          'completionTokens',
          'totalTokens',
          'cachedPromptTokens',
        ] as const) {
          const n = event.usage[key];
          if (n !== undefined) usage[key] = (usage[key] ?? 0) + n;
        }
      } else if (event.type === 'error') {
        return { ok: false, miss: 'failed', detail: event.message, model };
      }
    }
  } catch (err) {
    if (err instanceof EgressRefused)
      return { ok: false, miss: 'withheld', detail: err.message, model };
    return {
      ok: false,
      miss: 'failed',
      detail: err instanceof Error ? err.message : String(err),
      model,
    };
  }
  if (!text.trim())
    return { ok: false, miss: 'failed', detail: 'the model answered no text', model };
  return { ok: true, text, model, usage };
}
