/**
 * Rocket.Chat's `agent` answer mode, as a caller of the neutral lane.
 *
 * ISS-727 built the runner-hosted turn here, in this transport's own
 * vocabulary. ISS-1039 moved the lane itself to
 * `agent-sessions/conversation-agent.ts`, where a turn is about a venue, a
 * window and a delivery key, and made the Forge UI's Agent mode its second
 * caller. What is left in this file is what is genuinely Rocket.Chat's: the
 * four sentences a room is answered with, the ack a slow turn posts, and the
 * product voice this bot speaks in.
 */
// cm:ignore CM013 — every frozen comment in this file is an `i18n-allow` lint pragma; deleting one to pay the drain would break the language gate instead of cleaning prose.
// cm:guard this module never posts to the room itself — the completion bridge is the only path its output reaches a channel.

import {
  type ConversationAgentTurnResult,
  startConversationAgentTurn,
} from '../../agent-sessions/conversation-agent.js';
import type { ConversationVenue } from '../../conversations/ports.js';
import { parseRocketChatVenueId } from './conversation-port.js';
import { hasInFlightRoomSession } from './room-delivery.js';

// cm:guard under this delay the room sees NO ack at all — the bridge delivers the real answer first, which is the common case; only a genuinely slow turn ever shows one.
export const AGENT_CHAT_ACK_DELAY_MS = 2 * 60 * 1000;

export const AGENT_CHAT_ACK = (botName: string): string =>
  `${botName} đang xử lý câu hỏi này qua trợ lý đầy đủ, lát nữa quay lại trả lời bạn nhé.`; // i18n-allow: user-facing channel reply

export const AGENT_CHAT_DEDUP_REPLY = (botName: string): string =>
  `${botName} vẫn đang xử lý câu hỏi trước đó trong cuộc trò chuyện này, chờ thêm chút nhé.`; // i18n-allow: user-facing channel reply

export const AGENT_CHAT_NO_DEVICE_REPLY = (botName: string): string =>
  `Xin lỗi, hiện không có runner nào sẵn sàng để ${botName} trả lời đầy đủ câu hỏi này — bạn thử lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

// cm:why ISS-818 — states WHY (figures unreconciled), not a bare "couldn't verify" that reads as "didn't understand you" and sends the user off to rephrase.
export const AGENT_CHAT_FALLBACK_REPLY = (botName: string): string =>
  `Xin lỗi, ${botName} chưa đối chiếu được số liệu dự án nên không dám gửi câu trả lời chưa chắc chắn — không phải do câu hỏi của bạn, bạn hỏi lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

export interface StartAgentChatArgs {
  /** The room, as the conversation store addresses it — not a rid and a tmid. */
  venue: ConversationVenue;
  conversationId: string;
  windowId: string;
  deliveryKey: string;
  project: { id: string; slug: string; repoPath: string | null };
  botName: string;
  message: string;
  askedByUsername?: string | undefined;
  // cm:guard the persona is passed IN, never built here — importing `connection-manager.ts` for it would create a dependency back on this module's own caller.
  persona: string;
  conversationContext?: string | null | undefined;
}

export type StartAgentChatResult = ConversationAgentTurnResult;

/**
 * Hand one Rocket.Chat turn to a runner-hosted session.
 */
// cm:guard the `product` lens and the Vietnamese sentences are supplied HERE and not defaulted in the neutral lane: they are what a Rocket.Chat room is answered in, and a lane holding them would be choosing a voice for the Forge UI too.
// cm:hack ISS-1039 until: no agent_sessions row with a non-terminal status carries a metadata.agentChat key
// The neutral lane's "one live turn per room" is keyed on the CONVERSATION, and a session dispatched
// before this change is keyed on a rid and a tmid — so across the deploy the two exclusions cannot
// see each other, and a second question in a room whose old-format turn is still running would start
// a second box. Priced: one extra indexed read per Rocket.Chat agent turn, on the dispatch path
// only, retired with the legacy bridge by the condition above (commit consult F3).
async function legacyTurnStillRunning(args: StartAgentChatArgs): Promise<boolean> {
  const parts = parseRocketChatVenueId(args.venue.externalId);
  if (!parts) return false;
  return hasInFlightRoomSession(args.project.id, parts.rid, 'agentChat', parts.tmid);
}

export async function startAgentChat(args: StartAgentChatArgs): Promise<StartAgentChatResult> {
  if (await legacyTurnStillRunning(args)) {
    return { started: false, reason: 'deduped' };
  }
  return startConversationAgentTurn({
    venue: args.venue,
    conversationId: args.conversationId,
    windowId: args.windowId,
    deliveryKey: args.deliveryKey,
    project: args.project,
    handleName: args.botName,
    question: args.message,
    askedByLabel: args.askedByUsername ? `@${args.askedByUsername}` : null,
    persona: args.persona,
    conversationContext: args.conversationContext,
    door: 'agent-chat-completion',
    replies: {
      dedup: AGENT_CHAT_DEDUP_REPLY(args.botName),
      noDevice: AGENT_CHAT_NO_DEVICE_REPLY(args.botName),
      failed: AGENT_CHAT_FALLBACK_REPLY(args.botName),
      ack: AGENT_CHAT_ACK(args.botName),
    },
    ackAfterMs: AGENT_CHAT_ACK_DELAY_MS,
    forceLenses: ['product'],
  });
}
