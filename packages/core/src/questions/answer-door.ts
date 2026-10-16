// Who may answer a question with a token, read by both doors that take one: REST's answer route
// and the MCP door's `forge_questions answer`, so a token is refused the same question at each.

import { forbidden, notFound } from '../middleware/route-errors.js';
import { readQuestionFor } from './read.js';

const sessionOnly = () =>
  forbidden(
    'a question is answered by a person in a session, and this request carries a personal ' +
      'access token. Sign in to answer it, or reply in the room the question was delivered to.',
  );

/**
 * A question whose blocker is another agent, answered by a credential that
 * names an agent — and by nothing else (ISS-1003).
 *
 * `blockerKind: 'master_or_peer'` says in the row itself that the thing this
 * run is waiting on is another agent. Before this, no credential could answer
 * it: every token was refused here and no agent held a session, so a peer-
 * blocked park could only ever be cleared by a person standing in for the peer.
 */
const peerBlockedOnly = () =>
  forbidden(
    'this question is blocked on another agent, and this request carries a personal access ' +
      'token owned by a person, which establishes nobody: a borrowed credential may act but may ' +
      'not say who is speaking. Answer it with the agent’s OWN Agent Access Token — an org admin ' +
      'mints one for an existing agent at POST /api/orgs/:orgId/agents/:agentUserId/tokens. Or ' +
      'sign in and answer it as a person.',
  );

/**
 * Refuses a token's answer unless the question waits on another agent and the token is that kind of
 * agent's own: a person's question is a person's act in a session, which a token does not establish.
 */
export async function assertTokenMayAnswer(token: {
  questionId: string;
  userId: string;
  agentUserId: string | null;
}): Promise<void> {
  const seen = await readQuestionFor(token.questionId, token.agentUserId ?? token.userId);
  if (!seen) throw notFound('question not found');
  if (seen.blockerKind !== 'master_or_peer') throw sessionOnly();
  if (!token.agentUserId) throw peerBlockedOnly();
}
