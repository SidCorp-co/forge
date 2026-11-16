// No directions to a screen in place of the act (ISS-1243 item 24, ISS-1250, owner 2026-11-16): a
// room agent told the owner "you or the ePOD master go into the ePOD project's settings on Forge ...
// set it to English" and "only the project owner can choose: press 'Add varnish to the forge-ops
// deploy job' and it is closed" (epod thread, 16/11 02:22 and 03:15). An instruction is the act, made
// with the agent's own acts or handed to the project's master. An operations room is Forge's own, so
// every direction to press or open something there is refused; in any other room, where a product's
// users may ask how to use its screens, only a direction that names Forge as the place is.

import { no, type Outcome } from './outcome.js';
import { insertAction, type RoomRow } from './store.js';

/** A letter boundary: `\b` is ASCII-only, and Vietnamese words end in letters it does not know. */
const START = '(?<![\\p{L}\\p{N}_])';

/** Not the agent's own act: "I will change the settings" tells what it does, and directs nobody. */
const NOT_SELF_VI = '(?<!(?:em|mình|tôi|bot)\\s+(?:sẽ\\s+|đã\\s+|vừa\\s+|đang\\s+)?)'; // i18n-allow: the Vietnamese first person a direction is told from
const NOT_SELF_EN = "(?<!\\bI(?:'ll|'ve|\\s+will|\\s+can|\\s+have)?\\s+)";

/** The forms a direction to press, open or change something on a screen takes. */
const DIRECTIONS: readonly RegExp[] = [
  // Vietnamese: "press 'X'", "press to choose 'X'"
  new RegExp(`${START}(?:bấm|nhấn|ấn|click)\\s+(?:vào\\s+|chọn\\s+|nút\\s+)*["'“‘«]`, 'iu'), // i18n-allow: the Vietnamese phrasing of a direction being policed
  // Vietnamese: "go into / open the settings", "change the settings"
  new RegExp(
    `${START}${NOT_SELF_VI}(?:vào|mở|sửa|đổi|chỉnh)\\s+(?:lại\\s+)?(?:trang\\s+|phần\\s+|mục\\s+|màn\\s+hình\\s+)?(?:cài\\s+đặt|thiết\\s+lập|settings?|giao\\s+diện)`, // i18n-allow: the Vietnamese phrasing of a direction being policed
    'iu',
  ),
  // English: "click 'X'", "press the 'X' button"
  /\b(?:click|press|tap)\s+(?:on\s+)?(?:the\s+)?["'“‘]/i,
  // English: "go to the project settings", "open the requirement page", "change the settings"
  new RegExp(
    `${NOT_SELF_EN}\\b(?:go\\s+to|open|head\\s+to|change|edit)\\s+(?:the\\s+)?(?:[\\w-]+\\s+){0,3}?(?:settings|page|screen|tab)\\b`,
    'i',
  ),
];

/** Forge named as a word of its own: "on Forge", never inside a name such as forge-ops. */
const FORGE_NAMED = /(?<![\p{L}\p{N}_-])forge(?![\p{L}\p{N}_-])/iu;

/**
 * The words of the first direction a post gives to a screen, or null where it gives none. In a room
 * that is not Forge's own, a direction counts only where its sentence names Forge.
 */
export function uiDirectionIn(text: string, forgeRoom: boolean): string | null {
  for (const sentence of text.split(/(?<=[.!?…\n])/u)) {
    if (!forgeRoom && !FORGE_NAMED.test(sentence)) continue;
    for (const form of DIRECTIONS) {
      const found = form.exec(sentence);
      if (found) return found[0];
    }
  }
  return null;
}

/**
 * Null where the post may go; otherwise the refusal, recorded on the thread with nothing posted,
 * naming the words and the act that stands in their place.
 */
export async function uiDirectionRefusal(
  room: RoomRow,
  conversationId: string | null,
  thread: string,
  text: string,
  tool: string,
): Promise<Outcome<never> | null> {
  const quote = uiDirectionIn(text, room.kind === 'operations');
  if (!quote) return null;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread,
    kind: 'refused',
    actorKind: 'session',
    tool,
    input: { text },
    output: { code: 'SUPPORT_UI_DIRECTIONS', quote },
  });
  return no(
    'SUPPORT_UI_DIRECTIONS',
    '/text',
    `nothing was posted: the post sends someone to a screen to do it ("${quote}"). Make the act yourself (support.owner_forge_act, support.answer_question where you hold them), or hand it to the project's master with support.ask_master, and tell the thread in one line that it is done or in hand.`,
  );
}
