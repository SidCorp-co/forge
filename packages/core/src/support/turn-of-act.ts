// Which turn of a room's session an action is written in (ISS-1029): the session the request's token
// was minted for, and its turn open when the request arrived. The session holds one token across its
// turns (ISS-1202), so the turn is its own row (`session-turns.ts`), never the token. A request on
// the session's token between its turns names the session and no turn; a row written on no turn's
// token (a member's message, a core note, a sweep) names neither.

import { boxSessionOfToken } from '../agent-sessions/index.js';
import { currentPatScope } from '../credentials/pat-scope.js';
import { openTurnOf } from './session-turns.js';

export interface ActTurn {
  sessionId: string | null;
  turnId: string | null;
}

const NO_TURN: ActTurn = { sessionId: null, turnId: null };

/** The session and turn this request acts in, or neither when it arrived on no session's token. */
export async function turnOfRequest(): Promise<ActTurn> {
  const tokenId = currentPatScope()?.tokenId;
  if (!tokenId) return NO_TURN;
  const sessionId = await boxSessionOfToken(tokenId);
  return sessionId ? { sessionId, turnId: await openTurnOf(sessionId) } : NO_TURN;
}
