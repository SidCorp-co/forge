/**
 * forge_requirements' answer action: a question standing on a requirement, answered through the
 * question door as the token's holder. It sits apart from the requirements tool because answering is
 * the question door's act, not a requirement read or write.
 */
import { MCP_DOOR } from '../lib/data-egress.js';
import type { McpContext } from '../lib/tool.js';
import { need, zodArgumentRefusal } from '../lib/tool-args.js';
import { ANSWER_SHAPE, answerBody, answerWithToken } from '../questions/index.js';
import { readRequirementAs } from '../requirements/index.js';

/** The answer action's line in forge_requirements' description. */
export const ANSWER_LINE = `answer {requirement, questionId, round, optionId | answer}: answer a question standing on the requirement (one get lists under questions), as POST /api/questions/:id/answer does — ${ANSWER_SHAPE}, the free answer passed here as answer. Answer only with what the person told you in this conversation, in their words; never answer on your own reading of the question, the spec or the code, and when they have not said, ask them. The answer is theirs, recorded with this token and this client: it answers a question a person owes, within what they could answer signed in; one blocked on another agent is refused QUESTION_BLOCKED_ON_AGENT. QUESTION_NOT_OPEN: it is already answered.`;

/** What the answer action reads from the tool's input. */
export type AnswerInput = {
  action: string;
  requirement?: string | undefined;
  questionId?: string | undefined;
  round?: number | undefined;
  optionId?: string | undefined;
  answer?: string | undefined;
};

/** A question standing on the requirement, answered as the token's holder; one standing elsewhere is not found here. */
export async function answerOnRequirement(
  ctx: McpContext,
  actor: Parameters<typeof readRequirementAs>[0],
  projectId: string,
  input: AnswerInput,
) {
  const { requirement: key, questionId } = need(input, input.action, 'requirement', 'questionId');
  const detail = await readRequirementAs(actor, projectId, key, MCP_DOOR);
  if (!detail.questions.some((q) => q.id === questionId)) {
    throw new Error(
      `NOT_FOUND: question ${questionId} does not stand on ${detail.key}; answer one get lists under questions, or answer this one with forge_questions`,
    );
  }
  const { principal } = ctx;
  const body = answerBody.safeParse({
    round: input.round,
    ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
    ...(input.answer === undefined ? {} : { text: input.answer }),
  });
  if (!body.success) throw zodArgumentRefusal(body.error, { text: 'answer' });
  return answerWithToken({
    token: {
      questionId,
      userId: principal.userId,
      agentUserId: principal.agentUserId ?? null,
      tokenId: principal.tokenId,
    },
    body: body.data,
    agency: actor.agency,
  });
}
