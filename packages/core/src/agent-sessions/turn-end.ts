/**
 * Ending a chat's in-flight turn. The box's `agent:abort` ends a chat's turn and nothing else, so on
 * any other kind an `idle` written here would be a session core calls stopped while its agent runs
 * on, and its reaper, which reads `running` only, would never end it (ISS-1228).
 */

import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { withKernelMarker } from '../db/kernel-marker.js';
import { agentSessions } from '../db/schema.js';
import { LIVE_SESSION_STATUSES } from '../lifecycle/status-sets.js';
import { type KernelActor, recordKernelTransition } from '../lifecycle/transition.js';

type SessionRow = typeof agentSessions.$inferSelect;

/** Each kind but a chat in the words the sessions list tags it with, never its stored name. */
const KIND_WORDS: Record<Exclude<SessionRow['kind'], 'chat'>, string> = {
  run_session: 'a run',
  master: 'a master',
  pipeline: 'a pipeline step',
  pm: 'a PM session',
};

export function turnNotEndable(kind: SessionRow['kind']): HTTPException {
  const words = kind === 'chat' ? null : KIND_WORDS[kind];
  return new HTTPException(409, {
    message: words
      ? `This is ${words}, not a chat. Use Stop session.`
      : 'This is not a chat. Use Stop session.',
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

/**
 * Leaves the chat `idle`, recording the move from the status the locked row holds, never the one the
 * caller read; the kind is judged before the status.
 */
export async function endChatTurn(session: SessionRow, actor: KernelActor): Promise<SessionRow> {
  if (session.kind !== 'chat') throw turnNotEndable(session.kind);
  if (!isOpen(session.status)) throw chatEnded();
  const updated = await withKernelMarker(db, async (tx) => {
    const [held] = await tx
      .select({ status: agentSessions.status })
      .from(agentSessions)
      .where(eq(agentSessions.id, session.id))
      .for('update');
    if (!held || !isOpen(held.status)) return undefined;
    const [row] = await tx
      .update(agentSessions)
      .set({ status: 'idle', updatedAt: new Date() })
      .where(eq(agentSessions.id, session.id))
      .returning();
    if (row && held.status !== 'idle') {
      await recordKernelTransition(tx, [
        {
          entity: 'session',
          entityId: row.id,
          fromStatus: held.status,
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
