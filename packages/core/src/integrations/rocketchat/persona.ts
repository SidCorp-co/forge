// What is true in a Rocket.Chat room, and this door's arrangement of the layers.
//
// The text itself — the method, the link rule and the room's own five lines — lives under
// `assistant/prompt/` since ISS-1057, one module per layer. This file is the adapter's door onto
// that composition and holds no prose of its own.

import { rocketChatDoorLines, rocketChatDoorPersona } from '../../assistant/door-persona.js';

/**
 * What is true of a Rocket.Chat room and of no other door.
 */
export function rocketChatChannelLines(
  authorUsername?: string,
  opts?: { botName?: string | undefined },
): string[] {
  return rocketChatDoorLines(opts?.botName, authorUsername);
}

export function rocketChatPersona(
  projectName: string,
  authorUsername?: string,
  opts?: {
    projectSlug?: string | undefined;
    webBaseUrl?: string | undefined;
    botName?: string | undefined;
  },
): string {
  return rocketChatDoorPersona(
    {
      projectName,
      venue: "answering inside the team's Rocket.Chat channel",
      projectSlug: opts?.projectSlug,
      webBaseUrl: opts?.webBaseUrl,
    },
    { botName: opts?.botName, authorUsername },
  );
}
