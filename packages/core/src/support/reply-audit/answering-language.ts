// The language a room reply is held to (ISS-1377, FB-789, ISS-1442): the language the person's own
// message is CONFIDENTLY written in, and nothing else. Where that message cannot be told (a name, an
// "ok", Vietnamese beside one English word) there is no language to hold the reply to, and the code check raises no
// language finding in either direction: neither the persona nor what the room's people wrote stands in,
// and the project's content language is for Forge's records. The model-side audit and the person still see the reply.

import { confidentLanguageOf, type ReplyLanguage } from '../../conversations/index.js';

/** The language the message answered is confidently written in, or null where it cannot be told. */
export function answeringLanguageOf(input: { asked: string | null }): ReplyLanguage | null {
  return confidentLanguageOf(input.asked);
}
