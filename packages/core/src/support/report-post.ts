// A report a master posts in a thread, such as a release check (ISS-1417). agenfold's owner group,
// 2026-11-22: the 0.310.0 release-check report was placed as one voice, so it took the thread's
// latest bot message, the room agent's answer of 30 minutes before, as its own and rewrote it. A
// report answers no one's request. It updates in place only the message its own record names: this
// project's earlier post of the same report (the release it checks) in the same thread, within the
// edit window and not deleted. With no such post it posts a new message, and an edit the door refuses
// (`post-edit-door.ts`) posts a new message too, so a report never takes anyone's words.

import type { ProvenMessage } from '@forge/contracts/messaging';
import { SUPPORT_MASTER_POST_EDIT_WINDOW_MS } from '@forge/contracts/support';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { replaceSentContent } from '../conversations/index.js';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { logger } from '../lib/logger.js';
import type { Outcome } from './outcome.js';
import { editBotPost, recordsOfMessage } from './post-edit-door.js';
import { type RoomRow, roomsOnRid } from './store.js';
import { postInThread } from './thread.js';

/** The report a post is, and the project it is made for, which own it together. */
export interface Report {
  key: string;
  projectId: string;
}

/** The act a master's delete is recorded under (`master-post-edit.ts`). */
const DELETED = 'master_post_delete';

type Placed = {
  messageId: string | null;
  conversationId: string | null;
  replaced: null;
  /** Where the report updated its own earlier post in place. */
  updated?: true;
};

/**
 * This project's newest post of `report` in `thread`, on any binding's record of the group, still in
 * its edit window and not deleted: the one message the report may update in place; null where none.
 */
export async function ownReportPost(
  room: RoomRow,
  thread: string,
  report: Report,
  now = new Date(),
): Promise<{ messageId: string; conversationId: string | null; room: RoomRow } | null> {
  const holders = await roomsOnRid(room.rid);
  const rooms = holders.some((r) => r.id === room.id) ? holders : [room, ...holders];
  const posts = await db
    .select({
      roomId: supportActions.roomId,
      externalId: supportActions.externalId,
      conversationId: supportActions.conversationId,
      at: supportActions.createdAt,
    })
    .from(supportActions)
    .where(
      and(
        inArray(
          supportActions.roomId,
          rooms.map((r) => r.id),
        ),
        eq(supportActions.thread, thread),
        eq(supportActions.tool, 'master_post'),
        inArray(supportActions.kind, ['routed', 'announced']),
        sql`${supportActions.input}->>'report' = ${report.key}`,
        sql`COALESCE(${supportActions.input}->>'for', ${supportActions.projectId}::text) = ${report.projectId}`,
      ),
    )
    .orderBy(desc(supportActions.createdAt))
    .limit(1);
  const post = posts[0];
  if (!post?.externalId) return null;
  // its window runs from when the message was first posted, as a master's own edit's does
  const records = await recordsOfMessage(post.externalId);
  if (records.some((r) => r.kind === 'operation' && r.tool === DELETED)) return null;
  const first = records[0]?.createdAt ?? post.at;
  if (now.getTime() - first.getTime() > SUPPORT_MASTER_POST_EDIT_WINDOW_MS) return null;
  const holder = rooms.find((r) => r.id === post.roomId) ?? room;
  return { messageId: post.externalId, conversationId: post.conversationId, room: holder };
}

/**
 * A report's screened post into `thread`: its own earlier post of the same report updated in place
 * where one is in its window, else a new message. Never the thread's answer, whoever posted it.
 */
export async function placeReport(input: {
  room: RoomRow;
  thread: string;
  conversationId: string | null;
  text: string;
  proof: ProvenMessage;
  report: Report;
}): Promise<Outcome<Placed>> {
  const own = await ownReportPost(input.room, input.thread, input.report);
  if (own) {
    const out = await editBotPost({
      room: own.room,
      messageId: own.messageId,
      text: input.text,
      proof: input.proof,
      editor: { kind: 'report', projectId: input.report.projectId, report: input.report.key },
    });
    if (out.ok) {
      // the thread's stored line reads as the room does, as one voice's replacement does
      if (own.conversationId) {
        await replaceSentContent({
          conversationId: own.conversationId,
          externalId: own.messageId,
          content: input.text,
        });
      }
      return {
        ok: true,
        value: {
          messageId: own.messageId,
          conversationId: input.conversationId,
          replaced: null,
          updated: true,
        },
      };
    }
    logger.warn(
      { roomId: input.room.id, messageId: own.messageId, report: input.report.key },
      'support: a report could not update its own post in place; it posts a new message',
    );
  }
  const posted = await postInThread(input);
  return { ok: true, value: { ...posted, replaced: null } };
}
