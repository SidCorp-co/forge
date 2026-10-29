/**
 * What a person does with an item's value check (REQ-65 BC-3, BC-6): answers one of its draft's
 * questions with one of the options offered, and keeps a refused requirement with a one-line reason.
 * An answer to the last question holding the check has it drafted again with the answers
 * (`intake.answered`); an answer to any other question replaces, in the same act, every fact of the
 * check that took that question's recommended answer, which then names the answer as its source.
 * A keep moves the requirement back to draft through the requirement machine and is kept on its draft.
 */

import type {
  IntakeAnswerRequest,
  IntakeDraftView,
  IntakeKeepRequest,
  ValueCheckView,
  ValueFactView,
} from '@forge/contracts/intake-drafts';
import type { ActorAgency } from '@forge/contracts/permissions';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { intakeAnswers, intakeDrafts } from '../db/schema-intake.js';
import { lockXact } from '../lib/advisory-lock.js';
import { dataPolicyOf, storedText } from '../lib/data-egress.js';
import type { Refusal } from '../lib/refusal.js';
import { emitEvent } from '../outbox/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { keepRefusedIn } from '../requirements/index.js';
import { intakeItemIn, mayAnswer, readIntakeDraft } from './read.js';
import { answersOf, draftRowOf, heldBy, questionsOf } from './value.js';

type Actor = { userId: string; agency: ActorAgency };
export type IntakeActOutcome =
  | { ok: true; draft: IntakeDraftView | null }
  | { ok: false; refusals: Refusal[] };

const refusal = (code: string, path: string, detail: string): IntakeActOutcome => ({
  ok: false,
  refusals: [{ code, path, detail }],
});

type StoredValue = Omit<ValueCheckView, 'kept'>;
const VALUE_FACTS = ['who', 'improves', 'measured'] as const;

/**
 * `value` with every fact that stood on question `question`, its recommended answer or an earlier
 * answer, rewritten as `label` sourced to the answer; null where no fact stood on it (REQ-65 BC-5).
 */
export function answeredValue(
  value: StoredValue | null,
  question: number,
  label: string,
): StoredValue | null {
  if (!value) return null;
  const stood = (f: ValueFactView | null) =>
    f !== null &&
    (f.source.kind === 'recommended' || f.source.kind === 'answer') &&
    f.source.question === question;
  if (!VALUE_FACTS.some((name) => stood(value[name]))) return null;
  const answered = { value: label, source: { kind: 'answer' as const, question } };
  return {
    ...value,
    ...Object.fromEntries(
      VALUE_FACTS.filter((name) => stood(value[name])).map((name) => [name, answered]),
    ),
  };
}

/** Answers question `question` of the item's standing draft with `option`. */
export async function answerIntakeQuestion(input: {
  projectId: string;
  ref: string;
  actor: Actor;
  body: IntakeAnswerRequest;
}): Promise<IntakeActOutcome> {
  const { projectId, actor, body } = input;
  await requireCan(actorFor(actor.userId), 'project.read', projectResource(projectId));
  const found = await intakeItemIn(projectId, input.ref);
  if (!found.ok) return found;
  const { item } = found;
  if (!(await mayAnswer(projectId, item, actor.userId))) {
    await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  }
  const refused = await db.transaction(async (tx): Promise<IntakeActOutcome | null> => {
    await lockXact(tx, 'intakeDrafts', item.id);
    const row = await draftRowOf(item.kind, item.id, tx);
    if (row?.outcome !== 'drafted') {
      return refusal(
        'INTAKE_NOT_DRAFTED',
        '/ref',
        `${item.key} has no draft standing to answer${row ? ': its last draft failed' : ' yet'}`,
      );
    }
    const questions = questionsOf(row);
    const q = questions[body.question - 1];
    if (!q) {
      return refusal(
        'INTAKE_QUESTION_UNKNOWN',
        '/question',
        `${item.key}'s draft asks ${questions.length} question${questions.length === 1 ? '' : 's'}: question ${body.question} is none of them`,
      );
    }
    const option = q.options.find((o) => o.id === body.option);
    if (!option) {
      return refusal(
        'INTAKE_QUESTION_UNKNOWN',
        '/option',
        `question ${body.question} offers ${q.options.map((o) => o.id).join(', ')}, not "${body.option}"`,
      );
    }
    const at = new Date();
    await tx
      .insert(intakeAnswers)
      .values({
        draftId: row.id,
        askedAt: row.draftedAt,
        question: body.question,
        prompt: q.prompt,
        optionId: option.id,
        label: option.label,
        answeredBy: actor.userId,
        answeredAt: at,
      })
      .onConflictDoUpdate({
        target: [intakeAnswers.draftId, intakeAnswers.askedAt, intakeAnswers.question],
        set: { optionId: option.id, label: option.label, answeredBy: actor.userId, answeredAt: at },
      });
    // the answer replaces the recommended answer a fact of the check took from this question
    const value = answeredValue(row.value as StoredValue | null, body.question, option.label);
    if (value) await tx.update(intakeDrafts).set({ value }).where(eq(intakeDrafts.id, row.id));
    // the last question holding the check answered: the assistant drafts it again with the answers
    if (row.valueOutcome === 'held' && heldBy(questions, await answersOf(tx, row)).length === 0) {
      await emitEvent(tx, 'intake.answered', {
        projectId,
        kind: item.kind,
        itemId: item.id,
        key: item.key,
      });
    }
    return null;
  });
  if (refused) return refused;
  return readIntakeDraft({ projectId, ref: item.key, viewer: actor });
}

/** Keeps a requirement its value check refused, with the person's one-line reason (REQ-65 BC-6). */
export async function keepRefusedRequest(input: {
  projectId: string;
  ref: string;
  actor: Actor;
  body: IntakeKeepRequest;
}): Promise<IntakeActOutcome> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.read', projectResource(projectId));
  const found = await intakeItemIn(projectId, input.ref);
  if (!found.ok) return found;
  const { item } = found;
  if (item.kind !== 'requirement') {
    return refusal(
      'INTAKE_REF_INVALID',
      '/ref',
      `${item.key} is a feedback item, which its triage declines or routes: only a refused requirement is kept`,
    );
  }
  const reason = storedText(await dataPolicyOf(projectId), input.body.reason).text;
  const refused = await db.transaction(async (tx): Promise<IntakeActOutcome | null> => {
    const out = await keepRefusedIn(tx, {
      projectId,
      requirementId: item.id,
      actor,
      reason,
    });
    if (!out.moved) {
      return refusal(
        'VALUE_CHECK_NOT_REFUSED',
        '/ref',
        `${item.key} is ${out.status}: only a requirement its value check refused is kept`,
      );
    }
    await tx
      .update(intakeDrafts)
      .set({ keptReason: reason, keptBy: actor.userId, keptAt: new Date() })
      .where(eq(intakeDrafts.requirementId, item.id));
    return null;
  });
  if (refused) return refused;
  return readIntakeDraft({ projectId, ref: item.key, viewer: actor });
}
