// The chat room as a door into conversations and the assistant: what the Rocket.Chat connection
// hands over is collected into its conversation here, and a reply in a thread Forge opened goes
// to the issue or question that owns it.

import { consumeIssueThreadReply, consumeQuestionThreadReply } from '../../assistant/index.js';
import { webBaseUrl } from '../../config/web-base-url.js';
import {
  FIXED_REPLY_CONSTANT,
  provideRoomHandlers,
  rocketChatManager,
  sendFixedReply,
} from '../../integrations/rocketchat/index.js';
import { logger } from '../../observability/logger.js';
import { collectInboundMessage } from '../collect-inbound.js';
import { registerConversationTransport } from '../ports.js';
import { type RocketChatFrame, rocketChatConversationPorts } from './port.js';
import { drainConversationWindows } from './window-drain.js';

/** Hands the connection its handlers and registers the room transport. Called once at boot. */
export function registerRoomChat(): void {
  registerConversationTransport(rocketChatConversationPorts);
  provideRoomHandlers({
    threadReply: ({ subject, connectionId, ac, m }) => {
      if (subject.kind === 'question') {
        consumeQuestionThreadReply({ questionId: subject.questionId, connectionId, ac, m });
      } else {
        consumeIssueThreadReply({
          issueId: subject.issueId,
          retired: subject.retired,
          connectionId,
          ac,
          m,
        });
      }
    },
    collect: async ({ connectionId, ac, route, m, shape }) => {
      const logCtx = { connectionId, rid: m.rid, msgId: m.id, projectId: route.projectId };
      const frame: RocketChatFrame = {
        m,
        auth: { serverUrl: ac.serverUrl, authToken: ac.authToken, userId: ac.botUserId },
        projectId: route.projectId,
        shape,
      };
      const outcome = await collectInboundMessage({
        ports: rocketChatConversationPorts,
        frame,
        message: m.text,
        speakerKey: m.userId,
        speakerLabel: m.username ?? null,
        externalMessageId: m.id,
        replyToExternalId: m.replyToId ?? null,
        images: m.images,
      });
      if (outcome.kind === 'venue-unresolved') {
        logger.error(
          logCtx,
          'rocketchat: venue unresolved; refusing the message, not inventing one',
        );
        // The one reply the room is sent without a turn: a direct message from somebody whose
        // account is not linked is told why, since no conversation can hold it.
        if (shape !== 'direct' || !ac.client) return;
        const speaker = await rocketChatConversationPorts.resolveSpeaker(frame);
        if (speaker.linked) return;
        await sendFixedReply(
          { kind: 'ddp', client: ac.client, rid: m.rid, tmid: m.tmid, authToken: ac.authToken },
          speaker.refusal.message,
          FIXED_REPLY_CONSTANT,
        );
        return;
      }
      logger.debug(
        { ...logCtx, windowId: outcome.windowId, seq: outcome.seq },
        'rocketchat: collected',
      );
    },
  });
}

/** Settle and route every window this process's connections owe an answer (a process timer). */
export async function drainRoomWindows(): Promise<void> {
  if (!rocketChatManager.isStarted()) return;
  await drainConversationWindows(rocketChatManager.connections(), webBaseUrl());
}
