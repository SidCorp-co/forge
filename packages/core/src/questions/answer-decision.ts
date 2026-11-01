// The decision a business answer leaves on its requirement (JU-6): a question asked of a requirement,
// or named as about one, is answered in the answer's transaction and the answer is recorded there as
// a decision, so a point settled on a build issue is not only in that issue's thread.

import { recordFeedbackDecisionIn, recordRequirementDecisionIn } from '../comments/index.js';
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
 * The feedback item a delivery run's question is about (REQ-67 BC-5); a steward decision about a
 * feedback item records its own act, never this, so its fixed options are left out.
 */
function feedbackOfQuestion(row: QuestionRow): string | null {
  if (row.about?.kind !== 'feedback') return null;
  const last = row.steps.at(-1);
  const options = last && 'options' in last ? last.options : [];
  if (options.some((o) => o.fingerprint?.startsWith('steward:'))) return null;
  return row.about.feedbackId;
}

/**
 * An answer to a question on a requirement, or about a feedback item, reaches it as a decision, in the answer's transaction,
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
  const feedbackId = feedbackOfQuestion(row);
  const said = answeredBody(answered).trim();
  if ((!requirementId && !feedbackId) || !said) return;
  const where = row.issueId
    ? ` on ${(await issueDisplayIds([row.issueId], tx)).get(row.issueId) ?? row.issueId}`
    : '';
  const recorded = {
    projectId: row.projectId,
    authorId: args.by,
    agency: args.agency,
    decision: {
      decision: said,
      reason: `The answer to the question asked${where}: ${answered.prompt}`,
    },
  };
  if (requirementId) await recordRequirementDecisionIn(tx, { ...recorded, requirementId });
  else if (feedbackId) await recordFeedbackDecisionIn(tx, { ...recorded, feedbackId });
}
