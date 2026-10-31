// Who may answer a question with a token, read by every door that takes one: REST's answer route and
// the MCP door's `forge_questions answer` and `forge_requirements answer`, so a token is refused the
// same question at each.
//
// A person's own token answers a question a person owes, within what its holder could answer signed
// in (owner, 2026-10-16, on the ground of ADR 0007: whoever holds the permission acts). A question
// blocked on an agent or a peer keeps the agent-token rule (ISS-1003): only an agent's token answers
// it, its own or the box's it runs on. An agent's token answers any question, recording why, except
// one that is a person's: serious, on a strict project (REQ-79 BC-14, `owed.ts`). This door says
// whose word the token carries and whether that word is one the question takes; whether its holder
// may answer it is `answerAs`'s, the check a session's answer meets — the project role and the
// chosen option's authority — never a second copy of it here.

import type { ActorAgency } from '@forge/contracts/permissions';
import { tokenIdentityOf } from '../credentials/token-identity.js';
import { notFound } from '../middleware/route-errors.js';
import { type AnswerBody, givenAnswerOf } from './answer-input.js';
import { agentDecidesWhy, SERIOUS } from './owed.js';
import { doorOfToken } from './ports.js';
import { answerAs, readQuestionFor } from './read.js';
import { refuseQuestion } from './write.js';

const OWN_TOKEN =
  'their own personal access token, or the MCP client they signed in to Forge with (Claude Code ' +
  'and the like)';

/** An agent's token on a question that is a person's: serious, on a strict project (REQ-79 BC-13). */
const owedByPerson = () =>
  refuseQuestion(
    'QUESTION_OWED_BY_PERSON',
    `this question is marked serious (${SERIOUS}) on a strict project, so it is a person’s, and ` +
      'this request carries an agent’s token. The person who owes it answers it — with ' +
      `${OWN_TOKEN}, signed in, or in the room it was delivered to.`,
  );

/** An agent's answer to a question a person was asked, with no reason: its decision is recorded with why. */
const reasonRequired = (why: string) =>
  refuseQuestion(
    'QUESTION_AGENT_REASON_REQUIRED',
    `this question was asked of a person, and an agent’s token answers it here because ${why}; ` +
      'the answer is the agent’s decision, recorded with its reason: send `note` saying why ' +
      '(REST `POST /api/questions/:id/answer` and `forge_questions answer` take it).',
    '/note',
  );

/** A token that names no agent, on a question an agent owes (ISS-1003: an agent answers another agent). */
const blockedOnAgent = () =>
  refuseQuestion(
    'QUESTION_BLOCKED_ON_AGENT',
    'this question is blocked on another agent (blockerKind master_or_peer), and this request ' +
      'carries a token that names no agent. An agent-blocked question is answered by an agent’s ' +
      'token: its OWN Agent Access Token, which an org admin mints at ' +
      'POST /api/orgs/:orgId/agents/:agentUserId/tokens, or the token of the box it runs on.',
  );

/** A token handed to act for someone, or a checkout's: the word it carries is nobody's own. */
const notOwn = () =>
  refuseQuestion(
    'QUESTION_TOKEN_NOT_OWN',
    'this token was not minted by its holder to act as themselves — it is a box’s or a checkout’s, ' +
      'or one core handed to act for someone (a chat turn’s, an agreed proposal’s) — and an answer ' +
      `is the word of whoever owes it. Answer with ${OWN_TOKEN}, signed in, or in the room the ` +
      'question was delivered to.',
  );

/**
 * Refuses a token's answer that is not a word the question takes: an agent's token on a question
 * that is a person's, or on one a person was asked without its reason; any other token on a question
 * an agent owes; or a token its holder did not mint for themselves. A person's own token on a
 * person's question, and an agent's answer the question takes, go on to the session's check in
 * `answerAs`. An agent's token is an agent account's own or a paired box's (agency `agent`).
 */
export async function assertTokenMayAnswer(token: {
  questionId: string;
  userId: string;
  agentUserId: string | null;
  tokenId: string;
  agency: ActorAgency;
  /** The answer's note, which an agent's answer to a person's question owes as its reason. */
  note?: string | undefined;
}): Promise<void> {
  const seen = await readQuestionFor(token.questionId, token.agentUserId ?? token.userId);
  if (!seen) throw notFound('question not found');
  if (token.agentUserId || token.agency === 'agent') {
    if (seen.blockerKind === 'master_or_peer') return;
    const why = await agentDecidesWhy(seen.projectId as string, seen.serious);
    if (why === null) throw owedByPerson();
    if (!token.note?.trim()) throw reasonRequired(why);
    return;
  }
  if (seen.blockerKind === 'master_or_peer') throw blockedOnAgent();
  const { holdersOwn } = await tokenIdentityOf(token.tokenId);
  if (!holdersOwn) throw notOwn();
}

type AnsweringToken = Omit<Parameters<typeof assertTokenMayAnswer>[0], 'agency' | 'note'>;

/** An answer a tool door takes on a token: refused here as REST's route refuses it, then `answerAs`. */
export async function answerWithToken(args: {
  token: AnsweringToken;
  body: AnswerBody;
  agency: ActorAgency;
}) {
  const { token } = args;
  await assertTokenMayAnswer({ ...token, agency: args.agency, note: args.body.note });
  return answerAs({
    questionId: token.questionId,
    ...givenAnswerOf(args.body),
    userId: token.userId,
    agency: args.agency,
    via: await doorOfToken(token.tokenId),
  });
}
