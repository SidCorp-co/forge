import {
  MID_CONVERSATION_INSTRUCTION,
  rocketChatDoorLines,
  rocketChatDoorPersona,
} from '../../assistant/door-persona.js';
import type { ConversationWindowCutReason } from '../../db/schema-conversations.js';

/**
 * The room line a cut reason earns: the instruction for a window cut before quiet, nothing for one that settled.
 */
export function midConversationLine(
  cut: ConversationWindowCutReason | null | undefined,
): string | null {
  return cut === 'deadline' || cut === 'overflow' ? MID_CONVERSATION_INSTRUCTION : null;
}

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
