// Whom an act of a room's session runs as when it names a direct message (ISS-950): the sender
// `direct-turn.ts` recorded for the turn, only on the token that turn was handed. A turn handed
// later, its own token minted, names no direct message, whatever an earlier turn's text said.

import { sessionRowById } from '../agent-sessions/index.js';
import { currentPatScope } from '../credentials/pat-scope.js';
import type { Asker } from './ops-asker.js';
import { no, type Outcome } from './outcome.js';
import type { RoomRow } from './store.js';

/** The thread an act names to run as the sender of the direct message its turn was handed. */
export const DIRECT_THREAD = 'direct';

/** The session metadata key core writes for its running direct turn (core-owned: no caller sets it). */
export const DIRECT_TURN_KEY = 'directTurn';

export interface DirectTurnRecord {
  id: string;
  userId: string;
  label: string;
  /** The token the turn was handed: an act arriving on any other is not this turn's. */
  tokenId: string;
}

/**
 * The sender of the direct message `message`, where the act arrives on the token its turn was handed;
 * otherwise the refusal naming why no direct message stands behind the act.
 */
export async function directAskerOf(room: RoomRow, message: string): Promise<Outcome<Asker>> {
  const session = room.sessionId ? await sessionRowById(room.sessionId) : null;
  const record = (session?.metadata as Record<string, unknown> | null)?.[DIRECT_TURN_KEY] as
    | DirectTurnRecord
    | undefined;
  const tokenId = currentPatScope()?.tokenId ?? null;
  if (!record || record.id !== message || record.tokenId !== tokenId) {
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
