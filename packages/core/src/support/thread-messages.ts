// Who wrote what in a support thread, by the ids the chat server gave the messages: the member who
// started it (ISS-1097) and a member's latest message there (ISS-1106), each read off the room's
// `message_in` actions.

import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';

/** The id of `memberKey`'s latest message in `thread`, as the chat server named it (ISS-1106). */
export async function latestMessageOf(
  roomId: string,
  thread: string,
  memberKey: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: supportActions.externalId })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.thread, thread),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKind, 'member'),
        eq(supportActions.actorKey, memberKey),
        isNotNull(supportActions.externalId),
      ),
    )
    .orderBy(desc(supportActions.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/** The username of the member whose message started `thread`, where core heard it (ISS-1097). */
export async function threadStarterHeard(roomId: string, thread: string): Promise<string | null> {
  const [row] = await db
    .select({ label: supportActions.actorLabel })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.thread, thread),
        eq(supportActions.externalId, thread),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKind, 'member'),
      ),
    )
    .limit(1);
  return row?.label ?? null;
}
