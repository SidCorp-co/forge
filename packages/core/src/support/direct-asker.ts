// Whom an act of a room's session runs as when it names a direct message (ISS-950): the sender
// `direct-turn.ts` recorded for the turn, only while that turn runs. The session holds one token
// across its turns (ISS-1202), so the turn is read from its own row, never the token: a turn handed
// later, or the session between turns, names no direct message, whatever an earlier turn's text said.

import { sessionRowById } from '../agent-sessions/index.js';
import type { Asker } from './ops-asker.js';
import { no, type Outcome } from './outcome.js';
import type { RoomRow } from './store.js';
import { turnOfRequest } from './turn-of-act.js';

/** The thread an act names to run as the sender of the direct message its turn was handed. */
export const DIRECT_THREAD = 'direct';

/** The session metadata key core writes for its running direct turn (core-owned: no caller sets it). */
export const DIRECT_TURN_KEY = 'directTurn';

export interface DirectTurnRecord {
  id: string;
  userId: string;
  label: string;
  /** The turn it was handed in (`session-turns.ts`): an act in any other turn, or none, is not its. */
  turnId: string;
}

/**
 * The sender of the direct message `message`, where the act arrives in the turn it was handed in;
 * otherwise the refusal naming why no direct message stands behind the act.
 */
export async function directAskerOf(room: RoomRow, message: string): Promise<Outcome<Asker>> {
  const session = room.sessionId ? await sessionRowById(room.sessionId) : null;
  const record = (session?.metadata as Record<string, unknown> | null)?.[DIRECT_TURN_KEY] as
    | DirectTurnRecord
    | undefined;
  const { sessionId, turnId } = await turnOfRequest();
  if (
    !record ||
    record.id !== message ||
    !turnId ||
    record.turnId !== turnId ||
    sessionId !== room.sessionId
  ) {
    return no(
      'OPS_ASKER_MESSAGE_UNKNOWN',
      '/message',
      `message ${message} is not the direct message this turn was handed; thread \`${DIRECT_THREAD}\` names only the one of the running turn, as its text carries it`,
    );
  }
  return {
    ok: true,
    value: {
      key: `forge:${record.userId}`,
      label: record.label,
      userId: record.userId,
      via: 'direct',
    },
  };
}
