/**
 * Writing what a pane asked onto the tracker, once.
 *
 * A report that reaches core twice leaves one question: the id (`pane-question-id.ts`) is a function
 * of the blocked job and the question's place in its dialog.
 */

import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { agentQuestions } from '../db/schema-questions.js';
import { type PaneQuestion, refusedPaneQuestion, rulesOf } from './pane-question.js';
import { insertAskedQuestion, QuestionRefused } from './write.js';

/**
 * Write one question at `issueId`, or at project level where that is null, and answer where it
 * stands. A question the screen refuses is written as one naming the rule; an issue that ended or
 * moved projects under it makes it a project-level question. Anything else is refused by name.
 */
export async function writePaneQuestion(
  tx: Tx,
  args: {
    id: string;
    projectId: string;
    issueId: string | null;
    pane: PaneQuestion;
    who: string;
    /** The session that stopped on it, so a reader can name the job that asked and its issue. */
    agentSessionId?: string | null;
  },
): Promise<string | null> {
  const [existing] = await tx
    .select({ issueId: agentQuestions.issueId })
    .from(agentQuestions)
    .where(eq(agentQuestions.id, args.id))
    .limit(1);
  if (existing) return existing.issueId;
  const ask = (at: string | null, question: PaneQuestion) =>
    insertAskedQuestion(tx, {
      id: args.id,
      projectId: args.projectId,
      ...(at ? { issueId: at } : {}),
      ...(args.agentSessionId ? { agentSessionId: args.agentSessionId } : {}),
      prompt: question.prompt,
      blockerKind: 'human',
      answer: question.answer,
    });
  try {
    await ask(args.issueId, args.pane);
    return args.issueId;
  } catch (err) {
    if (!(err instanceof QuestionRefused)) throw err;
    if (err.code === 'QUESTION_MESSAGE_REFUSED') {
      await ask(args.issueId, refusedPaneQuestion(args.who, rulesOf(err.message)));
      return args.issueId;
    }
    if (err.code === 'QUESTION_ISSUE_TERMINAL' || err.code === 'QUESTION_ISSUE_ELSEWHERE') {
      await ask(null, args.pane);
      return null;
    }
    throw err;
  }
}
