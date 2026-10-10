// Agent mode in the Forge UI: a turn is dispatched to a paired device with the room's earlier
// messages, or the thread is told why it was not.

import { agentRefusalText } from '../agent-sessions/index.js';
import {
  AGENT_TURN_NEXT_STEP,
  type ConversationAgentTurnResult,
  type ConversationWindowRow,
  codeAuthored,
  type ReplyLanguage,
  readMessages,
} from '../conversations/index.js';
import type { TurnAuthority } from '../credentials/turn-credential.js';
import { webAgentConversationPersona } from './door-persona.js';
import { turnPageContext } from './page-item.js';
import { askerLineLanguage, askerWithRole } from './turn-asker.js';
import type { TurnReply } from './turn-request.js';
import type { WebTurnArgs } from './web-turn-args.js';

/**
 * What the thread is shown when an Agent turn has no answer to give it. English only (owner ruling,
 * ISS-403). A crash, a timeout and a box that cannot confine are read from the session's own cause
 * by the bridge (`conversations/conversation-agent-failure.ts`); `failed` is kept for an ending none
 * of those names.
 */
const WEB_AGENT_REPLIES = {
  dedup:
    'This conversation already has an Agent turn running. Wait for it to answer, or open another conversation to ask something else in parallel.',
  noDevice:
    'No paired device is free to take this turn right now. Try again in a few minutes, or open a new conversation in Assistant mode for anything that does not need the repository.',
  failed:
    'The Agent session ended without an answer. Ask again — a new turn starts a fresh session — or open a conversation in Assistant mode if the question does not need the repository.',
  ack: null,
} as const;

/** A turn refused because its box cannot confine a chat: the refusal names the box and why. */
function cannotConfineReply(refusal: string): string {
  return `Agent mode did not run this turn. ${refusal} ${AGENT_TURN_NEXT_STEP['box-cannot-confine']}`;
}

const ATTACHMENT_UNREADABLE = {
  en: (file: string) =>
    `I could not send ${file} to the box that answers in Agent mode, so I have not answered rather than answering without it. Attach it again, or ask in Assistant mode, where I read it here.`,
  vi: (file: string) =>
    `Mình không gửi được ${file} tới máy trả lời ở chế độ Agent, nên chưa trả lời thay vì trả lời khi thiếu nó. Bạn đính kèm lại, hoặc hỏi ở chế độ Assistant, nơi mình đọc được tệp ngay tại đây.`, // i18n-allow: user-facing channel reply
} as const;

const ATTACHMENT_NAMELESS = { en: 'the file you attached', vi: 'tệp bạn đính kèm' } as const; // i18n-allow: user-facing channel reply

/** Agent mode: the turn is dispatched to a paired device, or the thread is told why it was not. */
export async function divertToAgent(
  args: WebTurnArgs,
  setPhase: (phase: string) => void,
  authority: TurnAuthority,
): Promise<TurnReply | null> {
  if (args.window.mode !== 'agent' || authority.origin === 'onboarding_handoff') return null;
  setPhase('agent-turn');
  const language = await askerLineLanguage(args);
  if (!(await args.window.reserve()))
    return { send: false, reason: 'superseded-before-agent-turn', ended: 'superseded' };
  const { startConversationAgentTurn } = await import('../conversations/index.js');
  const started = await startConversationAgentTurn({
    venue: args.window.venue,
    conversationId: args.window.conversationId,
    windowId: args.window.windowId,
    deliveryKey: args.window.deliveryKey,
    project: { id: args.project.id, slug: args.project.slug },
    handleName: args.handleName,
    question: args.window.question,
    askedByLabel: args.askedBy,
    asker: authority,
    conversationContext: await args.window.conversationContext(),
    pageContext: await turnPageContext({
      conversationId: args.window.conversationId,
      projectId: args.project.id,
      userId: authority.userId,
    }),
    ...(args.window.images.length ? { images: args.window.images } : {}),
    persona: webAgentConversationPersona(
      args.project,
      await askerWithRole(args.project.id, authority.userId, args.askedBy),
    ),
    door: 'web-agent-completion',
    replies: WEB_AGENT_REPLIES,
    ackAfterMs: null,
  });
  if (started.started) return { send: false, reason: 'agent-turn-dispatched' };
  const text = notStartedText(started, language);
  if (text === null)
    return { send: false, reason: 'agent-turn-dispatch-failed', ended: 'not-dispatched' };
  return { send: true, message: codeAuthored(text), screenReplaced: false };
}

/**
 * What the thread is told about a turn that never reached a box, or null for a hand-over that threw:
 * that session's bridge reads its cause to the room.
 */
function notStartedText(
  started: Extract<ConversationAgentTurnResult, { started: false }>,
  language: ReplyLanguage,
): string | null {
  switch (started.reason) {
    case 'deduped':
      return WEB_AGENT_REPLIES.dedup;
    case 'no-device':
      return WEB_AGENT_REPLIES.noDevice;
    case 'runner-outdated':
    case 'authority-refused':
      return agentRefusalText(started, language);
    case 'attachment-unreadable':
      return ATTACHMENT_UNREADABLE[language](started.file ?? ATTACHMENT_NAMELESS[language]);
    case 'box-cannot-confine':
      if (!started.message) {
        throw new Error(
          'web-turn-inputs: a turn refused BOX_CANNOT_CONFINE_CHAT carried no sentence naming the box',
        );
      }
      return cannotConfineReply(started.message);
    case 'dispatch-failed':
      return null;
  }
}

/**
 * How many earlier messages a diverted turn is handed.
 */
const AGENT_CONTEXT_MESSAGES = 20;

export async function agentConversationContext(
  window: ConversationWindowRow,
): Promise<string | null> {
  const before = (await readMessages(window.conversationId, AGENT_CONTEXT_MESSAGES + 1)).filter(
    (m) => m.seq < window.firstSeq,
  );
  if (before.length === 0) return null;
  return before
    .slice(-AGENT_CONTEXT_MESSAGES)
    .map((m) => `${m.authorLabel ?? (m.role === 'assistant' ? 'Assistant' : m.role)}: ${m.content}`)
    .join('\n');
}
