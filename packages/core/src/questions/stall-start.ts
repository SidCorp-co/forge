// The unclear-item stall a question starts (REQ-67 BC-6), in the transaction that writes it: a
// question the ask door names as about a requirement or a feedback item (REQ-67 BC-5), or a
// reporter's clarification on a feedback item. A steward's decision about an item is triage, not a
// stall, and names its item in-process (`{ feedbackId }`) or by the `requirementId` link; neither
// starts one. Its answer, void or delete ends it (`stalls_question_end_trg`, migration 0589).

import type { QuestionAbout } from '@forge/contracts/questions';
import type { Tx } from '../db/client.js';
import { startStall } from '../issues/index.js';

export interface StallingAsk {
  projectId: string;
  issueId?: string | null | undefined;
  feedbackId?: string | null | undefined;
  /** The ask as sent: an in-process `{ feedbackId }` is a steward's decision, never a stall. */
  about?: unknown;
}

/** The item a question stalls delivery on, or null where it names none a stall stands on. */
export function stalledItemOf(
  input: StallingAsk,
  about: QuestionAbout | undefined,
): { requirementId: string } | { feedbackId: string } | null {
  const inProcess =
    typeof input.about === 'object' && input.about !== null && 'feedbackId' in input.about;
  if (about?.kind === 'requirement') return { requirementId: about.requirementId };
  if (about?.kind === 'feedback' && !inProcess) return { feedbackId: about.feedbackId };
  if (input.feedbackId) return { feedbackId: input.feedbackId };
  return null;
}

export async function startQuestionStall(
  tx: Tx,
  input: StallingAsk,
  about: QuestionAbout | undefined,
  question: { id: string; text: string },
): Promise<void> {
  const item = stalledItemOf(input, about);
  if (!item) return;
  await startStall(tx, {
    projectId: input.projectId,
    cause: 'unclear_item',
    ...item,
    issueId: input.issueId ?? null,
    question,
  });
}
