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
  const [row] = await tx
    .insert(agentSessions)
    .values(values)
    .returning({ id: agentSessions.id });
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
