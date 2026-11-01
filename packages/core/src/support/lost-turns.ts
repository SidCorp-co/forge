// A turn core lost (ISS-850). A support session's turn reports its end over HTTP, and the box
// drops that report when core is not there to take it (the runner's `close_turn` on an unreached
// core); a turn handed over just before core went down may never have started at all. Either way
// the session reads `running` forever: no turn end fires `dispatch.ts:onSupportTurnEnded`, so no
// thread is told, and the messages it took read delivered, so the drain never offers them again.
// Nothing reaps a chat session's silence (`db/session-vocabulary.ts:heartbeatReapedSql`).
//
// So when core starts, when a box reconnects, and on the sweep between, a support session whose
// turn has gone silent past the beat window is read lost: the turn is ended, each message it took
// that no session action in its thread answered since is handed to the session once more, and one
// already handed on once, or whose room is no longer bound, is told it went unanswered instead.

import { JOB_HEARTBEAT_REAP_DEFAULT_MS } from '@forge/contracts/run-standing';
import { and, desc, eq, sql } from 'drizzle-orm';
import { sessionRowById, transitionSessions } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { agentSessions, kernelTransitions } from '../db/schema.js';
import { heartbeatBeatSql } from '../db/session-vocabulary.js';
import { logger } from '../lib/logger.js';
import { giveBackLost, roomsToWarm, unansweredOfLastTurn } from './delivery.js';
import { deliverWaiting, noteTurn, tellUnanswered } from './dispatch.js';
import { roomIsBound } from './rooms.js';
import { type ActionRow, roomById } from './store.js';

/**
 * How long a running turn's beat may be silent before it is read lost: the box beats a live turn
 * every minute (the runner's `TURN_BEAT_INTERVAL`), and this is the job heartbeat's reap window.
 */
export const LOST_TURN_SILENCE_MS = JOB_HEARTBEAT_REAP_DEFAULT_MS;

/** Every support session whose running turn went silent: its messages handed on, or told. */
export async function recoverLostTurns(now: Date = new Date()): Promise<void> {
  const bySession = new Map<string, string[]>();
  for (const { id, sessionId } of await roomsToWarm()) {
    if (sessionId) bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), id]);
  }
  for (const [sessionId, roomIds] of bySession) {
    await recoverSession(sessionId, roomIds, now).catch((err) =>
      logger.error({ err, sessionId }, 'support: recovering a lost turn failed'),
    );
  }
}

async function recoverSession(sessionId: string, roomIds: string[], now: Date): Promise<void> {
  const session = await sessionRowById(sessionId);
  if (session?.status !== 'running') return;
  const cutoff = new Date(now.getTime() - LOST_TURN_SILENCE_MS);
  const beat = session.lastHeartbeatAt ?? session.updatedAt;
  if (beat >= cutoff) return;
  const since = await turnStartOf(sessionId);
  const taken = new Map<string, ActionRow[]>();
  for (const roomId of roomIds) taken.set(roomId, await unansweredOfLastTurn(roomId, since));
  // the end below fires the turn-end bridge, whose failed-turn notice then reads none of these
  for (const roomId of roomIds) noteTurn(roomId, now);
  const ended = await transitionSessions(db, {
    to: 'failed',
    set: {
      failureReason: 'heartbeat_timeout',
      failureDetail: 'support: the turn went silent with no end reported; core read it lost',
      updatedAt: now,
    },
    where: and(
      eq(agentSessions.id, sessionId),
      eq(agentSessions.status, 'running'),
      // a beat landing since the read above keeps the turn
      sql`${heartbeatBeatSql(sql`${agentSessions}`)} < ${cutoff.toISOString()}`,
    ),
    reason: 'heartbeat_timeout',
    actor: { type: 'system' },
    source: 'support-lost-turn',
    returning: ['id'],
  });
  if (ended.rows.length === 0) return;
  logger.warn({ sessionId, since }, 'support: a turn went silent with no end reported; read lost');
  for (const [roomId, messages] of taken) await handOnOrTell(roomId, messages, now);
}

/** The lost turn's messages: handed on once where the room is still answered, told otherwise. */
async function handOnOrTell(roomId: string, messages: ActionRow[], now: Date): Promise<void> {
  const room = await roomById(roomId);
  if (!room || messages.length === 0) return;
  const bound = await roomIsBound(room);
  const fresh = bound ? messages.filter((m) => !handedOnBefore(m)) : [];
  const spent = messages.filter((m) => !fresh.includes(m));
  await giveBackLost(
    fresh.map((m) => m.id),
    now,
  );
  await tellUnanswered(
    room,
    spent,
    bound
      ? 'the turn it was handed on to was lost as well'
      : 'its turn was lost and its group is no longer answered',
  );
  // with no box to take it, the room is told its assistant is offline and the message waits
  if (fresh.length > 0) await deliverWaiting(room.id);
}

const handedOnBefore = (m: ActionRow) =>
  typeof (m.output as { redelivered?: unknown } | null)?.redelivered === 'string';

/**
 * When the session's running turn began, as messages are delivered: when its last turn before it
 * ended, the last move out of `running`. Null where no such move is recorded (a first turn, or
 * pruned), and the turn is then read as the newest handed over (`unansweredOfLastTurn`).
 */
async function turnStartOf(sessionId: string): Promise<Date | null> {
  const [move] = await db
    .select({ at: kernelTransitions.createdAt })
    .from(kernelTransitions)
    .where(
      and(
        eq(kernelTransitions.entity, 'session'),
        eq(kernelTransitions.entityId, sessionId),
        eq(kernelTransitions.fromStatus, 'running'),
      ),
    )
    .orderBy(desc(kernelTransitions.createdAt))
    .limit(1);
  return move?.at ?? null;
}
