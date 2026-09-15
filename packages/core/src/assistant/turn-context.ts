/**
 * Per-turn-volatile context — the recent room discussion (Rocket.Chat), the page the user is on
 * (web) — rides on the NEWEST user message, not the system prompt: a changed byte there invalidates
 * the cached prefix `tools[]` sits in. Applied to the provider copy only, never persisted.
 */

import type { ChatContentPart, ChatMessage } from './providers/types.js';

export interface TurnContext {
  conversationContext?: string | null | undefined;
  pageContext?: Record<string, unknown> | null | undefined;
  /** What is known about the person the newest message is from — `preference-line.ts` renders it (ISS-1034). */
  speakerContext?: string | null | undefined;
}

export function renderTurnContext(ctx: TurnContext): string | null {
  const sections: string[] = [];
  const conversation = ctx.conversationContext?.trim();
  if (conversation) {
    sections.push(
      `Conversation context — the discussion that led to this message (if it references older matter, use the available history tools before concluding):\n${conversation}`,
    );
  }
  if (ctx.pageContext && Object.keys(ctx.pageContext).length > 0) {
    sections.push(`Page context:\n${JSON.stringify(ctx.pageContext, null, 2)}`);
  }
  // cm:guard on the newest USER message with the other volatile context and never in the system prompt: the speaker changes between turns in a group room, and a byte that moves in the system message is the cached prefix `tools[]` sits in gone for every round of the turn (ISS-1034).
  const speaker = ctx.speakerContext?.trim();
  if (speaker) sections.push(speaker);
  return sections.length > 0 ? sections.join('\n\n') : null;
}

function prefixContent(
  content: ChatMessage['content'],
  prefix: string,
): string | ChatContentPart[] {
  if (typeof content === 'string') return `${prefix}\n\n---\n\n${content}`;
  if (Array.isArray(content)) return [{ type: 'text', text: prefix }, ...content];
  return prefix;
}

// cm:guard not a second `system` message and not its own `user` message — LiteLLM hoists every system role into Gemini's `system_instruction`, which puts the volatile block back in the cacheable prefix, and a standalone user message breaks Gemini's role alternation; the prefix on the newest user turn is the only placement that is both cache-neutral and provider-neutral
export function applyTurnContext(
  messages: readonly ChatMessage[],
  ctx: TurnContext,
): ChatMessage[] {
  const prefix = renderTurnContext(ctx);
  if (!prefix) return [...messages];
  const newest = messages.map((m) => m.role).lastIndexOf('user');
  if (newest === -1) return [...messages];
  const target = messages[newest] as ChatMessage;
  return messages.map((m, i) =>
    i === newest ? { ...target, content: prefixContent(target.content, prefix) } : m,
  );
}
