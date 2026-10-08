import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import {
  type SessionRuntimeState,
  terminalAgentSessionStatuses,
} from '../db/session-vocabulary.js';

/**
 * The one insert into `agent_sessions`, inside the caller's transaction. A module that opens a
 * session as part of its own act (a job dispatch, a master or run registration) calls it there.
 */
export async function insertSessionRow(
  tx: Tx,
  values: typeof agentSessions.$inferInsert,
): Promise<{ id: string }> {
  const [row] = await tx.insert(agentSessions).values(values).returning({ id: agentSessions.id });
  if (!row) throw new Error('agent_sessions: insert returned no row');
  return row;
}

/** Merge keys into a session's metadata; no other key is touched. */
export async function mergeSessionMetadata(
  agentSessionId: string,
  patch: Record<string, unknown>,
  tx: Tx = db,
): Promise<void> {
  await tx
    .update(agentSessions)
    .set({
      metadata: sql`coalesce(${agentSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
    })
    .where(eq(agentSessions.id, agentSessionId));
}

/**
 * Stamp `deliveredAt` under one metadata key, once: false when another writer already stamped it.
 */
export async function claimSessionMetadataDelivery(
  agentSessionId: string,
  key: string,
  at: Date = new Date(),
): Promise<boolean> {
  const claimed = await db
    .update(agentSessions)
    .set({
      metadata: sql`jsonb_set(coalesce(${agentSessions.metadata}, '{}'::jsonb), ARRAY[${key}::text],
        coalesce(${agentSessions.metadata} -> ${key}::text, '{}'::jsonb) || jsonb_build_object('deliveredAt', ${at.toISOString()}::text), true)`,
    })
    .where(
      and(
        eq(agentSessions.id, agentSessionId),
        sql`(${agentSessions.metadata} -> ${key}::text ->> 'deliveredAt') IS NULL`,
      ),
    )
    .returning({ id: agentSessions.id });
  return claimed.length > 0;
}

/**
 * Merge `stamp` into one metadata key while neither its `claimedAt` nor its `deliveredAt` is set:
 * false when another writer claimed it first. The merge is made on the row as it holds it now, so a
 * field another writer set since `session` was read (a block staged by `appendUnclaimedMarkerItem`)
 * survives the claim.
 */
export async function claimSessionMarker(
  session: { id: string },
  key: string,
  stamp: Record<string, unknown>,
): Promise<boolean> {
  const claimed = await db
    .update(agentSessions)
    .set({
      metadata: sql`jsonb_set(coalesce(${agentSessions.metadata}, '{}'::jsonb), ARRAY[${key}::text],
        coalesce(${agentSessions.metadata} -> ${key}::text, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb, true)`,
    })
    .where(
      and(
        eq(agentSessions.id, session.id),
        sql`(${agentSessions.metadata} -> ${key}::text ->> 'claimedAt') IS NULL AND (${agentSessions.metadata} -> ${key}::text ->> 'deliveredAt') IS NULL`,
      ),
    )
    .returning({ id: agentSessions.id });
  return claimed.length > 0;
}

/**
 * Append `item` to the list `field` under one metadata key, only while that key's `claimedAt` and
 * `deliveredAt` are both unset: false once a writer has claimed it, so nothing joins a delivery
 * already taken.
 */
export async function appendUnclaimedMarkerItem(
  agentSessionId: string,
  key: string,
  field: string,
  item: unknown,
): Promise<boolean> {
  const appended = await db
    .update(agentSessions)
    .set({
      metadata: sql`jsonb_set(${agentSessions.metadata}, ARRAY[${key}::text, ${field}::text],
        coalesce(${agentSessions.metadata} -> ${key}::text -> ${field}::text, '[]'::jsonb) || jsonb_build_array(${JSON.stringify(item)}::jsonb), true)`,
    })
    .where(
      and(
        eq(agentSessions.id, agentSessionId),
        sql`${agentSessions.metadata} -> ${key}::text IS NOT NULL`,
        sql`(${agentSessions.metadata} -> ${key}::text ->> 'claimedAt') IS NULL AND (${agentSessions.metadata} -> ${key}::text ->> 'deliveredAt') IS NULL`,
      ),
    )
    .returning({ id: agentSessions.id });
  return appended.length > 0;
}

/** Merge `stamp` into one metadata key as the row holds it now. */
export async function stampSessionMarker(
  agentSessionId: string,
  key: string,
  stamp: Record<string, unknown>,
): Promise<void> {
  const [row] = await db
    .select({ metadata: agentSessions.metadata })
    .from(agentSessions)
    .where(eq(agentSessions.id, agentSessionId))
    .limit(1);
  const prev = (row?.metadata as Record<string, unknown>) ?? {};
  const marker = (prev[key] as Record<string, unknown>) ?? {};
  await db
    .update(agentSessions)
    .set({ metadata: { ...prev, [key]: { ...marker, ...stamp } } as never })
    .where(eq(agentSessions.id, agentSessionId));
}

/** Set one field under one metadata key, leaving the rest of the document as it is. */
export async function setSessionMarkerField(
  agentSessionId: string,
  key: string,
  field: string,
  value: unknown,
): Promise<void> {
  await db
    .update(agentSessions)
    .set({
      metadata: sql`jsonb_set(${agentSessions.metadata}, ARRAY[${key}::text, ${field}::text], ${JSON.stringify(value)}::jsonb, true)`,
    })
    .where(eq(agentSessions.id, agentSessionId));
}

/**
 * A heartbeat on a session. With `liveOnly`, a session already past `running` is not touched;
 * true when a row was stamped.
 */
export async function beatSession(
  agentSessionId: string,
  opts: { at?: Date; liveOnly?: boolean } = {},
  tx: Tx = db,
): Promise<boolean> {
  const at = opts.at ?? new Date();
  const beat = await tx
    .update(agentSessions)
    .set({ lastHeartbeatAt: at, updatedAt: at })
    .where(
      opts.liveOnly
        ? and(
            eq(agentSessions.id, agentSessionId),
            inArray(agentSessions.status, ['queued', 'running']),
          )
        : eq(agentSessions.id, agentSessionId),
    )
    .returning({ id: agentSessions.id });
  return beat.length > 0;
}

/** What the box last reported its session doing, on a session that has not ended. */
export async function setSessionRuntimeState(
  agentSessionId: string,
  state: SessionRuntimeState,
): Promise<void> {
  await db
    .update(agentSessions)
    .set({ runtimeState: state, updatedAt: new Date() })
    .where(
      and(
        eq(agentSessions.id, agentSessionId),
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
      ),
    );
}

/**
 * A resident session core told its box to close and heard nothing back for: the residency is over
 * whether or not the box ever answers, so the row stops reading as one waiting in a process.
 */
export async function endLapsedResidency(agentSessionId: string): Promise<boolean> {
  const ended = await db
    .update(agentSessions)
    .set({ runtimeState: 'closed', updatedAt: new Date() })
    .where(
      and(eq(agentSessions.id, agentSessionId), eq(agentSessions.runtimeState, 'awaiting_input')),
    )
    .returning({ id: agentSessions.id });
  return ended.length > 0;
}

/** The failure class of a session and what was done about it. */
export async function setSessionFailureDetail(
  agentSessionId: string,
  detail: string,
): Promise<void> {
  await db
    .update(agentSessions)
    .set({ failureDetail: detail })
    .where(eq(agentSessions.id, agentSessionId));
}
