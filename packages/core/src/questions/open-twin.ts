// A question asked again, word for word, while the first is still open on the same subject is
// refused by name, naming the open one (ISS-918). REQ-77 on forge-dev held two pairs of identical
// open questions asked 22 s apart, and a person read each twice. Refused rather than answered with
// the open question: the asker learns its ask already stands and where, and nothing is written; a
// retry after a lost answer reads the open question by the id the refusal names.

import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { agentQuestions, type QuestionStep } from '../db/schema-questions.js';

interface Subject {
  projectId: string;
  issueId?: string | undefined;
  requirementId?: string | undefined;
  feedbackId?: string | undefined;
}

/** The id of a question still open on this subject whose first round asks the same thing; null where none. */
export async function openTwinOf(
  executor: Pick<Tx, 'select'>,
  input: Subject,
  about: unknown,
  first: QuestionStep,
): Promise<string | null> {
  const subject = input.issueId ?? input.requirementId ?? input.feedbackId ?? about ?? null;
  if (subject === null) return null;
  const options = 'options' in first ? first.options : null;
  const needed = 'needed' in first ? first.needed : null;
  const [twin] = await executor
    .select({ id: agentQuestions.id })
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.projectId, input.projectId),
        eq(agentQuestions.status, 'open'),
        sql`${agentQuestions.issueId} IS NOT DISTINCT FROM ${input.issueId ?? null}::uuid`,
        sql`${agentQuestions.requirementId} IS NOT DISTINCT FROM ${input.requirementId ?? null}::uuid`,
        sql`${agentQuestions.feedbackId} IS NOT DISTINCT FROM ${input.feedbackId ?? null}::uuid`,
        sql`${agentQuestions.about} IS NOT DISTINCT FROM ${about === undefined || about === null ? null : JSON.stringify(about)}::jsonb`,
        sql`${agentQuestions.steps} -> 0 ->> 'prompt' = ${first.prompt}`,
        sql`${agentQuestions.steps} -> 0 -> 'options' IS NOT DISTINCT FROM ${options === null ? null : JSON.stringify(options)}::jsonb`,
        sql`${agentQuestions.steps} -> 0 ->> 'needed' IS NOT DISTINCT FROM ${needed}`,
      ),
    )
    .limit(1);
  return twin?.id ?? null;
}
