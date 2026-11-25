// What a room's record says of its threads, read for a master and the rooms read: who each recent
// thread is whose (ISS-969), and what a room could not take (ISS-1046). Kept apart from `store.ts`, which writes the support tables.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/**
 * A room's most recent threads, newest first and at most `limit`, each with who opened it (the first
 * member to write in it, by the label the room shows), when it last moved, and the feedback filed
 * from it, FB-n (ISS-969): the read a master takes a users' thread from before it posts there.
 */
export async function recentThreadsNamed(
  roomId: string,
  limit: number,
): Promise<{ thread: string; asker: string | null; lastAt: Date; feedback: string[] }[]> {
  const rows = (await db.execute(sql`
    SELECT a.thread,
           (array_agg(a.actor_label ORDER BY a.created_at)
              FILTER (WHERE a.kind = 'message_in' AND a.actor_kind = 'member'))[1] AS asker,
           max(a.created_at) AS last_at,
           COALESCE((SELECT array_agg('FB-' || f.fb_seq ORDER BY f.fb_seq)
                       FROM support_feedback_links l JOIN feedback f ON f.id = l.feedback_id
                      WHERE l.room_id = ${roomId} AND l.thread = a.thread), '{}') AS feedback
      FROM support_actions a
     WHERE a.room_id = ${roomId}
     GROUP BY a.thread
     ORDER BY max(a.created_at) DESC
     LIMIT ${limit}
  `)) as unknown as {
    thread: string;
    asker: string | null;
    last_at: Date | string;
    feedback: string[];
  }[];
  return rows.map((r) => ({
    thread: r.thread,
    asker: r.asker,
    lastAt: new Date(r.last_at),
    feedback: r.feedback,
  }));
}

/**
 * The member messages each of a project's rooms could not take in the last day (ISS-1046), one row
 * per room and cause, with how many and the newest: what the project's master is told once.
 */
export async function unhandledMessagesOf(
  projectId: string,
  since: Date,
): Promise<{ roomId: string; rid: string; code: string; count: number; lastAt: string }[]> {
  const rows = (await db.execute(sql`
    SELECT a.room_id, r.rid, a.output->>'code' AS code, count(*)::int AS n, max(a.created_at) AS last_at
      FROM support_actions a JOIN support_rooms r ON r.id = a.room_id
     WHERE a.project_id = ${projectId} AND a.kind = 'refused' AND a.tool = 'message_unhandled'
       AND a.created_at >= ${since.toISOString()}::timestamptz
     GROUP BY a.room_id, r.rid, a.output->>'code'
     ORDER BY max(a.created_at) DESC
  `)) as unknown as {
    room_id: string;
    rid: string;
    code: string | null;
    n: number;
    last_at: Date | string;
  }[];
  return rows.map((r) => ({
    roomId: r.room_id,
    rid: r.rid,
    code: r.code ?? 'UNKNOWN',
    count: r.n,
    lastAt: new Date(r.last_at).toISOString(),
  }));
}
