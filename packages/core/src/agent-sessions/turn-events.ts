// The raw lines one box-session turn printed, in order (ISS-1029): what a room's session read and
// said in a turn, for a reader who holds the project. The window is the turn's own span, as its token
// says it (`chat-door.ts:boxTurnOfToken`).

import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessionEvents } from '../db/schema-agent-session-events.js';

/** At most this many lines are read for one turn; a turn past it says it was cut. */
export const TURN_EVENTS_SHOWN = 400;

/** The stdout lines the session posted between `from` and `to`, oldest first, and whether more were. */
export async function turnStdoutLines(
  sessionId: string,
  from: Date,
  to: Date,
): Promise<{ lines: unknown[]; cut: boolean }> {
  const rows = await db
    .select({ data: agentSessionEvents.data })
    .from(agentSessionEvents)
    .where(
      and(
        eq(agentSessionEvents.agentSessionId, sessionId),
        eq(agentSessionEvents.kind, 'stdout'),
        gte(agentSessionEvents.ts, from),
        lte(agentSessionEvents.ts, to),
      ),
    )
    .orderBy(asc(agentSessionEvents.seq))
    .limit(TURN_EVENTS_SHOWN + 1);
  return {
    lines: rows.slice(0, TURN_EVENTS_SHOWN).map((r) => r.data),
    cut: rows.length > TURN_EVENTS_SHOWN,
  };
}
