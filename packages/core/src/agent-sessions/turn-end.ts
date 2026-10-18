/**
 * Ending a chat's in-flight turn. The box's `agent:abort` ends a chat's turn and nothing else, so on
 * any other kind an `idle` written here would be a session core calls stopped while its agent runs
 * on, and its reaper, which reads `running` only, would never end it (ISS-1228).
 */

import { and, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { withKernelMarker } from '../db/kernel-marker.js';
import { agentSessions } from '../db/schema.js';
import { LIVE_SESSION_STATUSES } from '../lifecycle/status-sets.js';
import { type KernelActor, recordKernelTransition } from '../lifecycle/transition.js';

type SessionRow = typeof agentSessions.$inferSelect;

export function turnNotEndable(kind: string): HTTPException {
  return new HTTPException(409, {
    message: `This is a ${kind} session, not a chat, so its box ends no turn of it. Stop the session to end it.`,
    cause: { code: 'TURN_NOT_ENDABLE' },
  });
}

export function chatEnded(): HTTPException {
  return new HTTPException(409, {
    message: 'The chat has ended, so it has no turn to end.',
    cause: { code: 'SESSION_ENDED' },
  });
}

const isOpen = (status: string): boolean =>
  (LIVE_SESSION_STATUSES as readonly string[]).includes(status);

/** Leaves the chat `idle`, recording the move; the kind is judged before the status. */
export async function endChatTurn(session: SessionRow, actor: KernelActor): Promise<SessionRow> {
  if (session.kind !== 'chat') throw turnNotEndable(session.kind);
  if (!isOpen(session.status)) throw chatEnded();
  const updated = await withKernelMarker(db, async (tx) => {
    const [row] = await tx
      .update(agentSessions)
      .set({ status: 'idle', updatedAt: new Date() })
      .where(
        and(eq(agentSessions.id, session.id), inArray(agentSessions.status, LIVE_SESSION_STATUSES)),
      )
      .returning();
    if (row && session.status !== 'idle') {
      await recordKernelTransition(tx, [
        {
          entity: 'session',
          entityId: row.id,
          fromStatus: session.status,
          toStatus: 'idle',
          reason: 'turn_ended',
          actor,
          source: 'session-abort',
        },
      ]);
    }
    return row;
  });
  if (!updated) throw chatEnded();
  return updated;
}
