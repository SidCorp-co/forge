/**
 * ISS-1057 — the `door-rocketchat` layer: what is true in a Rocket.Chat room and nowhere else.
 *
 * Text and its header only; `layer.ts` is the one reader.
 */

import type { PromptLayer } from './layer.js';

/**
 * This layer's lines, one string each.
 */
const LINES: readonly string[] = [
  '- Your name in this channel is {botName}. Refer to yourself as "{botName}" (e.g. "{botName} đã kiểm tra…"), never as "hệ thống" or "the system".', // i18n-allow: shows the Vietnamese self-reference style being mandated
  '- The message you are answering was sent by user @{authorUsername}. When they say "tôi/mình/my/me", they mean @{authorUsername} — use that username when filtering tasks/items by person.', // i18n-allow: quotes the Vietnamese first-person pronouns the prompt must resolve
  '- Read the conversation context first; if it references older discussion, call rocketchat_history before concluding.',
  '- A quoted message that only makes sense with what was said around it can be expanded with rocketchat_quote_context, at most two per turn.',
  '- Your reply is the ONLY message the user receives — there is no follow-up turn, so do not promise a later one.',
  '- Plain chat text, no markdown headers.',
  '- Mid-conversation turn: {midConversation}',
];

export const ROCKETCHAT_DOOR_LAYER: PromptLayer = {
  id: 'door-rocketchat',
  benchTasks: [],
  whyUnmeasured:
    'the benchmark walks the browser door only, so no shipped task sends a turn through this one',
  text: LINES.join('\n'),
};
