// A person's message no turn ever took, listed where the project's master reads what is owed
// (ISS-1417). agenfold's owner group, 2026-11-22: the owner's 09:47 message got no turn while the
// box's disk was down, and a message held past the age bound is dropped with a record on the room
// and told nowhere (`turn-retry.ts:dropHeldTooLong`, ISS-1105), so nobody answered it. Core does
// not answer for the agent: it names each such message to the master until its thread is answered.
// Listed are the owner's messages and those naming the bot; the room's own chatter, which the age
// bound exists to let go, is not.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { grantsOf, supportConfigOf } from './grants.js';
import { roomById } from './store.js';
import { answersThread } from './thread-answer.js';

/** The code a dropped message is listed under beside the messages a room could not take. */
export const DROPPED_UNANSWERED = 'HELD_TOO_LONG';

/** A room's messages no turn took and nobody answered since, as the master's owed line counts them. */
export interface DroppedUnanswered {
  roomId: string;
  rid: string;
  code: typeof DROPPED_UNANSWERED;
  count: number;
  lastAt: string;
  /** The threads they wait in, newest first. */
  threads: string[];
}

type Row = {
  room_id: string;
  rid: string;
  thread: string;
  actor_key: string | null;
  addressed: string | null;
  created_at: Date | string;
};

/**
 * The member messages of `projectId`'s rooms dropped since `since` with no turn taking them, that the
 * room's owner wrote or that named the bot, and that no answer of their thread followed, on any
 * binding's record of the group, as every reader reads an answer (`thread-answer.ts`, ISS-1422: one
 * answered from another thread is owed no more): one row per room.
 */
export async function droppedUnansweredOf(
  projectId: string,
  since: Date,
): Promise<DroppedUnanswered[]> {
  const rows = (await db.execute(sql`
    SELECT a.room_id, r.rid, a.thread, a.actor_key, a.input->>'addressed' AS addressed, a.created_at
      FROM support_actions a JOIN support_rooms r ON r.id = a.room_id
     WHERE a.project_id = ${projectId} AND a.kind = 'message_in' AND a.actor_kind = 'member'
       AND a.output ? 'dropped' AND a.created_at >= ${since.toISOString()}::timestamptz
       AND NOT EXISTS (
         SELECT 1 FROM support_actions JOIN support_rooms h ON h.id = support_actions.room_id
          WHERE h.rid = r.rid AND support_actions.thread = a.thread
            AND support_actions.created_at > a.created_at AND ${answersThread})
     ORDER BY a.created_at DESC
  `)) as unknown as Row[];
  const owners = new Map<string, string | null>();
  const byRoom = new Map<string, DroppedUnanswered>();
  for (const row of rows) {
    if (!owners.has(row.room_id)) {
      const room = await roomById(row.room_id);
      owners.set(row.room_id, room ? (grantsOf(await supportConfigOf(room)).owner ?? null) : null);
    }
    const owner = owners.get(row.room_id);
    const his = owner !== null && owner !== undefined && row.actor_key === owner;
    if (!his && row.addressed !== 'you') continue;
    const at = new Date(row.created_at).toISOString();
    const listed = byRoom.get(row.room_id) ?? {
      roomId: row.room_id,
      rid: row.rid,
      code: DROPPED_UNANSWERED,
      count: 0,
      lastAt: at,
      threads: [],
    };
    listed.count += 1;
    if (!listed.threads.includes(row.thread)) listed.threads.push(row.thread);
    byRoom.set(row.room_id, listed);
  }
  return [...byRoom.values()];
}
