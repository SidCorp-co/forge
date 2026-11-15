// The owner's approval of an item recorded from a thread (ISS-1243): attached to that item, never
// filed as a new one. In adminhub-api's rooms 16 of 79 records were the owner's go-aheads (to
// production, on a merge request) filed as new Feedback beside the item they approved (thread BeK4G
// held FB-15..19 of two projects). `approve` writes his words on the open item the thread recorded, citing his message,
// and a record the owner asks for in a thread holding an open item is refused until the session
// says whether it approves that item or is separate work (`proposeRecordGuard`).

import type { SupportApproveRequest } from '@forge/contracts/support';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportFeedbackLinks } from '../db/schema-support.js';
import { feedbackKeysOf, noteOnFiled } from '../feedback/index.js';
import { memberMessage } from './channel-store.js';
import { grantsOf, isNamedOwner, supportConfigOf } from './grants.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import { insertAction, type RoomRow } from './store.js';
import { scrubbedForRoom } from './thread.js';

/** An item recorded from a thread whose result is still to come. */
interface OpenItem {
  id: string;
  projectId: string;
  key: string;
  project: string;
}

/** The items recorded from this thread of the room that are still open, oldest first. */
export async function openItemsOfThread(room: RoomRow, thread: string): Promise<OpenItem[]> {
  const links = await db
    .select({ id: supportFeedbackLinks.feedbackId, projectId: supportFeedbackLinks.projectId })
    .from(supportFeedbackLinks)
    .where(
      and(
        eq(supportFeedbackLinks.roomId, room.id),
        eq(supportFeedbackLinks.thread, thread),
        isNull(supportFeedbackLinks.closedAt),
      ),
    );
  const keys = await feedbackKeysOf(links.map((l) => l.id));
  return links.flatMap((l) => {
    const k = keys.get(l.id);
    return k ? [{ ...l, key: k.key, project: k.project }] : [];
  });
}

const named = (items: readonly OpenItem[]) =>
  items.map((i) => `${i.key} of ${i.project}`).join(', ') || 'none';

/**
 * Attach the owner's approval, his own message in the thread, to the open item recorded from that
 * thread it approves: an internal note on the item quoting his words, and an action on the room
 * naming the item. Refused by name, nothing written: a message not his own in that thread
 * (SUPPORT_APPROVAL_NOT_THE_OWNERS), an item that is no open item of the thread
 * (SUPPORT_APPROVAL_ITEM_UNKNOWN).
 */
export async function attachApproval(
  room: RoomRow,
  input: SupportApproveRequest,
): Promise<Outcome<{ attached: true; feedbackKey: string; project: string; what: string }>> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const grants = grantsOf(await supportConfigOf(room));
  const said = await memberMessage(room.id, input.message);
  if (!said || said.thread !== input.thread || !isNamedOwner(grants, said.authorKey)) {
    return no(
      'SUPPORT_APPROVAL_NOT_THE_OWNERS',
      '/message',
      `message ${input.message} is not the owner's own message in thread ${input.thread}${grants.owner ? '' : ': this room names no owner'}; only his own words approve an item. Nothing was attached.`,
    );
  }
  const open = await openItemsOfThread(room, input.thread);
  const matching = open.filter(
    (i) => i.key === input.feedback && (input.project === undefined || i.project === input.project),
  );
  const item = matching.length === 1 ? matching[0] : undefined;
  if (!item) {
    return no(
      'SUPPORT_APPROVAL_ITEM_UNKNOWN',
      matching.length > 1 ? '/project' : '/feedback',
      matching.length > 1
        ? `${input.feedback} names ${named(matching)}: name its project. Nothing was attached.`
        : `${input.feedback}${input.project ? ` of ${input.project}` : ''} is no open item recorded from this thread; its open items are ${named(open)}. Nothing was attached.`,
    );
  }
  const words = await scrubbedForRoom(room, said.text ?? '');
  await noteOnFiled({
    projectId: item.projectId,
    itemId: item.id,
    by: room.principalUserId,
    body: `The owner approved this in the room thread ${room.rid} / ${input.thread}, message ${input.message} by @${said.author ?? said.authorKey}: "${words}"`,
  });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: input.thread,
    kind: 'operation',
    actorKind: 'session',
    tool: 'approve',
    input: { message: input.message, feedback: item.key, project: item.project },
    output: { attached: true },
    feedbackId: item.id,
  });
  return {
    ok: true,
    value: {
      attached: true,
      feedbackKey: item.key,
      project: item.project,
      what: `The owner's approval was attached to ${item.key} in ${item.project}, and nothing new was filed. Tell him in your own words.`,
    },
  };
}

/**
 * A record the owner asks for in a thread that holds an open item (ISS-1243): refused until the
 * session says it is separate work (`separate: true`), since his words there are most often his
 * approval of that item, which `approve` attaches to it. Null where the record may be proposed.
 */
export async function recordIsApproval(
  room: RoomRow,
  input: { thread: string; asker: string; separate?: true | undefined },
): Promise<Outcome<never> | null> {
  if (input.separate) return null;
  if (!isNamedOwner(grantsOf(await supportConfigOf(room)), input.asker)) return null;
  const open = await openItemsOfThread(room, input.thread);
  if (open.length === 0) return null;
  return no(
    'SUPPORT_RECORD_IS_APPROVAL',
    '/separate',
    `this thread already holds ${named(open)}, still open, and the owner asks: where his words approve one of them, attach them with approve { thread, message, feedback } and file nothing; only where he asks for new work beside it, record again with separate: true. Nothing was proposed.`,
  );
}
