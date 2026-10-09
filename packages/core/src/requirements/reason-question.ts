/**
 * A requirement's reason is asked, never required (REQ-34 BC-17; Requirement lifecycle r15 start:
 * "its reason is asked, never required (REVISION_REASON_REQUIRED retired)"). A create written without
 * a reason asks its author one question on the requirement. The question is listed among revision 1's
 * open questions, never blocking, so the ready checklist does not wait on it. Its answer becomes that
 * revision's reason: written once into the null the create left (the revision guard lets a null
 * reason be filled once and freezes it after, migration 0493), at the project's data policy.
 */

import { randomUUID } from 'node:crypto';
import type { RequirementOpenQuestion } from '@forge/contracts/requirements';
import { and, eq, isNull } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { agentQuestions } from '../db/schema-questions.js';
import { requirementRevisions } from '../db/schema-requirements.js';
import { dataPolicyOf, storedText } from '../lib/data-egress.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { insertAskedQuestion } from '../questions/index.js';

/** The mark on the question's `assumed`: which revision's reason its answer is. */
const REASON_FOR = 'reasonFor';

interface ReasonFor {
  requirementId: string;
  revision: number;
}

const reasonForOf = (assumed: Record<string, unknown> | null): ReasonFor | null => {
  const v = assumed?.[REASON_FOR] as Partial<ReasonFor> | undefined;
  return typeof v?.requirementId === 'string' && typeof v.revision === 'number'
    ? { requirementId: v.requirementId, revision: v.revision }
    : null;
};

/** Asks the author of `key`'s revision why it was written, and answers the open question it lists. */
export async function askReasonIn(
  tx: Tx,
  input: { projectId: string; requirementId: string; key: string; title: string; revision: number },
): Promise<RequirementOpenQuestion> {
  const question = `Why is ${input.key} needed?`;
  const asked = await insertAskedQuestion(tx, {
    id: randomUUID(),
    projectId: input.projectId,
    requirementId: input.requirementId,
    prompt: `${question} It was created without a reason.`,
    blockerKind: 'human',
    answer: {
      shape: 'free_text',
      needed: `Why ${input.key} was written: the problem it solves`,
      recommended: input.title,
    },
    assumed: { [REASON_FOR]: { requirementId: input.requirementId, revision: input.revision } },
  });
  return { question, whoAnswers: 'its author', blocking: false, questionId: asked.id };
}

/**
 * Writes an answered reason question's text as its revision's reason, where the revision holds none
 * yet. Answers what it did, so a test reads it and the log says it.
 */
export async function landReasonAnswer(
  questionId: string,
): Promise<'written' | 'not_a_reason_question' | 'already_given'> {
  const [row] = await db
    .select({
      projectId: agentQuestions.projectId,
      assumed: agentQuestions.assumed,
      steps: agentQuestions.steps,
      status: agentQuestions.status,
    })
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
    .limit(1);
  const target = row ? reasonForOf(row.assumed as Record<string, unknown> | null) : null;
  const step = row?.steps.at(-1);
  if (!row || !target || row.status !== 'answered' || !step || step.answerShape !== 'free_text') {
    return 'not_a_reason_question';
  }
  const text = step.answerText?.trim();
  if (!text) {
    throw new Error(
      `requirement-reason: question ${questionId} reads answered with no answer text, so revision ${target.revision}'s reason cannot be written`,
    );
  }
  const reason = storedText(await dataPolicyOf(row.projectId), text).text;
  const written = await db
    .update(requirementRevisions)
    .set({ reason })
    .where(
      and(
        eq(requirementRevisions.requirementId, target.requirementId),
        eq(requirementRevisions.revision, target.revision),
        isNull(requirementRevisions.reason),
      ),
    )
    .returning({ revision: requirementRevisions.revision });
  return written.length > 0 ? 'written' : 'already_given';
}

export function registerReasonAnswers(): void {
  consume('question.answered', {
    name: 'requirement-reason',
    handle: async (p) => {
      const out = await landReasonAnswer(p.questionId);
      if (out === 'already_given') {
        logger.info(
          { question: p.questionId },
          'requirement-reason: the revision already holds a reason, so the answer stays on its question',
        );
      }
    },
  });
}
