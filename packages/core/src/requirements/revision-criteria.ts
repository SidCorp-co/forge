/**
 * A revision's criteria as rows, inside a caller's transaction under the project's requirement lock:
 * written for a revision, judged where a list is proposed, and reset when a draft is rewritten.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { type CriterionForm, requirementCriteria } from '../db/schema-requirements.js';
import { retieTracedCriteria } from '../issues/index.js';
import {
  type CriterionInput,
  type LiveCriterion,
  liveAt,
  planCriteria,
  type RequirementRefusal,
} from './rules.js';

/** Applies a revision's criteria list as rows; refusals when a code is unknown or a scenario
 *  unparseable. `ownCodes` are what a draft being rewritten held before its reset. */
export async function writeCriteria(
  tx: Tx,
  requirementId: string,
  revision: number,
  input: readonly CriterionInput[],
  ownCodes: ReadonlySet<string> = new Set(),
): Promise<RequirementRefusal[] | null> {
  const all = await tx
    .select()
    .from(requirementCriteria)
    .where(eq(requirementCriteria.requirementId, requirementId));
  const live: LiveCriterion[] = all
    .filter((c) => c.retiredRevision === null)
    .map((c) => ({
      id: c.id,
      code: c.code,
      body: c.body,
      form: c.form as CriterionForm,
      title: c.title,
    }));
  const highest = all.reduce((m, c) => Math.max(m, Number(c.code.slice(3))), 0);
  const planned = planCriteria(input, live, highest, ownCodes);
  if (!planned.ok) return planned.refusals;
  const { retire, insert } = planned.plan;
  if (retire.length) {
    await tx
      .update(requirementCriteria)
      .set({ retiredRevision: revision })
      .where(inArray(requirementCriteria.id, retire));
  }
  if (insert.length) {
    const written = await tx
      .insert(requirementCriteria)
      .values(insert.map((c) => ({ ...c, requirementId, sinceRevision: revision })))
      .returning({ id: requirementCriteria.id, code: requirementCriteria.code });
    await retieUnchanged(tx, live, retire, insert, written);
  }
  return null;
}

/**
 * Owner 2026-11-08 (D4): a criterion retired only for its title (its body and form carried as they
 * were) is the same rule, so the issue criteria tracing the retired wording are tied to the new one
 * in the same write, and no re-plan or re-tie is asked of anyone. A criterion whose body or form
 * changed is left traced to its old wording, which owes the re-plan it always did.
 */
async function retieUnchanged(
  tx: Tx,
  live: readonly LiveCriterion[],
  retired: readonly string[],
  inserted: readonly { code: string; body: string; form: CriterionForm }[],
  written: readonly { id: string; code: string }[],
): Promise<void> {
  const newId = new Map(written.map((w) => [w.code, w.id]));
  for (const old of live.filter((c) => retired.includes(c.id))) {
    const same = inserted.find(
      (c) => c.code === old.code && c.body === old.body && c.form === old.form,
    );
    const to = same ? newId.get(same.code) : undefined;
    if (to) await retieTracedCriteria(tx, old.id, to);
  }
}

/**
 * What `writeCriteria` would refuse in a criteria list proposed on `baseRevision`, said where the
 * list is proposed rather than at the accept: a revision_diff suggestion naming a code that is not
 * live on its base is refused at its creation, so the turn that wrote it can correct it in the same
 * turn (REQ-30 BC-3; forge-dev 2026-10-08, REQ-32 and REQ-33, refused only at a person's Accept).
 * Nothing is written.
 */
export async function criteriaRefusalsAt(
  tx: Tx,
  requirementId: string,
  baseRevision: number | null,
  input: readonly CriterionInput[],
): Promise<RequirementRefusal[]> {
  const all = await tx
    .select()
    .from(requirementCriteria)
    .where(eq(requirementCriteria.requirementId, requirementId));
  const live: LiveCriterion[] = (baseRevision === null ? [] : liveAt(all, baseRevision)).map(
    (c) => ({
      id: c.id,
      code: c.code,
      body: c.body,
      form: c.form as CriterionForm,
      title: c.title,
    }),
  );
  const highest = all.reduce((m, c) => Math.max(m, Number(c.code.slice(3))), 0);
  const planned = planCriteria(input, live, highest);
  return planned.ok ? [] : planned.refusals;
}

/** Undoes what an earlier write of draft `revision` did to the criteria, so an edit re-applies
 *  whole; answers the codes that write gave, which the rewrite may name again. */
export async function resetDraftCriteria(
  tx: Tx,
  requirementId: string,
  revision: number,
): Promise<Set<string>> {
  const removed = await tx
    .delete(requirementCriteria)
    .where(
      and(
        eq(requirementCriteria.requirementId, requirementId),
        eq(requirementCriteria.sinceRevision, revision),
      ),
    )
    .returning({ code: requirementCriteria.code });
  await tx
    .update(requirementCriteria)
    .set({ retiredRevision: null })
    .where(
      and(
        eq(requirementCriteria.requirementId, requirementId),
        eq(requirementCriteria.retiredRevision, revision),
      ),
    );
  return new Set(removed.map((r) => r.code));
}
