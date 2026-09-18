/**
 * ISS-1057 — the `door-rocketchat` layer: what is true in a Rocket.Chat room and nowhere else.
 *
 * Text and its header only; `layer.ts` is the one reader.
 */

// cm:guard the one-reply rule may NOT be hoisted into `base.ts`: a room turn is one message with no
// follow-up, and the Forge web app is multi-turn, so the same sentence read at the web door forbids
// a clarifying question that surface is built to allow (ISS-1007).
// cm:guard `rocketchat_history` is named here and only here because it is this adapter's own tool;
// a door that does not have it reading an instruction to call it is told to use a tool it was never
// given (ISS-1007).
import type { PromptLayer } from './layer.js';

/**
 * This layer's lines, one string each.
 */
// cm:guard the ONLY layer whose text is a joined array rather than one template literal, and the
// reason is the language gate rather than taste: two of these lines must carry the Vietnamese they
// govern — the self-reference style and the first-person pronouns a room turn resolves — and
// `check-source-language` reads line by line, so the `i18n-allow` directive it needs has to sit on
// the same line. A comment cannot go inside a template literal. This is a join and not a reader:
// the layer still exports no function and `compose.ts` is still the only thing that reads the text.
const LINES: readonly string[] = [
  // cm:ignore CM001 — the literal must carry the Vietnamese self-reference style being mandated
  '- Your name in this channel is {botName}. Refer to yourself as "{botName}" (e.g. "{botName} đã kiểm tra…"), never as "hệ thống" or "the system".', // i18n-allow: shows the Vietnamese self-reference style being mandated
  // cm:ignore CM001 — the literal must carry the Vietnamese first-person pronouns being resolved
  '- The message you are answering was sent by user @{authorUsername}. When they say "tôi/mình/my/me", they mean @{authorUsername} — use that username when filtering tasks/items by person.', // i18n-allow: quotes the Vietnamese first-person pronouns the prompt must resolve
  '- Read the conversation context first; if it references older discussion, call rocketchat_history before concluding.',
  // cm:guard named here beside `rocketchat_history` for the same reason that one is: it is this adapter's own tool, and a door that never mentions it leaves the model to discover a capped tool by trial (ISS-1087 criterion 24).
  '- A quoted message that only makes sense with what was said around it can be expanded with rocketchat_quote_context, at most two per turn.',
  '- Your reply is the ONLY message the user receives — there is no follow-up turn, so do not promise a later one.',
  '- Plain chat text, no markdown headers.',
  // cm:guard a TOKEN line and not a fixed sentence, because the composer drops a line whose value is null and that is the whole mechanism: a window that closed on quiet passes null and this line is not in the prompt at all, while one cut by the hold or split for overflow passes the instruction below. Two copies of the room lines — one per case — would be the second copy that drifts (ISS-1086 criteria 14-16).
  // cm:guard the fixed prefix is what the claim ledger holds onto: its rows claim token-free text, and a line that is nothing but a token has no sentence a row can name (`layer-accounting.test.ts` criterion 24).
  '- Mid-conversation turn: {midConversation}',
];

export const ROCKETCHAT_DOOR_LAYER: PromptLayer = {
  id: 'door-rocketchat',
  // cm:guard EMPTY on purpose, and the field below says why rather than borrowing a task id from
  // another door: `bench:assistant` walks the browser door only (ISS-1051 D1), so any task named
  // here would be a measurement claim nobody can take (ISS-1057, codex F2).
  benchTasks: [],
  whyUnmeasured:
    'the benchmark walks the browser door only, so no shipped task sends a turn through this one',
  text: LINES.join('\n'),
};
