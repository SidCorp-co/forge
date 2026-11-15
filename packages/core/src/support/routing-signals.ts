// The signals a room agent decides which project a message concerns from (ISS-1243), read from what
// core already holds and handed on each message's head as `routing`: who the sender is (the Forge
// account their chat account is linked to; their channel-record roles ride on `from.roles`), what
// they worked on before (the projects of their past threads in this binding's groups, the records
// filed for them, the issues they reported), what the thread already holds (the records filed from
// it and the project its earlier decisions named), and the projects the room reaches. Nothing is
// inferred here: an empty list is "none recorded", and the agent weighs them before it guesses.

import { sql } from 'drizzle-orm';
import { resolveSpeaker } from '../assistant/index.js';
import { db } from '../db/client.js';
import { projectsInScope } from './ops-scope.js';
import type { ActionRow, RoomRow } from './store.js';
import { roomAuth } from './thread.js';

/** How many of a sender's past records, issues and thread projects a head carries. */
const HISTORY_SHOWN = 5;
/** How many of a sender's past threads are read for the projects they went to. */
const THREADS_READ = 30;

/** What a sender is, as core reads it. */
interface SenderSignals {
  /** Whether the chat account is linked to a Forge account. */
  linked: boolean;
  /** That account's display name; null where it is linked to none or shows no name (never its email). */
  account: string | null;
  /** The projects of the sender's past threads in this binding's groups, most first: `slug ×n`. */
  pastProjects: string[];
  /** The records filed for them from this binding's groups, newest first: `slug FB-n`. */
  filedFor: string[];
  /** The issues their linked account reported in the projects the room reaches, newest first: `slug KEY`. */
  reported: string[];
}

/** What a thread holds already. */
interface ThreadSignals {
  /** The records filed from it, oldest first: `slug FB-n`. */
  records: string[];
  /** The project the last routing decision in it named; null where none named one. */
  decidedProject: string | null;
}

/** The `routing` a member message's head carries. */
export interface RoutingSignals {
  roomProjects: string[];
  sender: SenderSignals;
  thread: ThreadSignals;
}

/**
 * The Forge account a chat sender is, read through the one link core keeps for it (`resolveSpeaker`:
 * a link the person confirmed, or one a project admin named): its id and display name, never its
 * email; null where the sender is no Forge account. Every routing read of "who sent it" goes here.
 */
export async function senderAccountOf(
  room: RoomRow,
  namespace: string,
  key: string,
): Promise<{ userId: string; name: string | null } | null> {
  const resolved = await resolveSpeaker(
    { source: 'rocketchat', namespace, externalId: key },
    room.projectId,
  );
  return resolved.linked ? { userId: resolved.userId, name: await nameOf(resolved.userId) } : null;
}

/** A Forge account's display name; never its email, which no room's agent is handed. */
async function nameOf(userId: string): Promise<string | null> {
  const [user] = (await db.execute(sql`
    SELECT display_name AS name FROM users WHERE id = ${userId}::uuid
  `)) as unknown as { name: string | null }[];
  return user?.name ?? null;
}

/** The projects a sender's past threads went to: each thread's records' projects and decided projects. */
async function pastProjectsOf(room: RoomRow, key: string, thread: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    WITH theirs AS (
      SELECT a.room_id, a.thread, max(a.created_at) AS last_at
        FROM support_actions a JOIN support_rooms r ON r.id = a.room_id
       WHERE r.binding_id = ${room.bindingId}::uuid
         AND a.kind = 'message_in' AND a.actor_key = ${key}
         AND NOT (a.room_id = ${room.id}::uuid AND a.thread = ${thread})
       GROUP BY a.room_id, a.thread
       ORDER BY max(a.created_at) DESC
       LIMIT ${THREADS_READ}
    ), went AS (
      SELECT t.room_id, t.thread, p.slug
        FROM theirs t
        JOIN support_feedback_links l ON l.room_id = t.room_id AND l.thread = t.thread
        JOIN projects p ON p.id = l.project_id
      UNION
      SELECT t.room_id, t.thread, d.input->>'project'
        FROM theirs t
        JOIN support_actions d ON d.room_id = t.room_id AND d.thread = t.thread
       WHERE d.kind = 'routing_decided' AND d.input->>'project' IS NOT NULL
    )
    SELECT slug, count(*)::int AS n FROM went GROUP BY slug ORDER BY count(*) DESC, slug
    LIMIT ${HISTORY_SHOWN}
  `)) as unknown as { slug: string; n: number }[];
  return rows.map((r) => `${r.slug} ×${r.n}`);
}

async function filedForOf(room: RoomRow, key: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT p.slug, f.fb_seq
      FROM feedback_external_reporters x
      JOIN feedback f ON f.id = x.feedback_id
      JOIN projects p ON p.id = f.project_id
     WHERE x.binding_id = ${room.bindingId}::uuid AND x.signed_user_id = ${key}
     ORDER BY f.created_at DESC
     LIMIT ${HISTORY_SHOWN}
  `)) as unknown as { slug: string; fb_seq: number }[];
  return rows.map((r) => `${r.slug} FB-${r.fb_seq}`);
}

async function reportedOf(userId: string | null, projectIds: readonly string[]): Promise<string[]> {
  if (!userId || projectIds.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT p.slug, COALESCE(p.issue_prefix, 'ISS') || '-' || i.iss_seq AS key
      FROM issues i JOIN projects p ON p.id = i.project_id
     WHERE i.created_by_id = ${userId}::uuid
       AND i.project_id IN (${sql.join(
         projectIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     ORDER BY i.created_at DESC
     LIMIT ${HISTORY_SHOWN}
  `)) as unknown as { slug: string; key: string }[];
  return rows.map((r) => `${r.slug} ${r.key}`);
}

async function threadSignalsOf(room: RoomRow, thread: string): Promise<ThreadSignals> {
  const records = (await db.execute(sql`
    SELECT p.slug, f.fb_seq
      FROM support_feedback_links l
      JOIN feedback f ON f.id = l.feedback_id
      JOIN projects p ON p.id = l.project_id
     WHERE l.room_id = ${room.id}::uuid AND l.thread = ${thread}
     ORDER BY f.created_at
  `)) as unknown as { slug: string; fb_seq: number }[];
  const [decided] = (await db.execute(sql`
    SELECT input->>'project' AS project FROM support_actions
     WHERE room_id = ${room.id}::uuid AND thread = ${thread} AND kind = 'routing_decided'
       AND input->>'project' IS NOT NULL
     ORDER BY created_at DESC LIMIT 1
  `)) as unknown as { project: string }[];
  return {
    records: records.map((r) => `${r.slug} FB-${r.fb_seq}`),
    decidedProject: decided?.project ?? null,
  };
}

/**
 * The routing signals of each member message of a turn, by its row id: read once per sender and
 * once per thread. An operations room routes nothing between projects, so it is handed none.
 */
export async function routingSignalsOf(
  room: RoomRow,
  rows: readonly ActionRow[],
): Promise<Map<string, RoutingSignals>> {
  const out = new Map<string, RoutingSignals>();
  const members = rows.filter((r) => r.actorKind === 'member' && r.actorKey);
  if (room.kind === 'operations' || members.length === 0) return out;
  const scope = await projectsInScope(room);
  const roomProjects = scope.map((p) => p.slug);
  const { namespace } = await roomAuth(room);
  const senders = new Map<string, Promise<SenderSignals>>();
  const threads = new Map<string, Promise<ThreadSignals>>();
  for (const r of members) {
    const key = r.actorKey as string;
    if (!senders.has(`${key}\u0000${r.thread}`)) {
      senders.set(
        `${key}\u0000${r.thread}`,
        (async () => {
          const sender = await senderAccountOf(room, namespace, key);
          const userId = sender?.userId ?? null;
          const account = sender?.name ?? null;
          const [pastProjects, filedFor, reported] = await Promise.all([
            pastProjectsOf(room, key, r.thread),
            filedForOf(room, key),
            reportedOf(
              userId,
              scope.map((p) => p.id),
            ),
          ]);
          return { linked: userId !== null, account, pastProjects, filedFor, reported };
        })(),
      );
    }
    if (!threads.has(r.thread)) threads.set(r.thread, threadSignalsOf(room, r.thread));
  }
  for (const r of members) {
    out.set(r.id, {
      roomProjects,
      sender: await (senders.get(`${r.actorKey}\u0000${r.thread}`) as Promise<SenderSignals>),
      thread: await (threads.get(r.thread) as Promise<ThreadSignals>),
    });
  }
  return out;
}
