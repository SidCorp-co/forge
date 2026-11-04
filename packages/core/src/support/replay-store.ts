// What a room's replay reads of the support tables (ISS-933): when Forge last recorded a member's
// message on a group, which messages it recorded there, and whether the room was replayed already.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { supportActions, supportRooms } from '../db/schema-support.js';

type Exec = Tx | typeof db;

/** When Forge last recorded a member's message in group `rid`, in any project's room (ISS-933). */
export async function lastMemberMessageOn(rid: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<Date | null>`max(${supportActions.createdAt})` })
    .from(supportActions)
    .innerJoin(supportRooms, eq(supportRooms.id, supportActions.roomId))
    .where(
      and(
        eq(supportRooms.rid, rid),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKind, 'member'),
      ),
    );
  return row?.at ? new Date(row.at) : null;
}

/** Which of the chat message ids Forge recorded in group `rid`, in any project's room (ISS-933). */
export async function recordedMessageIdsOn(
  rid: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: supportActions.externalId })
    .from(supportActions)
    .innerJoin(supportRooms, eq(supportRooms.id, supportActions.roomId))
    .where(
      and(
        eq(supportRooms.rid, rid),
        eq(supportActions.kind, 'message_in'),
        inArray(supportActions.externalId, [...ids]),
      ),
    );
  return new Set(rows.flatMap((r) => (r.id ? [r.id] : [])));
}

/** Whether core recorded the operation `tool` in a room (a replay's marker, ISS-933). */
export async function hasOperation(
  roomId: string,
  tool: string,
  exec: Exec = db,
): Promise<boolean> {
  const [row] = await exec
    .select({ id: supportActions.id })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.kind, 'operation'),
        eq(supportActions.tool, tool),
      ),
    )
    .limit(1);
  return Boolean(row);
}
