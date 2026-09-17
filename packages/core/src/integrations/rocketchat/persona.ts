// What is true in a Rocket.Chat room, and this door's arrangement of the layers.
//
// The text itself — the method, the link rule and the room's own five lines — lives under
// `assistant/prompt/` since ISS-1057, one module per layer. This file is the adapter's door onto
// that composition and holds no prose of its own.

import {
  MID_CONVERSATION_INSTRUCTION,
  rocketChatDoorLines,
  rocketChatDoorPersona,
} from '../../assistant/door-persona.js';
import type { ConversationWindowCutReason } from '../../db/schema-conversations.js';

/**
 * The room line a cut reason earns: the instruction for a window cut before quiet, nothing for one that settled.
 */
// cm:guard `quiet` and an ABSENT reason both fold to null, and the two are the same case on purpose: a row claimed before ISS-1086 carries no reason, and the router already reads it as quiet and says so in its detail — a second reading here would let the two disagree.
export function midConversationLine(
  cut: ConversationWindowCutReason | null | undefined,
): string | null {
  return cut === 'deadline' || cut === 'overflow' ? MID_CONVERSATION_INSTRUCTION : null;
}

/**
 * What is true of a Rocket.Chat room and of no other door.
 */
// cm:edge contract -> packages/core/src/assistant/prompt/door-rocketchat.ts — the five lines this returns are that layer's text; the guards on why each is room-only live there.
export function rocketChatChannelLines(
  authorUsername?: string,
  opts?: { botName?: string | undefined; cut?: ConversationWindowCutReason | null | undefined },
): string[] {
  return rocketChatDoorLines(opts?.botName, authorUsername, midConversationLine(opts?.cut));
}

export function rocketChatPersona(
  projectName: string,
  authorUsername?: string,
  opts?: {
    projectSlug?: string | undefined;
    webBaseUrl?: string | undefined;
    botName?: string | undefined;
    /** Why the window this turn answers stopped collecting (ISS-1086). */
    cut?: ConversationWindowCutReason | null | undefined;
  },
): string {
  return rocketChatDoorPersona(
    {
      projectName,
      venue: "answering inside the team's Rocket.Chat channel",
      projectSlug: opts?.projectSlug,
      webBaseUrl: opts?.webBaseUrl,
    },
    { botName: opts?.botName, authorUsername, midConversation: midConversationLine(opts?.cut) },
  );
}
