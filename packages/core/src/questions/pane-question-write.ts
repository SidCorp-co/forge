/**
 * Writing what a pane asked onto the tracker, once.
 *
 * A report that reaches core twice leaves one question: the id is a function of the blocked job
 * and the question's place in its dialog.
 */

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { agentQuestions } from '../db/schema-questions.js';
import { type PaneQuestion, refusedPaneQuestion, rulesOf } from './pane-question.js';
import { insertAskedQuestion, QuestionRefused } from './write.js';

/** The same id for the same blocked job and place, in the shape of a name-based (v5) uuid. */
export function questionIdFor(jobId: string, index: number): string {
  const bytes = Buffer.from(
    createHash('sha1').update(`forge:blocked-question:${jobId}:${index}`).digest().subarray(0, 16),
  );
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Write one question at `issueId`, or at project level where that is null. A question the screen
 * refuses is written as one naming the rule; an issue that ended or moved projects under it makes
 * it a project-level question. Anything else is refused by name.
 */
export async function writePaneQuestion(
  tx: Tx,
  args: {
    id: string;
    projectId: string;
    issueId: string | null;
    pane: PaneQuestion;
    who: string;
  },
): Promise<void> {
  const [existing] = await tx
    .select({ id: agentQuestions.id })
    .from(agentQuestions)
    .where(eq(agentQuestions.id, args.id))
    .limit(1);
  if (existing) return;
  const ask = (at: string | null, question: PaneQuestion) =>
    insertAskedQuestion(tx, {
      id: args.id,
      projectId: args.projectId,
      ...(at ? { issueId: at } : {}),
      prompt: question.prompt,
      blockerKind: 'human',
      answer: question.answer,
    });
  try {
    await ask(args.issueId, args.pane);
  } catch (err) {
    if (!(err instanceof QuestionRefused)) throw err;
    if (err.code === 'QUESTION_MESSAGE_REFUSED') {
      await ask(args.issueId, refusedPaneQuestion(args.who, rulesOf(err.message)));
    } else if (err.code === 'QUESTION_ISSUE_TERMINAL' || err.code === 'QUESTION_ISSUE_ELSEWHERE') {
      await ask(null, args.pane);
    } else {
      throw err;
    }
  }
}
