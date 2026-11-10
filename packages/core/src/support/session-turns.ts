// The turns of a room's session (ISS-1202). The session holds one token across its turns, so a turn
// is a row of its own: opened when core hands the turn over (`dispatch.ts:handTurn`), ended by the
// statement that moves the session off `running`, whoever writes it (migration 0649's trigger). An
// act names the turn open when it arrives (`turn-of-act.ts`), and a turn's record reads its span
// here (`turn-record.ts`, ISS-1029).

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportSessionTurns } from '../db/schema-support-turns.js';

/**
 * Open the session's next turn, ending any it left open: a turn whose end never moved the session,
 * as one whose hand-over failed after the turn was opened, is over once another starts.
 */
export async function openSessionTurn(sessionId: string): Promise<string> {
  return db.transaction(async (tx) => {
    await tx
      .update(supportSessionTurns)
      .set({ endedAt: sql`GREATEST(now(), ${supportSessionTurns.startedAt})` })
      .where(
        and(eq(supportSessionTurns.sessionId, sessionId), isNull(supportSessionTurns.endedAt)),
      );
    const [opened] = await tx
      .insert(supportSessionTurns)
      .values({ sessionId })
      .returning({ id: supportSessionTurns.id });
    if (!opened) throw new Error(`support: no turn could be opened for session ${sessionId}`);
    return opened.id;
  });
}

/** The session's turn running now, or null between its turns. */
export async function openTurnOf(sessionId: string): Promise<string | null> {
  const [open] = await db
    .select({ id: supportSessionTurns.id })
    .from(supportSessionTurns)
    .where(and(eq(supportSessionTurns.sessionId, sessionId), isNull(supportSessionTurns.endedAt)))
    .orderBy(desc(supportSessionTurns.startedAt))
    .limit(1);
  return open?.id ?? null;
}

/** The span of one turn: opened at its hand-over, ended when it stopped (`endedAt` null while it runs). */
export async function sessionTurnSpan(
  turnId: string,
): Promise<{ sessionId: string; startedAt: Date; endedAt: Date | null } | null> {
  const [turn] = await db
    .select({
      sessionId: supportSessionTurns.sessionId,
      startedAt: supportSessionTurns.startedAt,
      endedAt: supportSessionTurns.endedAt,
    })
    .from(supportSessionTurns)
    .where(eq(supportSessionTurns.id, turnId))
    .limit(1);
  return turn ?? null;
}
