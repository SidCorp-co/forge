// Every question about one feedback item, read on that item (REQ-33 BC-8): the clarifications asked of
// its reporter (`feedback_id`) and the steward's questions about it (`about.kind = 'feedback'`), open
// and answered, newest first. There is no Questions page; one waiting on the viewer is also in Approvals.

import type { FeedbackQuestionView } from '@forge/contracts/feedback';
import { desc, eq, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { agentQuestions, chosenOptionIdOf, isChoiceStep } from '../db/schema-questions.js';

export async function questionsOnFeedback(conn: Tx, feedbackId: string) {
  const rows = await conn
    .select({
      id: agentQuestions.id,
      status: agentQuestions.status,
      steps: agentQuestions.steps,
      feedbackId: agentQuestions.feedbackId,
      createdAt: agentQuestions.createdAt,
    })
    .from(agentQuestions)
    .where(
      or(
        eq(agentQuestions.feedbackId, feedbackId),
        sql`${agentQuestions.about}->>'kind' = 'feedback' AND ${agentQuestions.about}->>'feedbackId' = ${feedbackId}`,
      ),
    )
    .orderBy(desc(agentQuestions.createdAt));
  return rows.map((r) => ({ ...r, clarification: r.feedbackId === feedbackId }));
}

type Asked = Awaited<ReturnType<typeof questionsOnFeedback>>[number];

/** What the last round asked and what came back: the words written, or the option chosen by its label. */
function answerOf(step: Asked['steps'][number] | undefined): string | null {
  if (!step) return null;
  if (isChoiceStep(step)) {
    const chosen = chosenOptionIdOf(step);
    return chosen ? (step.options.find((o) => o.id === chosen)?.label ?? null) : null;
  }
  return step.answerText ?? null;
}

/** The item's questions as its page shows them; a withheld item keeps each question's state and drops its words. */
export function questionViewsOf(rows: readonly Asked[], withhold: boolean): FeedbackQuestionView[] {
  return rows.map((r) => {
    const step = r.steps.at(-1);
    return {
      id: r.id,
      kind: r.clarification ? 'clarification' : 'steward',
      status: r.status,
      prompt: withhold ? null : (step?.prompt ?? null),
      answer: withhold ? null : answerOf(step),
      askedAt: r.createdAt.toISOString(),
      answeredAt: step?.answeredAt ?? null,
    };
  });
}
