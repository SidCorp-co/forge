import { LIVE_SESSION_STATUSES } from '@forge/contracts/session-machine';
import { and, eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { withKernelMarker } from '../db/kernel-marker.js';
import { type AgentSessionStatus, agentSessions, agentSessionTurns } from '../db/schema.js';
import { agentSessionEvents } from '../db/schema-agent-session-events.js';
import { lockXact } from '../lib/advisory-lock.js';
import { type KernelActor, movedRow } from '../lifecycle/index.js';
import { notFound } from '../middleware/route-errors.js';
import { recordReportedTranscript } from './session-events.js';
import type { AgentSessionPatch } from './session-failure.js';
import { transitionSessions } from './session-transition.js';
import { syncTurnsWithMessages, truncateTurnsAfter } from './turns-helpers.js';

type SessionRow = typeof agentSessions.$inferSelect;
type TurnSync = Awaited<ReturnType<typeof syncTurnsWithMessages>>;

/** Stamp a runner's ack onto a still-running session; a terminal one is left as it is. */
export async function markSessionAcked(
  sessionId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db
    .update(agentSessions)
    .set({ metadata: { ...metadata, acked: true, ackedAt: new Date().toISOString() } })
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.status, 'running')));
}

type SessionPatchWrite = {
  sessionId: string;
  existing: SessionRow;
  columns: Omit<AgentSessionPatch, 'status'>;
  /** The status to move to through the session machine; absent, the columns are written as they are. */
  to?: AgentSessionStatus | undefined;
  actor: KernelActor;
  /** A reported transcript to record as a snapshot, or null. */
  snapshot: Record<string, unknown>[] | null;
  /** The messages the turn rows are mirrored to, or null when the patch carried none. */
  messages: unknown[] | null;
  at: Date;
};

/**
 * A worker or user PATCH, written in one transaction with the turn rows mirrored to the messages
 * blob so the two never diverge. A status move is a compare-and-set on the status `existing` read.
 */
export async function writeSessionPatch(
  w: SessionPatchWrite,
): Promise<{ updated: SessionRow; sync: TurnSync | null }> {
  const mirror = async (tx: Tx, rowId: string) => {
    if (w.snapshot) await recordReportedTranscript(tx, w.sessionId, w.snapshot, w.at);
    if (!w.messages) return null;
    const prev = Array.isArray(w.existing.messages) ? w.existing.messages : [];
    return syncTurnsWithMessages(rowId, prev, w.messages, tx);
  };
  let sync: TurnSync | null = null;
  if (w.to !== undefined && w.to !== w.existing.status) {
    const row = movedRow(
      await transitionSessions(db, {
        to: w.to,
        expect: w.existing.status,
        set: w.columns,
        where: eq(agentSessions.id, w.sessionId),
        actor: w.actor,
        source: 'session-patch',
        afterWrite: async (tx, rows) => {
          if (rows[0]) sync = await mirror(tx, rows[0].id);
        },
      }),
      sessionGone,
    );
    return { updated: row, sync };
  }
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(agentSessions)
      .set(w.columns)
      .where(eq(agentSessions.id, w.sessionId))
      .returning();
    if (!row) throw notFound('agent session not found');
    sync = await mirror(tx, row.id);
    return row;
  });
  return { updated, sync };
}

/** Delete a session row under the kernel marker. */
export async function deleteSession(sessionId: string): Promise<void> {
  await withKernelMarker(db, async (tx) =>
    tx.delete(agentSessions).where(eq(agentSessions.id, sessionId)),
  );
}

const sessionGone = () => notFound('agent session not found');

/** Move a session to `idle` so its owner can resume it, from the status the caller read. */
export async function abortSession(
  sessionId: string,
  expect: AgentSessionStatus,
  actor: KernelActor,
) {
  return movedRow(
    await transitionSessions(db, {
      to: 'idle',
      expect,
      set: { updatedAt: new Date() },
      where: eq(agentSessions.id, sessionId),
      actor,
      source: 'session-abort',
    }),
    sessionGone,
  );
}

/**
 * Fail a live session as `user_cancelled`, compare-and-set on the live statuses so a worker write
 * that landed in between is not stomped; null when the session was no longer live.
 */
export async function cancelSession(sessionId: string, actor: KernelActor) {
  const [row] = (
    await transitionSessions(db, {
      to: 'failed',
      set: { failureReason: 'user_cancelled', updatedAt: new Date() },
      where: and(
        eq(agentSessions.id, sessionId),
        inArray(agentSessions.status, LIVE_SESSION_STATUSES),
      ),
      reason: 'user_cancelled',
      actor,
      source: 'session-cancel',
    })
  ).rows;
  return row ?? null;
}
type ChatLine = {
  seq: number;
  kind: 'stdout';
  data: Record<string, unknown>;
  ts?: string | undefined;
};

/**
 * Store a chat turn's stream-json lines under the session's advisory lock. Refused with the
 * first seq a core-written row already holds; a seq already stored as stdout is a duplicate.
 */
export async function appendChatLines(
  sessionId: string,
  lines: ChatLine[],
): Promise<
  { ok: true; inserted: { seq: number }[] } | { ok: false; taken: { seq: number; kind: string } }
> {
  return db.transaction(async (tx) => {
    await lockXact(tx, 'agentSession', sessionId);
    const claimed = await tx
      .select({ seq: agentSessionEvents.seq, kind: agentSessionEvents.kind })
      .from(agentSessionEvents)
      .where(
        and(
          eq(agentSessionEvents.agentSessionId, sessionId),
          inArray(
            agentSessionEvents.seq,
            lines.map((e) => e.seq),
          ),
        ),
      );
    const taken = claimed.find((row) => row.kind !== 'stdout');
    if (taken) return { ok: false as const, taken };
    const inserted = await tx
      .insert(agentSessionEvents)
      .values(
        lines.map((e) => ({
          agentSessionId: sessionId,
          kind: e.kind,
          data: e.data,
          seq: e.seq,
          ...(e.ts ? { ts: new Date(e.ts) } : {}),
        })),
      )
      .onConflictDoNothing({
        target: [agentSessionEvents.agentSessionId, agentSessionEvents.seq],
      })
      .returning({ seq: agentSessionEvents.seq });
    return { ok: true as const, inserted };
  });
}

/** Rewrite a user turn and mirror it into the session's messages blob, in one transaction. */
export async function editUserTurn(e: {
  sessionId: string;
  turnId: string;
  content: unknown;
  messages: unknown[];
  at: Date;
}) {
  return db.transaction(async (tx) => {
    const [turnRow] = await tx
      .update(agentSessionTurns)
      .set({ content: e.content as never, editedAt: e.at })
      .where(eq(agentSessionTurns.id, e.turnId))
      .returning();
    if (!turnRow) throw notFound('turn not found');
    const [sessionRow] = await tx
      .update(agentSessions)
      .set({ messages: e.messages as never, updatedAt: e.at })
      .where(eq(agentSessions.id, e.sessionId))
      .returning();
    if (!sessionRow) throw notFound('agent session not found');
    await recordReportedTranscript(tx, e.sessionId, e.messages as Record<string, unknown>[], e.at);
    return [turnRow, sessionRow] as const;
  });
}

/**
 * Queue a session for regeneration from `messages`, truncating its turn rows after them;
 * compare-and-set on the status and `updatedAt` read, null when the session changed first.
 */
export async function requeueForRegeneration(r: {
  session: Pick<SessionRow, 'id' | 'status' | 'updatedAt'>;
  messages: unknown[];
  actor: KernelActor;
}) {
  const at = new Date();
  const [row] = (
    await transitionSessions(db, {
      to: 'queued',
      set: { messages: r.messages as never, failureReason: null, dispatchedAt: at, updatedAt: at },
      where: and(
        eq(agentSessions.id, r.session.id),
        eq(agentSessions.status, r.session.status),
        eq(agentSessions.updatedAt, r.session.updatedAt),
      ),
      actor: r.actor,
      source: 'session-regenerate',
      afterWrite: async (tx) => {
        await truncateTurnsAfter(r.session.id, r.messages.length - 1, tx);
        await recordReportedTranscript(
          tx,
          r.session.id,
          r.messages as Record<string, unknown>[],
          at,
        );
      },
    })
  ).rows;
  return row ?? null;
}

/** Open a forked chat session holding `messages`, with its turn rows materialized fresh. */
export async function insertForkedSession(
  values: typeof agentSessions.$inferInsert & { messages: unknown[] },
): Promise<{ inserted: SessionRow; seedSync: TurnSync }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(agentSessions).values(values).returning();
    if (!row) throw new Error('agent_sessions: insert returned no row');
    const seedSync = await syncTurnsWithMessages(row.id, [], values.messages, tx);
    return { inserted: row, seedSync };
  });
}
