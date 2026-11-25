/**
 * Per-turn-volatile context — the recent room discussion (Rocket.Chat), the page the user is on
 * (web) — rides on the NEWEST user message, not the system prompt: a changed byte there invalidates
 * the cached prefix `tools[]` sits in. Applied to the provider copy only, never persisted.
 */

import type { ReplyLanguage } from '../conversations/index.js';
import type { ChatContentPart, ChatMessage } from '../integrations/llm/index.js';

const LANGUAGE_NAME: Record<ReplyLanguage, string> = { en: 'English', vi: 'Vietnamese' };

export interface TurnContext {
  conversationContext?: string | null | undefined;
  pageContext?: Record<string, unknown> | null | undefined;
  /** What is known about the person the newest message is from — `preference-line.ts` renders it (ISS-1034). */
  speakerContext?: string | null | undefined;
  /** The language the turn answers in, where one is known (`replyLanguageBy` says who said so). */
  replyLanguage?: ReplyLanguage | null | undefined;
  /** `project`: its content language, said as the rule. `guess`, or unset: a hint about this message, said as one. */
  replyLanguageBy?: 'project' | 'guess' | undefined;
}

/** Said beside the message itself, so it is the last thing read before the first token. */
function replyLanguageLine(language: ReplyLanguage, by: 'project' | 'guess' | undefined): string {
  const name = LANGUAGE_NAME[language];
  const kept =
    'whatever language the tool results, the project knowledge or earlier replies are in. Ids, status names, refusal codes and code stay as they are.';
  if (by === 'project') {
    return `Reply language: this project writes in ${name}. Write your whole reply in ${name} from its first word, ${kept}`;
  }
  return `Reply language (a hint from the words of this message): it reads as ${name}. Unless the person clearly wrote in another language, write your whole reply in ${name} from its first word, ${kept}`;
}

function renderTurnContext(ctx: TurnContext): string | null {
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
  const speaker = ctx.speakerContext?.trim();
  if (speaker) sections.push(speaker);
  if (ctx.replyLanguage) sections.push(replyLanguageLine(ctx.replyLanguage, ctx.replyLanguageBy));
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
