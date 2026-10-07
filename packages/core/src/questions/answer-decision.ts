// The decision a business answer leaves on its requirement (JU-6): a question asked of a requirement,
// or named as about one, is answered in the answer's transaction and the answer is recorded there as
// a decision, so a point settled on a build issue is not only in that issue's thread.

import { recordRequirementDecisionIn } from '../comments/index.js';
import type { Tx } from '../db/client.js';
import type { agentQuestions, QuestionStep } from '../db/schema-questions.js';
import { issueDisplayIds } from '../issues/index.js';
import { answeredBody } from './write.js';

type QuestionRow = typeof agentQuestions.$inferSelect;

/** The requirement a question is asked of or named as about; null when it names none. */
function requirementOfQuestion(row: QuestionRow): string | null {
  if (row.requirementId) return row.requirementId;
  return row.about?.kind === 'requirement' ? row.about.requirementId : null;
}

/**
 * An answer to a question on a requirement reaches it as a decision, in the answer's transaction,
 * so a business point settled on a build issue is on the requirement's record and not only in the
 * issue's thread (JU-6).
 */
export async function recordOnRequirement(
  tx: Tx,
  row: QuestionRow,
  answered: QuestionStep,
  args: { by: string; agency: 'human' | 'agent' },
): Promise<void> {
  const requirementId = requirementOfQuestion(row);
  const said = answeredBody(answered).trim();
  if (!requirementId || !said) return;
  const where = row.issueId
    ? ` on ${(await issueDisplayIds([row.issueId], tx)).get(row.issueId) ?? row.issueId}`
    : '';
  await recordRequirementDecisionIn(tx, {
    projectId: row.projectId,
    requirementId,
    authorId: args.by,
    agency: args.agency,
    decision: {
      decision: said,
      reason: `The answer to the question asked${where}: ${answered.prompt}`,
    },
  });
}
