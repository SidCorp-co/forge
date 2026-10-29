// The support domain's delivery ledger: which inbound messages a turn took, how each reached the
// session, what became of one written into a running turn, and how long each waited for an answer.
// Kept beside `store.ts`, which owns the rest of the support tables' reads and writes.

import type { SupportDeliveryPath } from '@forge/contracts/support';
import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions, supportRooms } from '../db/schema-support.js';
import type { ActionRow } from './store.js';

/** Take every undelivered inbound message of a room for one turn, oldest first. */
export async function claimUndelivered(roomId: string, at: Date): Promise<ActionRow[]> {
  return db
    .update(supportActions)
    .set({ deliveredAt: at })
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.kind, 'message_in'),
        isNull(supportActions.deliveredAt),
      ),
    )
    .returning()
    .then((rows) => rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()));
}

/** Give back what a turn took when the turn never reached its box. */
export async function unclaim(ids: readonly string[], at: Date): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(supportActions)
    .set({ deliveredAt: null })
    .where(and(inArray(supportActions.id, [...ids]), eq(supportActions.deliveredAt, at)));
}

/**
 * The messages the room's last turn took that the session wrote nothing back to: each delivered at
 * or after `since`, when that turn was handed over (a message written into the running turn is
 * delivered later), in a thread with no session action since. With no `since` (core restarted
 * while the turn ran) the turn is read as the newest handed over, which an injected message never
 * starts.
 */
export async function unansweredOfLastTurn(
  roomId: string,
  since: Date | null,
): Promise<ActionRow[]> {
  let from = since;
  if (!from) {
    const [last] = await db
      .select({
        at: sql<Date | null>`max(${supportActions.deliveredAt})`.mapWith((v) =>
          v ? new Date(v) : null,
        ),
      })
      .from(supportActions)
      .where(
        and(
          eq(supportActions.roomId, roomId),
          eq(supportActions.kind, 'message_in'),
          sql`NOT (COALESCE(${supportActions.output}, '{}'::jsonb) ? 'injectSeq')`,
        ),
      );
    from = last?.at ?? null;
  }
  if (!from) return [];
  const taken = await db
    .select()
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.kind, 'message_in'),
        gte(supportActions.deliveredAt, from),
      ),
    )
    .orderBy(asc(supportActions.createdAt));
  const answered = await db
    .selectDistinct({ thread: supportActions.thread })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.actorKind, 'session'),
        gte(supportActions.createdAt, from),
      ),
    );
  const done = new Set(answered.map((a) => a.thread));
  return taken.filter((m) => !done.has(m.thread));
}

/** Of `ids`, the messages a failed turn was already reported for. */
export async function toldFailed(roomId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ output: supportActions.output })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.kind, 'refused'),
        eq(supportActions.tool, 'turn_failed'),
      ),
    );
  const told = new Set(
    rows.flatMap((r) => ((r.output as { messages?: string[] } | null)?.messages ?? []) as string[]),
  );
  return new Set(ids.filter((id) => told.has(id)));
}

/** Record on each message how it reached the session (and, written into a turn, its inbox seq). */
export async function markDelivery(
  ids: readonly string[],
  delivery: { path: SupportDeliveryPath; injectSeq?: number },
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(supportActions)
    .set({
      output: sql`COALESCE(${supportActions.output}, '{}'::jsonb) || ${JSON.stringify(delivery)}::jsonb`,
    })
    .where(inArray(supportActions.id, [...ids]));
}

/** Messages written into a running turn whose fate the box has not yet settled. */
export async function unsettledInjects(roomId?: string): Promise<ActionRow[]> {
  return db
    .select()
    .from(supportActions)
    .where(
      and(
        roomId ? eq(supportActions.roomId, roomId) : undefined,
        eq(supportActions.kind, 'message_in'),
        sql`${supportActions.deliveredAt} IS NOT NULL`,
        sql`COALESCE(${supportActions.output}, '{}'::jsonb) ? 'injectSeq'`,
        sql`NOT (COALESCE(${supportActions.output}, '{}'::jsonb) ? 'injectSettled')`,
      ),
    )
    .orderBy(asc(supportActions.createdAt))
    .limit(500);
}

export async function settleInjected(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(supportActions)
    .set({
      output: sql`COALESCE(${supportActions.output}, '{}'::jsonb) || '{"injectSettled": true}'::jsonb`,
    })
    .where(inArray(supportActions.id, [...ids]));
}

/** A message the box did not take into a turn waits again for the next one. */
export async function giveBackInjected(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(supportActions)
    .set({
      deliveredAt: null,
      output: sql`COALESCE(${supportActions.output}, '{}'::jsonb) - 'injectSeq' - 'path'`,
    })
    .where(inArray(supportActions.id, [...ids]));
}

/**
 * The session posted in `thread` at `at`: every message of the thread it had been handed and not yet
 * answered is answered now, its latency read from its Rocket.Chat timestamp (its receipt where the
 * server sent none).
 */
export async function settleLatency(roomId: string, thread: string, at: Date): Promise<void> {
  const iso = at.toISOString();
  await db
    .update(supportActions)
    .set({
      output: sql`COALESCE(${supportActions.output}, '{}'::jsonb) || jsonb_build_object(
        'answeredAt', ${iso}::text,
        'latencyMs', GREATEST(0, ROUND(EXTRACT(EPOCH FROM (${iso}::timestamptz - COALESCE(
          (${supportActions.input}->>'ts')::timestamptz, ${supportActions.createdAt}))) * 1000))::int
      )`,
    })
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.thread, thread),
        eq(supportActions.kind, 'message_in'),
        sql`${supportActions.deliveredAt} IS NOT NULL`,
        sql`${supportActions.createdAt} <= ${iso}::timestamptz`,
        sql`NOT (COALESCE(${supportActions.output}, '{}'::jsonb) ? 'latencyMs')`,
      ),
    );
}

/** The latency of a room's last answered messages, newest first, with how each was delivered. */
export async function latencySamples(
  roomId: string,
  limit: number,
): Promise<{ ms: number; path: string | null }[]> {
  const rows = await db
    .select({
      ms: sql<number>`(${supportActions.output}->>'latencyMs')::int`,
      path: sql<string | null>`${supportActions.output}->>'path'`,
    })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.kind, 'message_in'),
        sql`COALESCE(${supportActions.output}, '{}'::jsonb) ? 'latencyMs'`,
      ),
    )
    .orderBy(desc(supportActions.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ms: Number(r.ms), path: r.path }));
}

/**
 * Every room, for the warm sweep: one whose session is gone is given a new one there, as a master's
 * pane is placed again (REQ-77 BC-1); one its binding no longer names is left alone by the sweep.
 */
export async function roomsToWarm(): Promise<{ id: string; sessionId: string | null }[]> {
  return db.select({ id: supportRooms.id, sessionId: supportRooms.sessionId }).from(supportRooms);
}

/** The rooms of every project in `projectIds`. */
export async function roomsOfProjects(projectIds: readonly string[]): Promise<string[]> {
  if (projectIds.length === 0) return [];
  const rows = await db
    .select({ id: supportRooms.id })
    .from(supportRooms)
    .where(inArray(supportRooms.projectId, [...projectIds]));
  return rows.map((r) => r.id);
}

/** The oldest inbound message of a room no turn has taken. */
export async function oldestUndelivered(roomId: string): Promise<ActionRow | null> {
  const [row] = await db
    .select()
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.kind, 'message_in'),
        isNull(supportActions.deliveredAt),
      ),
    )
    .orderBy(asc(supportActions.createdAt))
    .limit(1);
  return row ?? null;
}

export async function hasUndelivered(roomId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: supportActions.id })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.kind, 'message_in'),
        isNull(supportActions.deliveredAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Rooms holding an inbound message no turn has taken. */
export async function roomsWithUndelivered(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ roomId: supportActions.roomId })
    .from(supportActions)
    .where(and(eq(supportActions.kind, 'message_in'), isNull(supportActions.deliveredAt)));
  return rows.map((r) => r.roomId);
}

/** The room a support action belongs to; null where there is no such action. */
export async function roomOfAction(actionId: string): Promise<string | null> {
  const [row] = await db
    .select({ roomId: supportActions.roomId })
    .from(supportActions)
    .where(eq(supportActions.id, actionId))
    .limit(1);
  return row?.roomId ?? null;
}
