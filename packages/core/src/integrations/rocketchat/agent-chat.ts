// every frozen comment in this file is an `i18n-allow` lint pragma; deleting one to pay the drain would break the language gate instead of cleaning prose.

import {
  type ConversationAgentTurnResult,
  startConversationAgentTurn,
} from '../../agent-sessions/conversation-agent.js';
import type { ConversationVenue } from '../../conversations/ports.js';
import { parseRocketChatVenueId } from './conversation-port.js';
import { hasInFlightRoomSession } from './room-delivery.js';

export const AGENT_CHAT_ACK_DELAY_MS = 2 * 60 * 1000;

export const AGENT_CHAT_ACK = (botName: string): string =>
  `${botName} đang xử lý câu hỏi này qua trợ lý đầy đủ, lát nữa quay lại trả lời bạn nhé.`; // i18n-allow: user-facing channel reply

export const AGENT_CHAT_DEDUP_REPLY = (botName: string): string =>
  `${botName} vẫn đang xử lý câu hỏi trước đó trong cuộc trò chuyện này, chờ thêm chút nhé.`; // i18n-allow: user-facing channel reply

export const AGENT_CHAT_NO_DEVICE_REPLY = (botName: string): string =>
  `Xin lỗi, hiện không có runner nào sẵn sàng để ${botName} trả lời đầy đủ câu hỏi này — bạn thử lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

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
  persona: string;
  conversationContext?: string | null | undefined;
}

export type StartAgentChatResult = ConversationAgentTurnResult;

/**
 * Hand one Rocket.Chat turn to a runner-hosted session.
 */
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
