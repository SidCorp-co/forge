// Which turn of a room's session an action is written in (ISS-1029): the one whose credential the
// request arrived on. Core hands each turn a token of its own, minted at the hand-over and revoked
// when the turn ends, so the token is the turn; the session is the one it was minted for. A row
// written on no turn's token (a member's message, a core note, a sweep) names neither.

import { boxSessionOfToken } from '../agent-sessions/index.js';
import { currentPatScope } from '../credentials/pat-scope.js';

export interface ActTurn {
  sessionId: string | null;
  turnId: string | null;
}

const NO_TURN: ActTurn = { sessionId: null, turnId: null };

/** The session and turn this request acts in, or neither when it arrived on no turn's token. */
export async function turnOfRequest(): Promise<ActTurn> {
  const tokenId = currentPatScope()?.tokenId;
  if (!tokenId) return NO_TURN;
  const sessionId = await boxSessionOfToken(tokenId);
  return sessionId ? { sessionId, turnId: tokenId } : NO_TURN;
}
