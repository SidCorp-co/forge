// Who may answer a question with a token, read by every door that takes one: REST's answer route and
// the MCP door's `forge_questions answer` and `forge_requirements answer`, so a token is refused the
// same question at each.
//
// A person's own token answers what its holder could answer signed in (owner, 2026-10-16, on the
// ground of ADR 0007: whoever holds the permission acts). This door only says whose word the token
// carries; whether that person may answer this question is `answerAs`'s, the check a session's answer
// meets — the project role and the chosen option's authority — never a second copy of it here.

import type { ActorAgency } from '@forge/contracts/permissions';
import { tokenIdentityOf } from '../credentials/token-identity.js';
import type { QuestionBlockerKind } from '../db/schema-questions.js';
import { notFound } from '../middleware/route-errors.js';
import { type AnswerBody, givenAnswerOf } from './answer-input.js';
import { doorOfToken } from './ports.js';
import { answerAs, readQuestionFor } from './read.js';
import { refuseQuestion } from './write.js';

const OWN_TOKEN =
  'their own personal access token, or the MCP client they signed in to Forge with (Claude Code ' +
  'and the like)';

/** An agent's token on a question an agent does not owe (ISS-1003: an agent answers another agent). */
const owedByPerson = (kind: QuestionBlockerKind) =>
  refuseQuestion(
    'QUESTION_OWED_BY_PERSON',
    `this question is blocked on ${kind === 'human' ? 'a person' : 'a machine fact'}, and this ` +
      'request carries an agent’s token: an agent’s token answers only a question blocked on ' +
      `another agent (blockerKind master_or_peer). The person who owes it answers it — with ${OWN_TOKEN}, ` +
      'signed in, or in the room it was delivered to.',
  );

/** A token handed to act for someone, or a box's: the word it carries is nobody's own. */
const notOwn = (kind: QuestionBlockerKind) =>
  refuseQuestion(
    'QUESTION_TOKEN_NOT_OWN',
    'this token was not minted by its holder to act as themselves — it is a box’s or a checkout’s, ' +
      'or one core handed to act for someone (a chat turn’s, an agreed proposal’s) — and an answer ' +
      `is the word of whoever owes it. Answer with ${OWN_TOKEN}, signed in, or in the room the ` +
      'question was delivered to' +
      (kind === 'master_or_peer'
        ? '; or, as the agent it is blocked on, with that agent’s OWN Agent Access Token, which an ' +
          'org admin mints at POST /api/orgs/:orgId/agents/:agentUserId/tokens.'
        : '.'),
  );

/**
 * Refuses a token's answer that is not its holder's word: an agent's token on a question no agent
 * owes, or a token its holder did not mint for themselves. A person's own token goes on to the
 * session's check in `answerAs`, whatever the question is blocked on.
 */
export async function assertTokenMayAnswer(token: {
  questionId: string;
  userId: string;
  agentUserId: string | null;
  tokenId: string;
}): Promise<void> {
  const seen = await readQuestionFor(token.questionId, token.agentUserId ?? token.userId);
  if (!seen) throw notFound('question not found');
  if (token.agentUserId) {
    if (seen.blockerKind === 'master_or_peer') return;
    throw owedByPerson(seen.blockerKind);
  }
  const { holdersOwn } = await tokenIdentityOf(token.tokenId);
  if (!holdersOwn) throw notOwn(seen.blockerKind);
}

type AnsweringToken = Parameters<typeof assertTokenMayAnswer>[0];

/** An answer a tool door takes on a token: refused here as REST's route refuses it, then `answerAs`. */
export async function answerWithToken(args: {
  token: AnsweringToken;
  body: AnswerBody;
  agency: ActorAgency;
}) {
  const { token } = args;
  await assertTokenMayAnswer(token);
  return answerAs({
    questionId: token.questionId,
    ...givenAnswerOf(args.body),
    userId: token.userId,
    agency: args.agency,
    via: await doorOfToken(token.tokenId),
  });
}
