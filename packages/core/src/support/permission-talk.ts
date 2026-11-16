// No permission talk in a work thread (ISS-1243 item 12, owner 2026-11-15): a room agent never tells
// a thread that it lacks a permission or a grant, or that someone must grant or do something first;
// such a need is raised in the project's technical channel (`technical-channel.ts`), and the thread
// gets the answer or a short note that it is in hand. 60 replies and 54 routed posts of 01/11-15/11
// carried it (in Vietnamese: "I have no permission to share the mailbox yet", "this room is not
// granted the feedback list", "please grant me access"), and after it the epod thread's "this room
// does not let me keep a channel rule ... in my role" (ISS-1250). The screen reads the agent's own
// first-person claim, so an answer explaining a user's own access to a screen still posts.

import { no, type Outcome } from './outcome.js';
import { TECHNICAL_DOOR } from './room-conduct.js';
import { insertAction, type RoomRow } from './store.js';

/** The forms a post saying the agent lacks a permission, or waits on someone to grant one, takes. */
const PERMISSION_TALK: readonly RegExp[] = [
  // Vietnamese, from a letter boundary (`\b` is ASCII-only): "I have no / not yet a permission", "I am not allowed"
  /(?<![\p{L}\p{N}_])(?:em|bot|mình|tôi)\s+(?:vẫn\s+)?(?:không|chưa|ko)\s+(?:có\s+quyền|được\s+cấp\s+quyền|được\s+phép|được\s+quyền)/iu, // i18n-allow: the Vietnamese phrasing of a permission claim being policed
  /(?:phòng|nhóm|room)\s+này\s+(?:không|chưa)\s+(?:được\s+cấp\s+quyền|có\s+quyền)/iu, // i18n-allow: the Vietnamese phrasing of a permission claim being policed
  // Vietnamese, the room or the role keeping it from the agent: "this room does not let me", "in my role" (ISS-1250, epod 16/11)
  /(?:phòng|nhóm|room|vai\s+trò)\s+này\s+(?:không|chưa)\s+(?:cho|để)\s+(?:em|bot|mình|tôi)\b/iu, // i18n-allow: the Vietnamese phrasing of a permission claim being policed
  /(?:vai\s+trò|quyền(?:\s+hạn)?)\s+của\s+(?:em|bot|mình)(?![\p{L}\p{N}_])/iu, // i18n-allow: the Vietnamese phrasing of a permission claim being policed
  // Vietnamese, asking or waiting on someone to grant or allow it first
  /(?<![\p{L}\p{N}_])(?:nhờ|cần|đợi|chờ)\s+(?:anh|chị|admin|owner|sếp)[^.!?\n]{0,40}?\s(?:cấp\s+quyền|cho\s+phép|duyệt\s+quyền)/iu, // i18n-allow: the Vietnamese phrasing of a permission claim being policed
  // English, first person: "I don't have permission", "I am not allowed/permitted", "I lack access"
  /\bI\s+(?:do\s+not|don't|cannot|can't|still\s+don't)\s+have\s+(?:the\s+)?(?:permission|access|rights?|a\s+grant)\b/i,
  /\bI(?:'m|\s+am)\s+not\s+(?:allowed|permitted|granted|authori[sz]ed)\b/i,
  /\bI\s+(?:lack|have\s+no)\s+(?:the\s+)?(?:permission|access|grant|rights?)\b/i,
  /\bthis\s+room\s+(?:is\s+not|isn't)\s+granted\b/i,
  /\bthis\s+(?:room|group|channel|role)\s+(?:does\s+not|doesn't|won't|will\s+not)\s+(?:let|allow)\s+me\b/i,
  /\bmy\s+(?:role|grants?|permissions?)\b/i,
  // waiting on someone to grant: "once the owner grants", "until an admin gives me access"
  /\b(?:until|once|after)\s+(?:the\s+owner|an?\s+admin|someone|the\s+team|you)\s+(?:grants?|gives?\s+me\s+(?:access|permission))\b/i,
];

/** The words of the first permission claim a post carries, or null where it carries none. */
export function permissionTalkIn(text: string): string | null {
  for (const form of PERMISSION_TALK) {
    const found = form.exec(text);
    if (found) return found[0];
  }
  return null;
}

/**
 * The acts whose post is the place a need may be said: an ask of the owner and a need raised in the
 * technical channel (`technical-channel.ts:TECHNICAL`), whose whole line is screened (ISS-1249).
 */
const MAY_SAY_NEED: ReadonlySet<string> = new Set(['ask_owner', 'technical']);

/** Whether a post of `tool` is screened for permission talk: every post in a work thread is. */
export const screensPermissionTalk = (tool: string): boolean => !MAY_SAY_NEED.has(tool);

/**
 * Null where the post may go; otherwise the refusal, recorded on the thread with nothing posted,
 * naming the words and the door the need goes through instead.
 */
export async function permissionTalkRefusal(
  room: RoomRow,
  conversationId: string | null,
  thread: string,
  text: string,
  tool: string,
): Promise<Outcome<never> | null> {
  if (!screensPermissionTalk(tool)) return null;
  const quote = permissionTalkIn(text);
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
    output: { code: 'SUPPORT_PERMISSION_TALK', quote },
  });
  return no(
    'SUPPORT_PERMISSION_TALK',
    '/text',
    `nothing was posted: the post tells the thread you lack a permission or wait on someone to grant one ("${quote}"). Raise that need with ${TECHNICAL_DOOR} { thread, need, text }, the project's technical channel, and tell this thread the answer, or one short note that it is in hand.`,
  );
}
