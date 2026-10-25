/**
 * The value check as kept on an item's intake draft (REQ-65 BC-1..BC-5): how it stands, which of the
 * standing draft's questions hold it, and the answers given to them. A question holds the check while
 * it blocks and nobody has answered it; once none does, the check is drafted again with the answers
 * (`service.ts`).
 */

import type { IntakeQuestion } from '@forge/contracts/intake-drafts';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { db } from '../db/client.js';
import {
  type IntakeAnswerRow,
  type IntakeDraftRow,
  intakeAnswers,
  intakeDrafts,
  type ValueCheckState,
} from '../db/schema-intake.js';
import type { JudgedValue } from './value-rules.js';

type Reader = Pick<Tx, 'select'>;

/** How a judged check stands: its outcome, or `held` while a question holds it. */
export const valueStateOf = (value: JudgedValue): ValueCheckState => value.outcome?.kind ?? 'held';

/** The standing draft's questions, as kept. */
export const questionsOf = (row: Pick<IntakeDraftRow, 'body'>): IntakeQuestion[] =>
  ((row.body ?? null) as { questions?: IntakeQuestion[] } | null)?.questions ?? [];

/** The answers given to the standing draft's own questions, by number. */
export async function answersOf(
  exec: Reader,
  row: Pick<IntakeDraftRow, 'id' | 'draftedAt'>,
): Promise<Map<number, IntakeAnswerRow>> {
  const rows = await exec
    .select()
    .from(intakeAnswers)
    .where(and(eq(intakeAnswers.draftId, row.id), eq(intakeAnswers.askedAt, row.draftedAt)));
  return new Map(rows.map((a) => [a.question, a]));
}

/** The standing draft's blocking questions nobody has answered, by their words. */
export function heldBy(
  questions: readonly IntakeQuestion[],
  answers: ReadonlyMap<number, unknown>,
): string[] {
  return questions.flatMap((q, i) => (q.blocks !== null && !answers.has(i + 1) ? [q.prompt] : []));
}

/** requirements' `valueCheckHeld` port: the questions holding the requirement's value check. */
export async function valueCheckHeld(tx: Tx, requirementId: string): Promise<string[]> {
  const [row] = await tx
    .select()
    .from(intakeDrafts)
    .where(eq(intakeDrafts.requirementId, requirementId))
    .limit(1);
  if (row?.valueOutcome !== 'held') return [];
  return heldBy(questionsOf(row), await answersOf(tx, row));
}

/** The draft standing for an item, if any. */
export async function draftRowOf(
  kind: 'requirement' | 'feedback',
  id: string,
  exec: Reader = db,
): Promise<IntakeDraftRow | null> {
  const [row] = await exec
    .select()
    .from(intakeDrafts)
    .where(
      kind === 'requirement' ? eq(intakeDrafts.requirementId, id) : eq(intakeDrafts.feedbackId, id),
    )
    .limit(1);
  return row ?? null;
}
