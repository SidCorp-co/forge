/**
 * The requirement writes that run inside a caller's transaction, under the project's requirement
 * lock: a revision's criteria as rows, REQ-n at revision 1, and a new draft revision on the head.
 * `service.ts` composes them into its own transactions; an accepted suggestion composes them into
 * the transaction that marks it accepted (ISS-58).
 */

import type { SensitiveDataLevel } from '@forge/contracts/data-policy';
import type { RequirementSpec } from '@forge/contracts/requirements';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import {
  type CriterionForm,
  type RevisionState,
  requirementCriteria,
  requirementRevisions,
  requirements,
  requirementWorkflows,
} from '../db/schema-requirements.js';
import { dataPolicyOf, storedDeep, storedText } from '../lib/data-egress.js';
import type { RequirementActor } from './read.js';
import {
  type CriterionInput,
  type LiveCriterion,
  openRevisionRefusal,
  planCriteria,
  type RequirementRefusal,
  staleBaseRefusal,
} from './rules.js';

export interface RevisionWrite {
  reason: string;
  spec?: RequirementSpec | undefined;
  tldr?: string | null | undefined;
  changeSummary?: string | null | undefined;
  criteria: CriterionInput[];
  /** The accepted suggestion this revision is the effect of (suggestion-lifecycle step accepted). */
  fromSuggestionId?: string | undefined;
}

export const specOf = (spec: RequirementSpec | undefined) => spec ?? {};

/** A revision's text as it is stored at the project's data policy: scrubbed on write at redact and
 *  no_egress, the way comments and issues are (personal-data-flow#ds-issues). */
export function storedWrite(level: SensitiveDataLevel, write: RevisionWrite): RevisionWrite {
  if (level === 'off') return write;
  const text = (v: string) => storedText(level, v).text;
  return {
    ...write,
    reason: text(write.reason),
    spec: write.spec === undefined ? undefined : storedDeep(level, write.spec),
    tldr: write.tldr == null ? write.tldr : text(write.tldr),
    changeSummary: write.changeSummary == null ? write.changeSummary : text(write.changeSummary),
    criteria: write.criteria.map((c) => ({ ...c, body: text(c.body) })),
  };
}

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
    .map((c) => ({ id: c.id, code: c.code, body: c.body, form: c.form as CriterionForm }));
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
    await tx
      .insert(requirementCriteria)
      .values(insert.map((c) => ({ ...c, requirementId, sinceRevision: revision })));
  }
  return null;
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

/** REQ-n at revision 1 (draft), numbered max+1 under that lock. */
export async function createRequirementIn(
  tx: Tx,
  input: {
    projectId: string;
    actor: RequirementActor;
    title: string;
    write: RevisionWrite;
    ownerId?: string | null;
    /** Who wrote revision 1's content when not the actor: an accepted suggestion's producer. */
    authorId?: string | undefined;
    /** The designs it is drawn with from the start; the next agree pins their approved revisions. */
    designs?: readonly string[] | undefined;
  },
): Promise<{ id: string; refusals: RequirementRefusal[] | null }> {
  const { projectId, actor } = input;
  const level = await dataPolicyOf(projectId);
  const write = storedWrite(level, input.write);
  const [{ next } = { next: 1 }] = await tx
    .select({ next: sql<number>`coalesce(max(${requirements.reqSeq}), 0)::int + 1` })
    .from(requirements)
    .where(eq(requirements.projectId, projectId));
  const [row] = await tx
    .insert(requirements)
    .values({
      projectId,
      reqSeq: next,
      title: storedText(level, input.title.trim()).text,
      ownerId: input.ownerId === undefined ? actor.userId : input.ownerId,
    })
    .returning({ id: requirements.id });
  if (!row) throw new Error('requirements: the insert returned no row');
  await tx.insert(requirementRevisions).values({
    requirementId: row.id,
    revision: 1,
    spec: specOf(write.spec),
    tldr: write.tldr ?? null,
    changeSummary: write.changeSummary ?? null,
    reason: write.reason.trim(),
    authorId: input.authorId ?? actor.userId,
    fromSuggestionId: write.fromSuggestionId ?? null,
  });
  if (input.designs?.length) {
    await tx.insert(requirementWorkflows).values(
      input.designs.map((workflowId) => ({
        requirementId: row.id,
        workflowId,
        linkedBy: actor.userId,
      })),
    );
  }
  return { id: row.id, refusals: await writeCriteria(tx, row.id, 1, write.criteria) };
}

/** A new draft revision on the head: refused while another is open, or when `baseRevision` moved. */
export async function newDraftRevisionIn(
  tx: Tx,
  input: {
    requirementId: string;
    head: number | null;
    baseRevision: number | null;
    actor: RequirementActor;
    write: RevisionWrite;
  },
): Promise<RequirementRefusal[] | null> {
  const { requirementId } = input;
  const [owner] = await tx
    .select({ projectId: requirements.projectId })
    .from(requirements)
    .where(eq(requirements.id, requirementId));
  if (!owner) throw new Error(`requirements: ${requirementId} has no row`);
  const write = storedWrite(await dataPolicyOf(owner.projectId), input.write);
  const refusal =
    openRevisionRefusal(await openRevisionOf(tx, requirementId)) ??
    staleBaseRefusal(input.baseRevision, input.head);
  if (refusal) return [refusal];
  const [{ next } = { next: 1 }] = await tx
    .select({ next: sql<number>`coalesce(max(${requirementRevisions.revision}), 0)::int + 1` })
    .from(requirementRevisions)
    .where(eq(requirementRevisions.requirementId, requirementId));
  await tx.insert(requirementRevisions).values({
    requirementId,
    revision: next,
    baseRevision: input.head,
    authorId: input.actor.userId,
    spec: specOf(write.spec),
    tldr: write.tldr ?? null,
    changeSummary: write.changeSummary ?? null,
    reason: write.reason.trim(),
    fromSuggestionId: write.fromSuggestionId ?? null,
  });
  return writeCriteria(tx, requirementId, next, write.criteria);
}

/** The open (draft or proposed) revision of a requirement, if any. */
async function openRevisionOf(tx: Tx, requirementId: string) {
  const [open] = await tx
    .select({ revision: requirementRevisions.revision, state: requirementRevisions.state })
    .from(requirementRevisions)
    .where(
      and(
        eq(requirementRevisions.requirementId, requirementId),
        inArray(requirementRevisions.state, ['draft', 'proposed']),
      ),
    );
  return open ? { revision: open.revision, state: open.state as RevisionState } : null;
}
