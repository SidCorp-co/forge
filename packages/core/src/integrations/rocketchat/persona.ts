// What is true in a Rocket.Chat room and nowhere else.
//
// The method this file used to carry — investigate before answering, act rather
// than delegate, what a reply owes, what an issue must contain — is the guide
// `assistant/door-persona.ts` points every door at. Five things stayed, because
// each is false at another door.

import { assistantOpening } from '../../assistant/door-persona.js';

/**
 * What is true of a Rocket.Chat room and of no other door.
 */
// cm:guard the one-reply rule may NOT be hoisted into the guide: a room turn is one message with no follow-up, and the Forge web app is multi-turn, so the same sentence read at the web door forbids a clarifying question that surface is built to allow (ISS-1007).
// cm:guard `rocketchat_history` is named here and only here because it is this adapter's own tool; a door that does not have it reading an instruction to call it is told to use a tool it was never given (ISS-1007).
export function rocketChatChannelLines(
  authorUsername?: string,
  opts?: { botName?: string | undefined },
): string[] {
  return [
    ...(opts?.botName
      ? [
          // cm:ignore CM001 — the literal below must carry the Vietnamese it governs: shows the Vietnamese self-reference style being mandated
          `- Your name in this channel is ${opts.botName}. Refer to yourself as "${opts.botName}" (e.g. "${opts.botName} đã kiểm tra…"), never as "hệ thống" or "the system".`, // i18n-allow: shows the Vietnamese self-reference style being mandated
        ]
      : []),
    ...(authorUsername
      ? [
          // cm:ignore CM001 — the literal below must carry the Vietnamese it governs: quotes the Vietnamese first-person pronouns the prompt must resolve
          `- The message you are answering was sent by user @${authorUsername}. When they say "tôi/mình/my/me", they mean @${authorUsername} — use that username when filtering tasks/items by person.`, // i18n-allow: quotes the Vietnamese first-person pronouns the prompt must resolve
        ]
      : []),
    '- Read the conversation context first; if it references older discussion, call rocketchat_history before concluding.',
    '- Your reply is the ONLY message the user receives — there is no follow-up turn, so do not promise a later one.',
    '- Plain chat text, no markdown headers.',
  ];
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
  return [
    ...assistantOpening({
      projectName,
      venue: "answering inside the team's Rocket.Chat channel",
      projectSlug: opts?.projectSlug,
      webBaseUrl: opts?.webBaseUrl,
    }),
    ...rocketChatChannelLines(authorUsername, { botName: opts?.botName }),
  ].join('\n');
}
